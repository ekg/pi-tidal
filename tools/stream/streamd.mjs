#!/usr/bin/env node
// streamd — low-latency audio stream daemon (lane 1; fan-out refactor).
//
// SOURCE: one `pw-record --target <sink> -` capture (raw s16le stereo PCM),
// sliced into fixed 20 ms frames.
// SINKS: N pluggable OUTPUTS, each independently enabled in config and
// togglable at runtime over POST /control. Every output receives the same
// frames; an output that falls behind affects only its own consumers.
//
//   pw-record --> [ frame ] --> ws-pcm   (this file; always the low-latency path)
//                         \--> icecast  (lane 5: ffmpeg -> external icecast)
//                          \-> hls      (lane 5: ffmpeg -> segments on /hls/)
//                          \-> ws-opus  (lane 5: ffmpeg -> WS, WebCodecs)
//
// Frame framing (frozen in docs/stream-audition.md):
//   offset 0  uint32   seq      (LE, wraps at 2^32)
//   offset 4  float64  sentMs   (LE, server Date.now() at read)
//   offset 12 uint8    flags    bit0 = discontinuity
//   offset 13 ...      payload  s16le stereo, frameMs worth of samples
//
// No npm dependencies: the WebSocket server is implemented over node's built-in
// http + crypto (RFC6455). Server->client frames are unmasked binary; the only
// client->server traffic is WS control frames plus an optional 1-byte ping
// which is answered with a 5-byte control frame [0x01, uint32 seq LE].
//
// Anti-drift (ws-pcm only): each connection holds at most 2 frames,
// drop-oldest. A slow reader loses audio; it never accumulates latency. The
// capture itself is NEVER dropped — only the per-output queue is bounded.
//
// Watchdog: if pw-record yields no bytes for > 500 ms the capture is killed and
// restarted, and the next emitted frame sets flags bit0 (discontinuity). The
// daemon never exits when the source is down; it reports source: down.

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createIcecastOutput, icecastDefaults } from './outputs/icecast.mjs';
import { createHlsOutput, hlsDefaults } from './outputs/hls.mjs';
import { createWsOpusOutput, wsOpusDefaults } from './outputs/ws-opus.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- logging ---------------------------------------------------------------
function log(...a) {
  process.stdout.write(`[streamd ${new Date().toISOString()}] ${a.join(' ')}\n`);
}

// --- config (~/.config/tidal-stream/config.json, PI_TIDAL_STREAM_* env) -----
const DEFAULTS = {
  enabled: false,
  bind: '0.0.0.0',
  port: 8787,
  token: '',
  format: 's16',
  rate: 48000,
  channels: 2,
  frameMs: 20,
  // Client-side target floor (ms): the dominant latency term. The player reads
  // this from /status; lower = tighter latency, more underrun risk. The page's
  // profile control can override it live without touching this.
  fillFloorMs: 60,
  sink: 'tidal_stream',
  sourceNode: 'tidal_stream',
  // Per-output state. Missing entry => the output's own default. ws-pcm is on
  // by default so behaviour matches pre-refactor streamd; everything else is
  // opt-in. bind/port/token above remain ws-pcm's (and the control/status
  // server's) settings, kept at top level for backward compatibility.
  outputs: {},
};

const CONFIG_PATH =
  process.env.PI_TIDAL_STREAM_CONFIG ||
  path.join(os.homedir(), '.config', 'tidal-stream', 'config.json');

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') log(`config read error (${CONFIG_PATH}): ${e.message}`);
    return {};
  }
}

function loadConfig() {
  const cfg = { ...DEFAULTS, outputs: {} };
  const file = readConfigFile();
  Object.assign(cfg, file);
  cfg.outputs = { ...(file.outputs || {}) };
  const env = (k) => process.env[`PI_TIDAL_STREAM_${k}`];
  const num = (k, cur) => {
    const v = env(k);
    return v === undefined || v === '' ? cur : Number(v);
  };
  const str = (k, cur) => {
    const v = env(k);
    return v === undefined ? cur : v;
  };
  cfg.bind = str('BIND', cfg.bind);
  cfg.port = num('PORT', cfg.port);
  cfg.token = str('TOKEN', cfg.token);
  cfg.format = str('FORMAT', cfg.format);
  cfg.rate = num('RATE', cfg.rate);
  cfg.channels = num('CHANNELS', cfg.channels);
  cfg.frameMs = num('FRAMEMS', cfg.frameMs);
  cfg.fillFloorMs = num('FILLFLOORMS', cfg.fillFloorMs);
  cfg.sink = str('SINK', cfg.sink);
  cfg.sourceNode = str('SOURCENODE', cfg.sourceNode);
  return cfg;
}

const cfg = loadConfig();
const RATE = Number(cfg.rate);
const CHANNELS = Number(cfg.channels);
const FRAME_MS = Number(cfg.frameMs);
const SAMPLES_PER_CH = Math.round((RATE * FRAME_MS) / 1000);
const FRAME_BYTES = SAMPLES_PER_CH * CHANNELS * 2; // s16 => 2 bytes/sample
const PORT = Number(cfg.port);
const BIND = cfg.bind;
const TOKEN = cfg.token || '';
const SINK = cfg.sink;

// Persist the runtime output state, preserving every other key in the file.
function persistOutputEnabled(name, enabled) {
  const file = readConfigFile();
  file.outputs = { ...(file.outputs || {}) };
  file.outputs[name] = { ...(file.outputs[name] || {}), enabled };
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + '\n');
    return true;
  } catch (e) {
    log(`could not persist output state to ${CONFIG_PATH}: ${e.message}`);
    return false;
  }
}

// --- source-level state ----------------------------------------------------
let seq = 0;
let pendingDiscontinuity = false;
let frameCounter = 0; // frames emitted since last fps window
let fpsWindowStart = Date.now();
let framesPerSec = 0;

// --- output registry -------------------------------------------------------
// An output is a plain object:
//   name                      stable id, also the config key
//   settings                  merged config for this output
//   active                    true while started
//   start() / stop()          idempotent; must not throw
//   onFrame(msg)              called once per emitted frame while active
//   handleHttp(url, req, res) return true when the route was handled
//   handleUpgrade(url, req, socket) return true when the upgrade was handled
//   status()                  {name, enabled, active, ...extras}
const outputs = new Map();

function registerOutput(out) {
  outputs.set(out.name, out);
  return out;
}

function outputSettings(name, defaults = {}) {
  return { enabled: true, ...defaults, ...(cfg.outputs?.[name] || {}) };
}

function activeOutputs() {
  const list = [];
  for (const out of outputs.values()) if (out.active) list.push(out);
  return list;
}

function enabledOutputNames() {
  return [...outputs.values()].filter((o) => o.active).map((o) => o.name);
}

// --- capture ---------------------------------------------------------------
//
// On this PipeWire/WirePlumber setup `pw-record --target <sink>` alone links
// the capture stream to the *default source* (the mic), not to the sink
// monitor. The `stream.capture.sink=true` property makes WirePlumber link the
// record stream to the named sink's monitor ports instead. We additionally
// wait for the sink node to exist before spawning, and re-verify the linkage
// (restarting capture if it drifted), so we never silently stream the mic.
let capture = null;
let captureRestartTimer = null;
let lastByteAt = 0;
let captureStartAt = 0;
let waitingForSink = false;
let verifying = false;

async function dumpObjects() {
  const { stdout } = await execFileP('pw-dump', { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function sinkMonitorPortIds(objs) {
  const sink = objs
    .filter((o) => o.type === 'PipeWire:Interface:Node')
    .find((n) => n.info?.props?.['node.name'] === SINK);
  if (!sink) return { sink: null, ports: [] };
  const ports = objs
    .filter((o) => o.type === 'PipeWire:Interface:Port')
    .filter(
      (p) => p.info?.props?.['node.id'] === sink.id && p.info?.props?.['port.direction'] === 'out',
    )
    .map((p) => p.id);
  return { sink, ports };
}

async function sinkPresent() {
  try {
    const { sink } = sinkMonitorPortIds(await dumpObjects());
    return !!sink;
  } catch (e) {
    log(`pw-dump failed: ${e.message}`);
    return false;
  }
}

async function captureLinkedToSink() {
  try {
    const objs = await dumpObjects();
    const { sink, ports } = sinkMonitorPortIds(objs);
    if (!sink) return false;
    const monitor = new Set(ports);
    if (monitor.size === 0) return false;
    return objs
      .filter((o) => o.type === 'PipeWire:Interface:Link')
      .some((l) => monitor.has(l.info?.['output-port-id']));
  } catch {
    return false;
  }
}

function scheduleCapture(delayMs, reason) {
  pendingDiscontinuity = true;
  if (captureRestartTimer) return;
  log(`scheduling capture start in ${delayMs}ms (${reason})`);
  captureRestartTimer = setTimeout(() => {
    captureRestartTimer = null;
    startCaptureOnce();
  }, delayMs);
}

function killCapture() {
  if (capture && !capture.killed) {
    try {
      capture.kill('SIGKILL');
    } catch {}
  }
  capture = null;
}

async function startCaptureOnce() {
  if (capture) return;
  if (!(await sinkPresent())) {
    if (!waitingForSink) {
      log(`sink '${SINK}' not present; waiting (source down)`);
      waitingForSink = true;
    }
    pendingDiscontinuity = true;
    scheduleCapture(500, 'sink absent');
    return;
  }
  waitingForSink = false;
  spawnCapture();
}

function spawnCapture() {
  const args = [
    '--target', SINK,
    '--format', cfg.format,
    '--rate', String(RATE),
    '--channels', String(CHANNELS),
    '-P', '{"stream.capture.sink":true}',
    '-',
  ];
  log(`starting capture: pw-record ${args.join(' ')}`);
  let child;
  try {
    child = spawn('pw-record', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log(`spawn pw-record failed: ${e.message}`);
    scheduleCapture(1000, 'spawn failed');
    return;
  }
  capture = child;
  captureStartAt = Date.now();
  let acc = Buffer.alloc(0);
  lastByteAt = Date.now();

  child.stdout.on('data', (chunk) => {
    lastByteAt = Date.now();
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
    while (acc.length >= FRAME_BYTES) {
      const payload = acc.subarray(0, FRAME_BYTES);
      acc = acc.subarray(FRAME_BYTES);
      emitFrame(payload);
    }
  });
  child.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) log(`pw-record: ${s}`);
  });
  child.on('error', (e) => log(`pw-record error: ${e.message}`));
  child.on('exit', (code, sig) => {
    log(`pw-record exited code=${code} sig=${sig}`);
    if (capture === child) capture = null;
    scheduleCapture(1000, 'pw-record exit');
  });
}

async function verifyCaptureLinkage() {
  if (!capture || verifying) return;
  if (Date.now() - captureStartAt < 1000) return; // allow link to settle
  verifying = true;
  const ok = await captureLinkedToSink();
  verifying = false;
  if (!ok && capture) {
    log(`capture is not linked to sink '${SINK}' monitor; restarting capture`);
    scheduleCapture(250, 'unlinked capture');
    killCapture();
  }
}

// Build ONE frame and hand the same buffer to every active output. The source
// is never dropped; per-output queueing is each output's own business.
function emitFrame(payload) {
  seq = (seq + 1) >>> 0;
  const flags = pendingDiscontinuity ? 1 : 0;
  pendingDiscontinuity = false;

  const msg = Buffer.allocUnsafe(13 + payload.length);
  msg.writeUInt32LE(seq, 0);
  msg.writeDoubleLE(Date.now(), 4);
  msg.writeUInt8(flags, 12);
  payload.copy(msg, 13);

  frameCounter++;
  for (const out of outputs.values()) {
    if (!out.active) continue;
    try {
      out.onFrame(msg);
    } catch (e) {
      log(`output '${out.name}' onFrame threw: ${e.message}`);
    }
  }
}

// watchdog: no bytes for > 500 ms while a capture process is alive
setInterval(() => {
  const now = Date.now();
  if (capture && now - lastByteAt > 500) {
    log(`watchdog: no pw-record bytes for ${now - lastByteAt}ms`);
    scheduleCapture(250, 'watchdog');
    killCapture();
  }
  if (now - fpsWindowStart >= 1000) {
    const elapsed = now - fpsWindowStart;
    framesPerSec = Math.round((frameCounter * 1000) / elapsed);
    frameCounter = 0;
    fpsWindowStart = now;
  }
}, 200).unref();

// periodically confirm the capture is bound to our sink monitor, not the mic
setInterval(() => {
  verifyCaptureLinkage();
}, 2000).unref();

// ===========================================================================
// OUTPUT: ws-pcm — the low-latency WebSocket/PCM path (the built-in one).
// Owns its connections and the bounded drop-oldest queue. Serves the player
// page on `/`.
// ===========================================================================
function createWsPcmOutput() {
  const settings = outputSettings('ws-pcm', {});
  const connections = new Set();
  let droppedTotal = 0;

  function wsEncode(payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x82;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x82;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x82;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  function closeConn(conn) {
    if (conn.closed) return;
    conn.closed = true;
    connections.delete(conn);
    try {
      conn.socket.destroy();
    } catch {}
  }

  function pump(conn) {
    if (conn.writing || conn.closed) return;
    const msg = conn.queue.shift();
    if (!msg) return;
    conn.writing = true;
    try {
      conn.socket.write(wsEncode(msg), () => {
        conn.writing = false;
        pump(conn);
      });
    } catch {
      conn.writing = false;
      closeConn(conn);
    }
  }

  // the core anti-drift rule: at most 2 frames queued, drop-oldest
  function enqueue(conn, msg) {
    conn.queue.push(msg);
    while (conn.queue.length > 2) {
      conn.queue.shift();
      conn.dropped++;
      droppedTotal++;
    }
    pump(conn);
  }

  function sendControl(conn, opcode, payload) {
    const header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = payload.length;
    try {
      conn.socket.write(Buffer.concat([header, payload]));
    } catch {}
  }

  function handleClientFrame(conn, opcode, payload) {
    if (opcode === 0x8) return closeConn(conn);
    if (opcode === 0x9) return sendControl(conn, 0xa, payload); // pong
    if (opcode === 0xa) return;
    // data frame: a 1-byte ping asks for the current seq (explicit resync)
    if (payload.length === 1) {
      const p = Buffer.allocUnsafe(5);
      p.writeUInt8(0x01, 0);
      p.writeUInt32LE(seq, 1);
      sendControl(conn, 0x2, p);
    }
  }

  function onSocketData(conn, chunk) {
    conn.rbuf = conn.rbuf.length ? Buffer.concat([conn.rbuf, chunk]) : chunk;
    for (;;) {
      const b = conn.rbuf;
      if (b.length < 2) break;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (b.length < off + maskLen + len) break;
      let payload;
      if (masked) {
        const mask = b.subarray(off, off + 4);
        payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3];
      } else {
        payload = b.subarray(off, off + len);
      }
      conn.rbuf = b.subarray(off + maskLen + len);
      handleClientFrame(conn, opcode, payload);
      if (conn.closed) break;
    }
  }

  return registerOutput({
    name: 'ws-pcm',
    settings,
    active: false,
    async start() {
      if (this.active) return;
      this.active = true;
      log(`output ws-pcm started (listeners=${connections.size})`);
    },
    async stop() {
      if (!this.active) return;
      for (const conn of [...connections]) closeConn(conn);
      this.active = false;
      log('output ws-pcm stopped (listeners closed)');
    },
    onFrame(msg) {
      for (const conn of connections) enqueue(conn, msg);
    },
    handleHttp(url, req, res) {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/player.html')) {
        try {
          const html = fs.readFileSync(path.join(HERE, 'player.html'));
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(html);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('player.html not found\n');
        }
        return true;
      }
      return false;
    },
    handleUpgrade(url, req, socket) {
      if (url.pathname !== '/') return false;
      if (!this.active) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        return true;
      }
      const key = req.headers['sec-websocket-key'];
      if (!key || req.headers['upgrade']?.toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return true;
      }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      );
      socket.setNoDelay(true);
      const conn = { socket, queue: [], writing: false, closed: false, dropped: 0, rbuf: Buffer.alloc(0) };
      connections.add(conn);
      log(`client connected (listeners=${connections.size})`);

      socket.on('data', (chunk) => onSocketData(conn, chunk));
      socket.on('error', () => closeConn(conn));
      socket.on('close', () => {
        if (!conn.closed) log(`client disconnected (dropped=${conn.dropped})`);
        closeConn(conn);
      });
      return true;
    },
    status() {
      return {
        name: 'ws-pcm',
        enabled: settings.enabled !== false,
        active: this.active,
        listeners: connections.size,
        dropped: droppedTotal,
      };
    },
  });
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

const wsPcm = createWsPcmOutput();

// lane 5 outputs: ffmpeg-backed Icecast push and HLS segments. Both default to
// off (their defaults carry enabled:false), so a disabled output spawns no
// process and costs nothing. Registered here so their /hls/* routes and
// /control toggles are live.
const STREAM = { rate: RATE, channels: CHANNELS };
registerOutput(createIcecastOutput(outputSettings('icecast', icecastDefaults), STREAM));
registerOutput(createHlsOutput(outputSettings('hls', hlsDefaults), STREAM));
// lane 6: Opus over our own WebSocket on /opus (defaults to off; ws-pcm keeps `/`).
registerOutput(createWsOpusOutput(outputSettings('ws-opus', wsOpusDefaults), STREAM));

// ===========================================================================
// HTTP server: shared transport for /status, /control and every output's own
// routes. Outputs attach by returning true from handleHttp/handleUpgrade.
// ===========================================================================
function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function authorized(req, url) {
  if (!TOKEN) return true;
  if (isLoopback(req)) return true;
  return url.searchParams.get('token') === TOKEN;
}

function statusPayload() {
  const now = Date.now();
  const captureAlive = !!capture;
  const sourceUp = captureAlive && now - lastByteAt < 1000;
  return {
    ok: true,
    enabled: !!cfg.enabled,
    bind: BIND,
    port: PORT,
    sink: SINK,
    sourceNode: cfg.sourceNode,
    captureAlive,
    lastByteAgeMs: captureAlive ? now - lastByteAt : null,
    listeners: wsPcm.status().listeners,
    framesPerSec,
    dropped: wsPcm.status().dropped,
    seq,
    frameMs: FRAME_MS,
    fillFloorMs: Number(cfg.fillFloorMs),
    rate: RATE,
    channels: CHANNELS,
    source: sourceUp ? 'up' : 'down',
    outputs: [...outputs.values()].map((o) => o.status()),
    pid: process.pid,
  };
}

async function setOutput(name, action, persist) {
  const out = outputs.get(name);
  if (!out) return { ok: false, error: `unknown output '${name}'`, outputs: [...outputs.keys()] };
  if (action === 'on') {
    out.settings.enabled = true;
    await out.start();
  } else if (action === 'off') {
    out.settings.enabled = false;
    await out.stop();
  } else {
    return { ok: false, error: `unknown action '${action}' (on|off)` };
  }
  if (persist) persistOutputEnabled(name, out.settings.enabled);
  log(`output ${name} ${action} (active=${out.active})`);
  return { ok: true, output: out.status() };
}

function readJsonBody(req, limit = 65536) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/status') {
    if (!authorized(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statusPayload()));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/control') {
    if (!authorized(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    const body = await readJsonBody(req);
    if (!body || !body.output || !body.action) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'expected {"output":"<name>","action":"on|off"}' }));
      return;
    }
    const result = await setOutput(String(body.output), String(body.action), body.persist !== false);
    res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...result, status: statusPayload() }));
    return;
  }

  // outputs' own HTTP routes (hls segments/playlist, …)
  for (const out of outputs.values()) {
    if (typeof out.handleHttp === 'function' && out.handleHttp(url, req, res)) return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found\n');
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  if (!authorized(req, url)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  for (const out of outputs.values()) {
    if (typeof out.handleUpgrade === 'function' && out.handleUpgrade(url, req, socket)) return;
  }
  socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
});

server.on('error', (e) => log(`server error: ${e.message}`));

server.listen(PORT, BIND, async () => {
  log(`listening on ${BIND}:${PORT} (sink=${SINK}, frameBytes=${FRAME_BYTES})`);
  // start the outputs whose config says enabled (ws-pcm defaults to on)
  for (const out of outputs.values()) {
    if (out.settings.enabled !== false) await out.start();
    else log(`output '${out.name}' disabled in config (toggle with POST /control)`);
  }
  log(`outputs active: ${enabledOutputNames().join(', ') || '(none)'}`);
  startCaptureOnce();
});

// --- shutdown --------------------------------------------------------------
async function shutdown(sig) {
  log(`received ${sig}, shutting down`);
  for (const out of outputs.values()) {
    try {
      await out.stop();
    } catch {}
  }
  killCapture();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
