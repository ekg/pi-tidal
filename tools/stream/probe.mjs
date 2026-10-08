#!/usr/bin/env node
// probe.mjs — client-side probe for the tidal_stream WebSocket output.
//
// Measures what a LISTENER actually experiences, from the listener's machine:
// frame rate, inter-arrival jitter, lost frames, and the transport stalls that
// decide whether the playout buffer will underrun in normal use.
//
//   node probe.mjs [host] [port] [seconds]
//   node probe.mjs puppost.tail334fe6.ts.net 8787 60
//
// Why this exists: `stream-ctl status` reports the SERVER's view (frames/sec,
// listeners, bytes). It cannot tell you whether a remote client will glitch,
// and "the source is pushing bytes" is not evidence a listener can decode or
// keep up. Run this from where you will actually listen.
//
// It replays the observed arrival times through the player's fill policy to
// predict underruns at a given target buffer size. The exposure is the
// transport's tail latency: a 400 ms stall underruns at ANY sane target, since
// you cannot buffer past a stall longer than the buffer without paying that
// latency all the time.

import net from 'node:net';
import crypto from 'node:crypto';

const HOST = process.argv[2] || '127.0.0.1';
const PORT = Number(process.argv[3] || 8787);
const SECS = Number(process.argv[4] || 30);
const FRAME_MS = 20;

const key = crypto.randomBytes(16).toString('base64');
const socket = net.connect(PORT, HOST, () => {
  socket.write(
    `GET / HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
});

let handshake = true;
let buf = Buffer.alloc(0);
const arrivals = [];
const seqs = [];

socket.on('error', (e) => {
  console.error(`socket error: ${e.message}`);
  process.exit(2);
});

socket.on('data', (chunk) => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  if (handshake) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const head = buf.subarray(0, end).toString();
    if (!/ 101 /.test(head)) {
      console.error(`handshake failed: ${head.split('\r\n')[0]}`);
      process.exit(1);
    }
    buf = buf.subarray(end + 4);
    handshake = false;
  }
  while (buf.length >= 2) {
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    if (buf.length < off + len) break;
    if ((buf[0] & 0x0f) === 2 && len >= 13) {
      arrivals.push(Date.now());
      seqs.push(buf.readUInt32LE(off));
    }
    buf = buf.subarray(off + len);
  }
});

// Replay arrival times through the fill policy. `targetFrames` is the playout
// buffer target; the client drains in real time while playing, and only
// accumulates while repriming (it emits silence then).
function simulate(targetFrames) {
  let fill = 0;
  let repriming = true;
  let underruns = 0;
  let silenceMs = 0;
  for (let i = 0; i < arrivals.length; i++) {
    if (i > 0 && !repriming) {
      const dt = arrivals[i] - arrivals[i - 1];
      fill -= dt / FRAME_MS;
      if (fill < 0) {
        underruns++;
        silenceMs += -fill * FRAME_MS;
        fill = 0;
        repriming = true;
      }
    }
    fill += 1;
    if (repriming && fill >= targetFrames) {
      fill = targetFrames;
      repriming = false;
    }
  }
  return { targetMs: targetFrames * FRAME_MS, underruns, silenceMs: Math.round(silenceMs) };
}

setTimeout(() => {
  if (arrivals.length < 10) {
    console.error('too few frames received — is the stream enabled and the sink present?');
    process.exit(3);
  }
  const span = (arrivals[arrivals.length - 1] - arrivals[0]) / 1000;
  const intervals = [];
  for (let i = 1; i < arrivals.length; i++) intervals.push(arrivals[i] - arrivals[i - 1]);
  const sorted = [...intervals].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

  let jitter = -1;
  for (const iv of intervals) {
    const dev = Math.abs(iv - FRAME_MS);
    jitter = jitter < 0 ? dev : 0.05 * dev + 0.95 * jitter;
  }

  const missing = seqs.length ? seqs[seqs.length - 1] - seqs[0] + 1 - seqs.length : 0;

  console.log(
    JSON.stringify(
      {
        host: HOST,
        port: PORT,
        seconds: +span.toFixed(1),
        frames: arrivals.length,
        fps: +(arrivals.length / span).toFixed(2),
        lostFrames: missing,
        jitterEwmaMs: +jitter.toFixed(2),
        expectedTargetMs: Math.min(250, Math.max(60, Math.round(3 * jitter))),
        intervals: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), p999: pct(0.999), max: sorted[sorted.length - 1] },
        stallsOverMs: { 60: intervals.filter((x) => x > 60).length, 200: intervals.filter((x) => x > 200).length, 400: intervals.filter((x) => x > 400).length },
        predicted: [3, 5, 8, 13].map(simulate),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}, SECS * 1000);
