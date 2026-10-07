// Pure helpers over tools/stream/stream-ctl — argv building and output parsing.
// No side effects at import: nothing spawns, nothing touches the filesystem; the
// extension owns execution. Frozen interface: docs/stream-audition.md.

export const STREAM_ACTIONS = Object.freeze(["start", "stop", "status", "url", "enable", "disable"]);

// The six frozen `status` lines the contract requires to be parseable, plus the
// two extra lines the CLI happens to print. Keys are the literal line labels.
const STATUS_LINE_FIELDS = Object.freeze({
  "sink": "sink",
  "source linked": "sourceLinked",
  "listeners": "listeners",
  "frames/sec": "framesPerSec",
  "dropped": "dropped",
  "source": "source",
  "daemon": "daemon",
  "enabled": "enabled",
});

export function buildStreamArgs(action) {
  if (!STREAM_ACTIONS.includes(action)) throw new Error(`unknown stream action: ${action}`);
  return [action];
}

// The six contract fields are always keys on the result (null when absent) so a
// caller never has to guard for a missing line; daemon/enabled are extras.
export function parseStreamStatus(text = "") {
  const status = {
    sink: null,
    sourceLinked: null,
    listeners: null,
    framesPerSec: null,
    dropped: null,
    source: null,
    daemon: null,
    enabled: null,
  };
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = STATUS_LINE_FIELDS[line.slice(0, colon).trim()];
    if (!field) continue;
    const value = line.slice(colon + 1).trim();
    if (field === "sink" || field === "source" || field === "daemon") status[field] = value || null;
    else if (field === "sourceLinked") status[field] = value === "yes" ? true : value === "no" ? false : null;
    else if (field === "enabled") status[field] = value === "true" ? true : value === "false" ? false : null;
    else status[field] = value === "" || Number.isNaN(Number(value)) ? null : Number(value);
  }
  return status;
}

// `url` prints the direct WS URL first, then (when in a tailnet) a best-effort
// `tailscale:` block: hostname, a direct ws:// URL, and the `serve` command.
export function parseStreamUrl(text = "") {
  const result = { url: null, tailscale: null };
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const hostname = /^tailscale:\s*(\S+)/.exec(line);
    if (hostname) {
      result.tailscale = { hostname: hostname[1], direct: null, serve: null };
      continue;
    }
    if (result.tailscale) {
      const direct = /^direct:\s*(\S+)/.exec(line);
      if (direct) { result.tailscale.direct = direct[1]; continue; }
      const serve = /^serve:\s*(.+)$/.exec(line);
      if (serve) { result.tailscale.serve = serve[1].trim(); continue; }
    }
    if (result.url === null && /^ws:\/\//.test(line)) result.url = line;
  }
  return result;
}
