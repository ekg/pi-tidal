#!/usr/bin/env node
// job-runner.mjs — audition job executor for `audition-ctl submit`.
//
// Runs one job on the AUDITION stack only: it loads the scene into the
// audition Tidal REPL at the declared/overridden cps with its local orbits
// remapped into the physical block `slot * K + local` (K=6, exactly what scene
// mode does live), measures the master bus + the slot's scene channel bus with
// sc/audition/metrics.scd, and writes the frozen report schema to
// sc/audition/reports/<id>.json. It never touches the live stack.
//
// It is launched detached by `audition-ctl submit <scene>`. Stdout/stderr go to
// sc/audition/run/job-<id>.log.
//
// Transport: the audition sclang is launched with its stdin on a FIFO
// (sc/audition/run/sclang.in). SC code is written to a file and submitted as
// one physical line, `this.executeFile(...)` — the same idiom the live plugin
// uses (lib/sclang-command.mjs), needed because sclang's readline evaluates one
// line at a time. SC never needs to reply on stdout: it writes the metric JSON
// to a file the runner polls. The Tidal REPL is fed through its existing FIFO.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseScene, patternExpression } from './scene-format.mjs';

const id = process.argv[2];
if (!id) { console.error('usage: job-runner.mjs <id>'); process.exit(2); }

const AUD = process.env.PI_TIDAL_AUDITION_DIR || '/home/erik/livecode/sc/audition';
const JOBS = path.join(AUD, 'jobs');
const REPORTS = path.join(AUD, 'reports');
const RUN = path.join(AUD, 'run');
const REPL_FIFO = process.env.PI_TIDAL_AUDITION_REPL_FIFO || path.join(RUN, 'repl.in');
const SCLANG_FIFO = process.env.PI_TIDAL_AUDITION_SCLANG_FIFO || path.join(RUN, 'sclang.in');
const REPL_OUT = process.env.PI_TIDAL_AUDITION_REPL_OUT || path.join(RUN, 'repl.out');
const SCENE_RUNTIME = process.env.PI_TIDAL_AUDITION_SCENE_RUNTIME || '/home/erik/pi-tidal/sc/scenes.scd';
const CHANNELS = Number(process.env.PI_TIDAL_AUDITION_CHANNELS || 4);
const ORBITS = Number(process.env.PI_TIDAL_AUDITION_ORBITS || 6);
const SCSYNTH_PORT = Number(process.env.PI_TIDAL_AUDITION_SCSYNTH_PORT || 57111);
const SUPERDIRT_PORT = Number(process.env.PI_TIDAL_AUDITION_SUPERDIRT_PORT || 57121);

const JOB_PATH = path.join(JOBS, `${id}.json`);
const REPORT_PATH = path.join(REPORTS, `${id}.json`);
const METRICS_PATH = path.join(RUN, `${id}.metrics.json`);
const METRICS_ERR = path.join(RUN, `${id}.metrics.error`);
const READY_PATH = path.join(RUN, `${id}.ready`);
const LOCK = path.join(RUN, 'job.lock');
let lockHeld = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIso = ms => new Date(ms).toISOString();
const letterFor = slot => String.fromCharCode(65 + slot);
const bandKeys = ['sub', 'bass', 'lowmid', 'mid', 'highmid', 'top'];

function log(...a) { console.log(new Date().toISOString(), ...a); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// ---- stack liveness / FIFO transport --------------------------------------
function portListening(port) {
  try {
    const out = execFileSync('ss', ['-Huln'], { encoding: 'utf8' });
    return out.split('\n').some(l => l.split(/\s+/).some(f => f.endsWith(`:${port}`)));
  } catch { return false; }
}
function fifoWritable(fifo) {
  try {
    const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.closeSync(fd);
    return true;
  } catch { return false; }
}
function fifoSend(fifo, text) {
  const fd = fs.openSync(fifo, 'w');
  try { fs.writeSync(fd, text.endsWith('\n') ? text : text + '\n'); }
  finally { fs.closeSync(fd); }
}
function sendSclang(source, label) {
  const file = path.join(RUN, `${id}-${label}.scd`);
  fs.writeFileSync(file, source + '\n');
  const q = JSON.stringify(file);
  // One physical line: sclang's readline evaluates line by line. The handler is
  // deliberately empty — SC's protect calls it with nil in some paths, and the
  // runner learns success/failure from the ready/metrics files instead.
  fifoSend(SCLANG_FIFO, `${JSON.stringify(`audition-job ${id}`)}.postln; protect { this.executeFile(${q}) } { |e| ("audition-job ${id} sc error: " ++ e.asString).postln };\n`);
}

// The Tidal REPL's redirected stdout is block-buffered, so output can lag by
// seconds. Loading therefore acknowledges via a FILE the REPL writes on
// success; stdout is only read afterwards, best-effort, for an error message.
const REPL_ERROR_RE = /(error:|not in scope|Variable not in scope|parse error|Couldn't match|No instance for|Ambiguous type|\*\*\* Exception)/i;
function replExcerpt(fromByte, maxLines = 4) {
  let text = '';
  try { text = fs.readFileSync(REPL_OUT, 'utf8').slice(fromByte); } catch { return ''; }
  return text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, maxLines).join(' ');
}

// ---- metrics -> report ----------------------------------------------------
function shares(values) {
  const total = values.reduce((a, b) => a + b, 0);
  return values.map(v => total > 1e-9 ? v / total : 0);
}
function bandsObject(values) {
  const s = shares(values);
  return Object.fromEntries(bandKeys.map((k, i) => [k, Number(s[i].toFixed(6))]));
}
function headroomDb(peak) { return Number((-20 * Math.log10(Math.max(peak, 1e-6))).toFixed(2)); }

// Krumhansl-Schmuckler key estimate from a 12-bin chroma vector. Index 0 = C.
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function correlate(chroma, profile, rotation) {
  const mean = chroma.reduce((a, b) => a + b, 0) / 12;
  const pMean = profile.reduce((a, b) => a + b, 0) / 12;
  let num = 0, d1 = 0, d2 = 0;
  for (let i = 0; i < 12; i++) {
    // profile[0] is the tonic, so it lands at chroma index `rotation`.
    const p = profile[((i - rotation) % 12 + 12) % 12] - pMean;
    const c = chroma[i] - mean;
    num += c * p; d1 += c * c; d2 += p * p;
  }
  return d1 > 1e-12 && d2 > 1e-12 ? num / Math.sqrt(d1 * d2) : 0;
}
function keyFromChroma(chroma) {
  const total = chroma.reduce((a, b) => a + b, 0);
  if (!(total > 1e-9)) return null; // silent render: no key
  let best = { score: -Infinity, key: null };
  for (let r = 0; r < 12; r++) {
    const maj = correlate(chroma, MAJOR_PROFILE, r);
    const min = correlate(chroma, MINOR_PROFILE, r);
    if (maj > best.score) best = { score: maj, key: `${SHARP_NAMES[r]} major` };
    if (min > best.score) best = { score: min, key: `${SHARP_NAMES[r]} minor` };
  }
  return best.key;
}

function sourceByName(metrics, name) {
  return (metrics?.sources ?? []).find(s => s.name === name) ?? null;
}

function deckFromSource(src, slot) {
  return {
    slot,
    letter: letterFor(slot),
    rms: Number(src.rms.toFixed(6)),
    peak: Number(src.peak.toFixed(6)),
    headroomDb: headroomDb(src.peak),
    dominantHz: Math.round(src.dominantHz),
    bands: bandsObject(src.bands),
    chroma: shares(src.chroma).map(v => Number(v.toFixed(6))),
    key: keyFromChroma(src.chroma),
    dissonance: Number(src.dissonance.toFixed(4)),
  };
}

// ---- report skeleton ------------------------------------------------------
function baseReport(job, startedMs) {
  const zeroBands = Object.fromEntries(bandKeys.map(k => [k, 0]));
  return {
    id: job.id, ok: false, error: null, state: 'failed',
    startedMs, finishedMs: 0,
    cps: job.cps, slot: job.slot, renderCycles: job.renderCycles, withLive: job.withLive,
    master: { peak: 0, rms: 0, headroomDb: 0 },
    bands: zeroBands,
    dominantHz: 0,
    chroma: new Array(12).fill(0), key: null, dissonance: 0,
    decks: [],
    diffVsLive: { available: false, note: 'no live snapshot at sc/audition/reports/live.json', bands: zeroBands, dominantHzDelta: 0, keyClash: false },
  };
}

function setJobState(state) {
  const job = readJson(JOB_PATH);
  if (job) { job.state = state; writeJson(JOB_PATH, job); }
}

// The audition stack is a single sclang + REPL with global meter state, so two
// renders must not overlap. A directory is an atomic mutex across processes.
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function acquireLock(timeoutMs = 300000) {
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid));
      lockHeld = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = NaN;
      try { pid = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8').trim()); } catch { /* no pid yet */ }
      if (Number.isFinite(pid) && pid > 1 && !pidAlive(pid)) {
        try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* raced */ }
        continue;
      }
      if (Date.now() - start > timeoutMs) throw Error('another audition job is still running (job lock held)');
      await sleep(1000);
    }
  }
}
function releaseLock() {
  if (!lockHeld) return;
  try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* already gone */ }
  lockHeld = false;
}

function finish(report, exitCode = 0) {
  report.finishedMs = Date.now();
  writeJson(REPORT_PATH, report);
  if (report.state !== 'running') setJobState(report.state);
  log(`report ${report.state} ok=${report.ok}${report.error ? ' error=' + report.error : ''}`);
  releaseLock();
  process.exit(exitCode);
}

function diffVsLive(report, ownKey) {
  const live = readJson(path.join(REPORTS, 'live.json'));
  if (!live) {
    report.diffVsLive = {
      available: false,
      note: 'no live snapshot at sc/audition/reports/live.json (lane 4 snapshotLive not taken)',
      bands: Object.fromEntries(bandKeys.map(k => [k, 0])),
      dominantHzDelta: 0,
      keyClash: false,
    };
    return;
  }
  const liveMaster = live.master ?? live;
  const liveBands = liveMaster.bands ?? null;
  // Only claim a comparison when the snapshot carries comparable 6-band
  // readings. A 3-way low/mid/high deck scan is NOT enough: reporting
  // available:true with all-zero deltas looks like data and is not.
  const haveBands = liveBands != null && bandKeys.every(k => Number.isFinite(liveBands[k]));
  if (!haveBands) {
    report.diffVsLive = {
      available: false,
      note: 'live snapshot lacks 6-band master.bands (snapshotLive must emit sub..top); delta not computed',
      bands: Object.fromEntries(bandKeys.map(k => [k, 0])),
      dominantHzDelta: 0,
      keyClash: false,
    };
    return;
  }
  const liveDom = Number.isFinite(liveMaster.dominantHz) ? liveMaster.dominantHz : null;
  const liveKey = liveMaster.key ?? live.key ?? null;
  const bands = Object.fromEntries(bandKeys.map(k => [
    k, Number((report.bands[k] - liveBands[k]).toFixed(6)),
  ]));
  report.diffVsLive = {
    available: true,
    note: 'delta = audition - live, master bands (share of total)'
      + (liveKey ? '' : '; live key not measured, keyClash unavailable'),
    bands,
    dominantHzDelta: liveDom === null ? 0 : Math.round(report.dominantHz - liveDom),
    keyClash: Boolean(ownKey && liveKey && ownKey !== liveKey),
  };
}

// ---- main -----------------------------------------------------------------
async function main() {
  const startedMs = Date.now();
  const job = readJson(JOB_PATH);
  if (!job) { console.error(`job-runner: unknown job ${id}`); process.exit(2); }
  log(`job ${id} scene=${job.scene} slot=${job.slot} cps=${job.cps} cycles=${job.renderCycles} withLive=${job.withLive}`);

  const report = baseReport(job, startedMs);

  if (job.withLive) {
    report.error = 'withLive:true is not implemented by the audition stack yet (isolated render only)';
    return finish(report);
  }
  if (!(job.slot >= 0 && job.slot < CHANNELS)) {
    report.error = `slot ${job.slot} is outside the configured ${CHANNELS} scene channels`;
    return finish(report);
  }

  // Parse + validate the scene before spending any render time on it.
  let text;
  try { text = fs.readFileSync(job.scene, 'utf8'); }
  catch (e) { report.error = `cannot read scene: ${e.message}`; return finish(report); }
  let scene;
  try { scene = parseScene(text, ORBITS); }
  catch (e) { report.error = `invalid scene: ${e.message}`; return finish(report); }

  if (!portListening(SCSYNTH_PORT) || !portListening(SUPERDIRT_PORT) || !fifoWritable(SCLANG_FIFO) || !fifoWritable(REPL_FIFO)) {
    report.error = `audition stack is not running (scsynth ${SCSYNTH_PORT} / superdirt ${SUPERDIRT_PORT}) — run 'audition-ctl start'`;
    return finish(report);
  }

  const seconds = job.renderCycles / job.cps;
  await acquireLock();
  setJobState('running');

  for (const f of [METRICS_PATH, METRICS_ERR, READY_PATH]) { try { fs.rmSync(f); } catch { /* absent */ } }

  // 1) audition sclang: install the scene runtime (creates the channel buses),
  //    start the meters on master + this slot's channel bus.
  const startScript = `(
var root = ${JSON.stringify(AUD)};
var ready = ${JSON.stringify(READY_PATH)};
try {
	this.executeFile(root ++ "/metrics.scd");
	if(~piSceneManager.isNil or: { ~piSceneManager[\\installed].not }) {
		this.executeFile(${JSON.stringify(SCENE_RUNTIME)});
		~piSceneAPI[\\install].value("audition-install", ${CHANNELS}, ${ORBITS});
	};
} { |err|
	File.use(ready, "w", { |f| f.write("error " ++ err.asString) });
};
Routine({
	try {
		var deadline = Main.elapsedTime + 30;
		var indices;
		while { (~piSceneManager.notNil and: { ~piSceneManager[\\installed].not }) and: { Main.elapsedTime < deadline } } { 0.1.wait };
		if(~piSceneManager.isNil or: { ~piSceneManager[\\installed].not }) { Error("scene runtime install timed out").throw };
		if(~piSceneManager[\\buses][${job.slot}].isNil) { Error("no scene channel bus for slot ${job.slot}").throw };
		indices = [~masterBus.index, ~piSceneManager[\\buses][${job.slot}].index];
		~auditionMeterStart.value(["master", "ch${job.slot}"], indices, 1.5, 0.25);
		File.use(ready, "w", { |f| f.write("ready") });
	} { |err|
		File.use(ready, "w", { |f| f.write("error " ++ err.asString) });
	};
}).play(SystemClock);
)`;
  sendSclang(startScript, 'start');

  // 2) wait for the meters (or the SC error).
  let readyText = null;
  for (let i = 0; i < 120; i++) {
    try { readyText = fs.readFileSync(READY_PATH, 'utf8'); break; } catch { /* not yet */ }
    await sleep(500);
  }
  if (readyText === null) { report.error = 'audition meters did not start (timeout)'; return finish(report); }
  if (!readyText.startsWith('ready')) {
    report.error = `audition metrics failed: ${readyText.trim()}`;
    return finish(report);
  }

  // 3) audition Tidal REPL: set the tempo, then load the scene with remapped
  //    orbits. Success is acknowledged by the REPL writing a done file, so
  //    detection does not depend on ghci's block-buffered stdout. A compile
  //    failure means the `writeFile` in the same IO action never runs.
  const expr = patternExpression(scene, job.slot, ORBITS);
  const donePath = path.join(RUN, `${id}.tidal.done`);
  try { fs.rmSync(donePath); } catch { /* absent */ }
  let replBefore = 0;
  try { replBefore = fs.statSync(REPL_OUT).size; } catch { /* none yet */ }
  fifoSend(REPL_FIFO, `setcps ${job.cps}`);
  fifoSend(REPL_FIFO, `(p "audition" $ ${expr}) >> writeFile ${JSON.stringify(donePath)} "ok"`);
  let loaded = false;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(donePath)) { loaded = true; break; }
    fifoSend(REPL_FIFO, ''); // poke: nudge ghci to flush any error text
    await sleep(500);
  }
  if (!loaded) {
    const detail = replExcerpt(replBefore);
    sendSclang('(~auditionMeterStop.value; "audition job aborted".postln;)', 'abort');
    fifoSend(REPL_FIFO, 'hush');
    report.error = `scene failed to load in Tidal: ${REPL_ERROR_RE.test(detail) ? detail : 'no acknowledgement (timeout)'}`;
    return finish(report);
  }

  // 4) render for the requested cycles, then collect the measurement.
  log(`rendering ${job.renderCycles} cycles @ cps ${job.cps} (~${seconds.toFixed(2)}s)`);
  await sleep((seconds + 2.0) * 1000);
  sendSclang(`(try { ~auditionMeterReport.value(${JSON.stringify(METRICS_PATH)}, ${seconds}) } { |err| File.use(${JSON.stringify(METRICS_ERR)}, "w", { |f| f.write("report failed: " ++ err.asString) }) }; try { ~auditionMeterStop.value } { |err| ("meter stop error: " ++ err.asString).postln };)`, 'collect');

  let metrics = null;
  for (let i = 0; i < 40; i++) {
    metrics = readJson(METRICS_PATH);
    if (metrics) break;
    if (fs.existsSync(METRICS_ERR) && fs.statSync(METRICS_ERR).size > 0) break;
    await sleep(500);
  }
  fifoSend(REPL_FIFO, 'hush');

  if (!metrics) {
    const err = fs.existsSync(METRICS_ERR) && fs.statSync(METRICS_ERR).size > 0
      ? fs.readFileSync(METRICS_ERR, 'utf8').trim()
      : 'timed out';
    report.error = `audition metrics failed: ${err}`;
    return finish(report);
  }

  // 5) compose the frozen report.
  const masterSrc = sourceByName(metrics, 'master');
  const deckSrc = sourceByName(metrics, `ch${job.slot}`);
  if (!masterSrc) { report.error = 'audition metrics missing the master source'; return finish(report); }
  const masterChroma = masterSrc.chroma;
  report.ok = true;
  report.error = null;
  report.state = 'done';
  report.master = {
    peak: Number(masterSrc.peak.toFixed(6)),
    rms: Number(masterSrc.rms.toFixed(6)),
    headroomDb: headroomDb(masterSrc.peak),
  };
  report.bands = bandsObject(masterSrc.bands);
  report.dominantHz = Math.round(masterSrc.dominantHz);
  report.chroma = shares(masterChroma).map(v => Number(v.toFixed(6)));
  report.key = keyFromChroma(masterChroma);
  report.dissonance = Number(masterSrc.dissonance.toFixed(4));
  report.decks = deckSrc ? [deckFromSource(deckSrc, job.slot)] : [];
  diffVsLive(report, report.key);
  return finish(report);
}

main().catch(e => {
  try {
    const job = readJson(JOB_PATH) ?? { id, cps: 0, slot: 0, renderCycles: 0, withLive: false };
    const report = baseReport(job, Date.now());
    report.error = `job runner crashed: ${e.stack || e.message}`;
    finish(report, 1);
  } catch (e2) {
    console.error('job-runner fatal:', e2);
    process.exit(1);
  }
});
