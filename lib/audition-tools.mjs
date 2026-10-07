// Pure helpers over tools/audition/audition-ctl — argv building, output parsing
// and live-snapshot shaping. No side effects at import: the extension owns
// process execution and the live.json write. Frozen interface:
// docs/stream-audition.md (clauses «Audition job / report protocol (frozen v1)»).

import os from "node:os";
import path from "node:path";

// The verbs the plugin shells out to. `snapshotLive` is a plugin-only action
// (parent-approved addition): it evaluates SC in the live sclang, not the CLI.
export const AUDITION_CLI_ACTIONS = Object.freeze(["start", "stop", "status", "submit", "report", "jobs"]);
export const AUDITION_ACTIONS = Object.freeze([...AUDITION_CLI_ACTIONS, "snapshotLive"]);

// `audition-ctl report` exits 3 (and prints {"ok":false,"state":"running"}) while
// the render is still going; that is not an error.
export const AUDITION_STILL_RUNNING_EXIT = 3;

export function buildAuditionArgs(action, params = {}) {
  switch (action) {
    case "start":
    case "stop":
    case "status":
      return [action];
    case "submit": {
      if (!params.scene) throw new Error("audition submit requires a scene path");
      const args = ["submit", String(params.scene)];
      if (params.slot !== undefined && params.slot !== null) args.push("--slot", String(params.slot));
      if (params.cps !== undefined && params.cps !== null) args.push("--cps", String(params.cps));
      if (params.cycles !== undefined && params.cycles !== null) args.push("--cycles", String(params.cycles));
      if (params.withLive) args.push("--with-live");
      return args;
    }
    case "report": {
      if (!params.id) throw new Error("audition report requires an id");
      return ["report", String(params.id)];
    }
    case "jobs": {
      const args = ["jobs"];
      if (params.limit !== undefined && params.limit !== null) args.push("--limit", String(params.limit));
      return args;
    }
    default:
      throw new Error(`unknown audition action: ${action}`);
  }
}

export function isAuditionStillRunning(exitCode) {
  return exitCode === AUDITION_STILL_RUNNING_EXIT;
}

// `submit` prints the job id as a single line on stdout.
export function parseAuditionSubmitId(stdout = "") {
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line) return line;
  }
  return null;
}

// `report` prints the report JSON object. Exit 3 means still running: return a
// running sentinel even if stdout was empty or unparseable, so a caller can tell
// "not done yet" apart from "unknown id" (which exits non-zero, non-3).
export function parseAuditionReport(stdout, { exitCode = 0 } = {}) {
  const text = String(stdout ?? "").trim();
  if (text) {
    try { return JSON.parse(text); } catch { /* fall through to exit-code handling */ }
  }
  if (isAuditionStillRunning(exitCode)) return { ok: false, state: "running", exitCode };
  return null;
}

// `jobs` prints one line per job: <id> <state> <createdISO> <scene>.
export function parseAuditionJobs(text = "") {
  const jobs = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    jobs.push({ id: match[1], state: match[2], createdISO: match[3], scene: match[4] ?? "" });
  }
  return jobs;
}

// `status` prints `label: value` lines (scsynth/superdirt/graph/repl/owned pids).
export function parseAuditionStatus(text = "") {
  const status = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    status[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return status;
}

// --- live snapshot (snapshotLive) ------------------------------------------
// The live snapshot must carry the SAME 6-band split as the audition report, so
// `diffVsLive` is an apples-to-apples comparison (frozen live.json v1). That
// comes from sc/spectrum.scd, already loaded in live via sc/init.scd:
//   ~spectrumStart.value;   -- meters the master + every live scene channel
//   ~spectrumReport.value;  -- prints, per source:
//        "<name(8)>rms <dB(8)>low-end <%(8)>shares a b c d e f"
//      plus a master chain line
//        "master   rms <dB> dB   peak <dB> dB   ceiling-use <x> (<n>)"
// A moment must pass between start and report: the Amplitude.kr followers need
// audio blocks to build up or the report reads zeros.
//
// ~deckScanStart/~orbitScanReport is NOT used for bands — it is a 3-way
// low/mid/high split and cannot yield 6-band deltas (that mismatch shipped in
// v1 and produced available:true with all-zero diffs). It is used ONLY for
// per-channel dominant frequency.

export const SPECTRUM_BAND_KEYS = Object.freeze(["sub", "bass", "lowmid", "mid", "highmid", "top"]);

export function dbToLinear(db) {
  return Number.isFinite(db) ? Number(Math.pow(10, db / 20).toFixed(6)) : 0;
}

// Parse ~spectrumReport output: per-source 6-band shares + the master rms/peak line.
export function parseSpectrumReport(text = "") {
  const sources = [];
  let masterSummary = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const summary = /^master\s+rms\s+(-?[\d.]+)\s+dB\s+peak\s+(-?[\d.]+)\s+dB/.exec(line);
    if (summary) {
      const peakDb = Number(summary[2]);
      masterSummary = { rmsDb: Number(summary[1]), peakDb, headroomDb: Number((-peakDb).toFixed(2)) };
      continue;
    }
    const m = /^(\S+)\s+rms\s+(-?[\d.]+)\s+low-end\s+([\d.]+)%\s+shares\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/.exec(line);
    if (!m) continue;
    const shares = [m[4], m[5], m[6], m[7], m[8], m[9]].map(Number);
    const total = shares.reduce((a, b) => a + b, 0) || 1;
    sources.push({
      name: m[1],
      rmsDb: Number(m[2]),
      lowEndPct: Number(m[3]),
      bands: Object.fromEntries(SPECTRUM_BAND_KEYS.map((k, i) => [k, Number((shares[i] / total).toFixed(6))])),
    });
  }
  return { sources, masterSummary };
}

// `~orbitScanReport` prints one line per source:
// `<name> <rms>dB <dominant>Hz <low>/<mid>/<high>%` — dominant Hz only here.
export function parseOrbitScanReport(text = "") {
  const decks = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^(\S+)\s+(-?\d+)\s*dB\s+(\d+)\s*Hz\s+(\d+)\/(\d+)\/(\d+)$/.exec(line);
    if (!match) continue;
    decks.push({
      name: match[1],
      rmsDb: Number(match[2]),
      dominantHz: Number(match[3]),
      low: Number(match[4]),
      mid: Number(match[5]),
      high: Number(match[6]),
    });
  }
  return decks;
}

// Shape written to sc/audition/reports/live.json (frozen v1). `master.bands` is
// the field lane 3's diffVsLive requires; `ok` is false when no master bands
// could be read, so a caller never compares against a hollow snapshot.
export function buildLiveReport({ spectrum = { sources: [], masterSummary: null }, orbit = [], raw = "", takenMs = Date.now(), floorDb = -58 } = {}) {
  const orbitByName = new Map(orbit.map((d) => [d.name, d]));
  const decks = spectrum.sources.map((s) => ({
    name: s.name,
    rmsDb: s.rmsDb,
    dominantHz: orbitByName.get(s.name)?.dominantHz ?? 0,
    bands: s.bands,
    low: orbitByName.get(s.name)?.low ?? 0,
    mid: orbitByName.get(s.name)?.mid ?? 0,
    high: orbitByName.get(s.name)?.high ?? 0,
  }));
  const masterDeck = decks.find((d) => d.name === "master") ?? null;
  const summary = spectrum.masterSummary;
  const master = masterDeck
    ? {
        bands: masterDeck.bands,
        dominantHz: masterDeck.dominantHz,
        rmsDb: summary ? summary.rmsDb : masterDeck.rmsDb,
        peakDb: summary ? summary.peakDb : 0,
        rms: dbToLinear(summary ? summary.rmsDb : masterDeck.rmsDb),
        peak: summary ? dbToLinear(summary.peakDb) : 0,
        headroomDb: summary ? summary.headroomDb : 0,
      }
    : null;
  return {
    id: "live",
    source: "live",
    ok: decks.length > 0 && master !== null,
    state: "done",
    takenMs,
    takenISO: new Date(takenMs).toISOString(),
    floorDb,
    master,
    decks,
    raw,
  };
}

export function liveSnapshotPath({ env = process.env, homedir = os.homedir() } = {}) {
  const audDir = env.PI_TIDAL_AUDITION_DIR || path.join(homedir, "livecode", "sc", "audition");
  return path.join(audDir, "reports", "live.json");
}
