// OUTPUT: ws-opus — Opus over the stream's own WebSocket (lane 6).
//
// A second WebSocket path that carries Opus instead of PCM, for
// bandwidth-thin links (~96 kbps vs ~1.5 Mbps for the s16le stereo PCM path).
// It is OUR player's path; the icecast output remains the third-party-player
// path and is untouched.
//
// One ffmpeg process reads raw s16le PCM on stdin and writes an Ogg/Opus
// bitstream to stdout. This module parses that bitstream back into raw Opus
// packets (Ogg pages: 27-byte header + lacing table, packets span pages via
// 255-byte lacing values) and fans each packet out to /opus WebSocket clients.
//
// Wire framing (extends the frozen PCM protocol; the 13-byte header layout is
// byte-identical):
//   CONFIG (once per client, and again whenever ffmpeg restarts):
//     binary WS message, first byte 0x02, then the raw OpusHead packet
//     (WebCodecs wants it as AudioDecoderConfig.description)
//   AUDIO (one per Opus packet):
//     13-byte header (uint32 own packet seq LE, float64 sentMs LE,
//     uint8 flags bit0 = source discontinuity) + one raw Opus packet
//   The 1-byte 0x01 ping -> [0x01, uint32 seq] reply convention is unchanged.
//
// Anti-drift: each connection queues at most 2 packets, drop-oldest, exactly
// like ws-pcm. The ffmpeg stdin buffer is bounded by pcm-writer.mjs's
// drop-on-backpressure policy so a stalled encoder never grows latency for
// streamd or the other outputs.

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { writePcmFrame } from './pcm-writer.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const CONNECT_GRACE_MS = 8000;
const DEFAULT_MAX_BUFFERED_BYTES = 128 * 1024;
const MAX_QUEUE = 2; // Opus packets per connection, drop-oldest

function log(...a) {
  process.stdout.write(`[streamd ${new Date().toISOString()}] ${a.join(' ')}\n`);
}

export const wsOpusDefaults = {
  enabled: false,
  bitrate: 96,
  maxBufferedBytes: DEFAULT_MAX_BUFFERED_BYTES,
};

// Pure: the ffmpeg argv (without the leading `ffmpeg`) for a given config and
// stream format. Kept separate so it can be asserted byte-for-byte in tests.
//
// Two flag groups are load-bearing for a realtime pipe and must not be
// "cleaned up" later:
//   -probesize 32 -analyzeduration 0  (input)
//     Without them ffmpeg's avformat_find_stream_info() blocks on the raw
//     s16le pipe until it has buffered ~4.3 s of input before emitting a
//     single byte (measured: first output 4360 ms -> 104 ms). With -f/-ar/-ac
//     fully specified there is nothing to probe.
//   -page_duration 20000  (output)
//     The Ogg muxer's 1 s default page duration makes ffmpeg burst ~50
//     packets per stdout chunk. A *correct* at-most-2-packets drop-oldest
//     queue then discards ~48 of every 50 (measured: packetsOut 267,
//     dropped 282). One 20 ms page per packet keeps arrival at the frame
//     cadence, so the bounded queue drops ~0 during normal operation.
export function buildOpusArgs(settings, stream) {
  const rate = Number(stream?.rate ?? 48000);
  const channels = Number(stream?.channels ?? 2);
  const bitrate = Number(settings.bitrate ?? 96);
  return [
    '-f', 's16le',
    '-ar', String(rate),
    '-ac', String(channels),
    '-probesize', '32',
    '-analyzeduration', '0',
    '-i', '-',
    '-c:a', 'libopus',
    '-b:a', `${bitrate}k`,
    '-vbr', 'on',
    '-page_duration', '20000',
    '-f', 'ogg',
    '-',
  ];
}

// --- Ogg bitstream parsing -------------------------------------------------
//
// An Ogg page is: "OggS" (4) + version (1) + header type (1) + granule (8) +
// serial (4) + sequence (4) + CRC (4) + page_segments (1) + lacing values
// (page_segments bytes), followed by sum(lacing) data bytes. A lacing value of
// 255 means the packet continues; a value < 255 terminates the current packet.
// A packet may span pages, so the parser keeps an in-progress packet (`cur`)
// across calls. The parse state is plain and copyable so the exact same code
// path handles whole-buffer and arbitrary-chunk-boundary input.

export function createOggState() {
  return { buf: Buffer.alloc(0), cur: null, curBos: false };
}

// Pure (mutates and returns `state`). `buffer` may be any chunk, including a
// single byte; every call returns the packets completed by that chunk.
// Packets are {data, serial, granule, bos, eos}.
export function parseOggPackets(state, buffer) {
  const packets = [];
  if (buffer && buffer.length) {
    state.buf = state.buf.length ? Buffer.concat([state.buf, buffer]) : Buffer.from(buffer);
  }
  for (;;) {
    const b = state.buf;
    if (b.length < 27) break;
    if (b[0] !== 0x4f || b[1] !== 0x67 || b[2] !== 0x67 || b[3] !== 0x53) {
      // Not a capture pattern: resync one byte at a time rather than dropping
      // the whole buffer (a corrupt prefix must not swallow a valid page).
      state.buf = b.subarray(1);
      continue;
    }
    const pageSegments = b[26];
    const headerLen = 27 + pageSegments;
    if (b.length < headerLen) break;
    let dataLen = 0;
    for (let i = 0; i < pageSegments; i++) dataLen += b[27 + i];
    if (b.length < headerLen + dataLen) break;

    const headerType = b[5];
    const serial = b.readUInt32LE(14);
    const granule = b.readBigInt64LE(6);
    const bos = (headerType & 0x02) !== 0;
    const eos = (headerType & 0x04) !== 0;

    let off = headerLen;
    for (let i = 0; i < pageSegments; i++) {
      const lv = b[27 + i];
      const seg = b.subarray(off, off + lv);
      off += lv;
      if (state.cur === null) {
        state.cur = Buffer.from(seg);
        state.curBos = bos; // a packet is BOS if it STARTED on a BOS page
      } else {
        state.cur = Buffer.concat([state.cur, seg]);
      }
      if (lv < 255) {
        packets.push({ data: state.cur, serial, granule, bos: state.curBos, eos });
        state.cur = null;
      }
    }
    state.buf = b.subarray(headerLen + dataLen);
  }
  return { state, packets };
}

function isOpusHead(d) {
  return d.length >= 8 && d.toString('latin1', 0, 8) === 'OpusHead';
}

function isOpusTags(d) {
  return d.length >= 8 && d.toString('latin1', 0, 8) === 'OpusTags';
}

// settings is streamd's outputSettings('ws-opus', wsOpusDefaults) result;
// stream is {rate, channels}. deps.spawn is injectable for tests.
export function createWsOpusOutput(settings, stream, deps = {}) {
  const spawnFn = deps.spawn ?? spawn;
  const maxBuffered = Number(settings.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES);
  const connections = new Set();

  const out = {
    name: 'ws-opus',
    settings,
    active: false,
    child: null,
    retryTimer: null,
    connectTimer: null,
    retryDelay: 0,
    error: null,
    dropped: 0, // packets dropped by a connection's bounded queue
    droppedPcm: 0, // source frames dropped by ffmpeg stdin backpressure
    packetsOut: 0,
    bytesOut: 0,
    pcmBytes: 0,
    opusHead: null,
    streamSerial: null,
    pktSeq: 0,
    _stderr: '',
    _ogg: createOggState(),
    _sentMs: Date.now(),
    _pendingDisc: false,

    _clearRetry() {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
    },

    _scheduleRetry() {
      if (!this.active || this.retryTimer) return;
      this.retryDelay = this.retryDelay
        ? Math.min(this.retryDelay * 2, MAX_BACKOFF_MS)
        : BASE_BACKOFF_MS;
      const delay = this.retryDelay;
      log(`ws-opus: ffmpeg failed (${this.error}); retrying in ${delay}ms`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this._spawnFfmpeg();
      }, delay);
      this.retryTimer.unref?.();
    },

    _spawnFfmpeg() {
      if (!this.active || this.child) return;
      // A new ffmpeg is a new Ogg stream: forget the previous OpusHead/serial
      // so clients are re-sent a CONFIG and stale packets are not forwarded.
      this.opusHead = null;
      this.streamSerial = null;
      this._ogg = createOggState();
      const args = buildOpusArgs(this.settings, stream);
      let child;
      try {
        child = spawnFn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        this.error = `spawn ffmpeg failed: ${e.message}`;
        this._scheduleRetry();
        return;
      }
      this.child = child;
      this._stderr = '';
      log(`ws-opus: ffmpeg ${args.join(' ')}`);
      // Clear the error only once ffmpeg has survived a grace period; before
      // that a spawn failure/instant exit is a real error worth reporting.
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (this.child === child) {
          this.error = null;
          this.retryDelay = 0;
        }
      }, CONNECT_GRACE_MS);
      this.connectTimer.unref?.();
      child.stdout?.on('data', (d) => this._onFfmpegStdout(d));
      child.on('error', (e) => {
        this._clearRetry();
        if (this.child === child) this.child = null;
        if (!this.active) return;
        this.error = e.code === 'ENOENT' ? 'ffmpeg not found on PATH' : `ffmpeg error: ${e.message}`;
        this._scheduleRetry();
      });
      child.stderr?.on('data', (d) => {
        this._stderr = (this._stderr + d.toString()).slice(-1000);
      });
      child.on('exit', (code, sig) => {
        this._clearRetry();
        if (this.child === child) this.child = null;
        if (!this.active) return; // stop() killed it; no retry
        const tail = this._stderr
          .trim()
          .split('\n')
          .filter(Boolean)
          .pop();
        this.error = `ffmpeg exited code=${code} sig=${sig}${tail ? `: ${tail}` : ''}`;
        this._scheduleRetry();
      });
    },

    _onFfmpegStdout(chunk) {
      const { packets } = parseOggPackets(this._ogg, chunk);
      for (const p of packets) {
        const d = p.data;
        if (isOpusHead(d)) {
          this.opusHead = Buffer.from(d);
          this.streamSerial = p.serial;
          log(`ws-opus: OpusHead ${d.length}B serial=${p.serial}`);
          for (const conn of connections) {
            conn.pendingConfig = true;
            pump(conn);
          }
          continue;
        }
        if (isOpusTags(d)) continue; // comment header: not audio, not config
        if (this.streamSerial === null || p.serial !== this.streamSerial) continue;
        if (!this.opusHead) continue; // never send audio before a config exists
        this._emitPacket(d);
      }
    },

    _emitPacket(data) {
      this.pktSeq = (this.pktSeq + 1) >>> 0;
      this.packetsOut++;
      this.bytesOut += data.length;
      const msg = Buffer.allocUnsafe(13 + data.length);
      msg.writeUInt32LE(this.pktSeq, 0);
      msg.writeDoubleLE(this._sentMs, 4);
      msg.writeUInt8(this._pendingDisc ? 1 : 0, 12);
      this._pendingDisc = false;
      data.copy(msg, 13);
      for (const conn of connections) enqueue(conn, msg);
    },

    async start() {
      if (this.active) return;
      this.active = true;
      this.error = null;
      this.retryDelay = 0;
      log('output ws-opus started');
      this._spawnFfmpeg();
    },

    async stop() {
      if (!this.active) return;
      this.active = false;
      this._clearRetry();
      for (const conn of [...connections]) closeConn(conn);
      const child = this.child;
      this.child = null;
      if (child) {
        try {
          child.stdin?.end();
        } catch {}
        try {
          child.kill('SIGTERM');
        } catch {}
      }
      log('output ws-opus stopped');
    },

    onFrame(msg) {
      this._sentMs = msg.readDoubleLE(4);
      if (msg.readUInt8(12) & 1) this._pendingDisc = true;
      const child = this.child;
      if (!child || !child.stdin) return;
      const r = writePcmFrame(child.stdin, msg.subarray(13), maxBuffered);
      if (r.dropped) {
        this.droppedPcm++;
        return;
      }
      if (r.written) this.pcmBytes += r.written;
    },

    handleHttp() {
      return false; // player.html is served by ws-pcm on `/`
    },

    // `/opus` WebSocket upgrade. The dispatch in streamd calls this after the
    // token check; ws-pcm keeps `/`.
    handleUpgrade(url, req, socket) {
      if (url.pathname !== '/opus') return false;
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
      const conn = {
        socket,
        queue: [],
        writing: false,
        closed: false,
        dropped: 0,
        rbuf: Buffer.alloc(0),
        pendingConfig: true,
      };
      connections.add(conn);
      log(`ws-opus: client connected (listeners=${connections.size})`);
      socket.on('data', (chunk) => onSocketData(conn, chunk));
      socket.on('error', () => closeConn(conn));
      socket.on('close', () => {
        if (!conn.closed) log(`ws-opus: client disconnected (dropped=${conn.dropped})`);
        closeConn(conn);
      });
      pump(conn); // send CONFIG now if a head is already known
      return true;
    },

    status() {
      return {
        name: 'ws-opus',
        enabled: this.settings.enabled !== false,
        active: this.active,
        listeners: connections.size,
        dropped: this.dropped,
        droppedPcm: this.droppedPcm,
        packetsOut: this.packetsOut,
        bytesOut: this.bytesOut,
        error: this.error,
        connected: !!this.child && !this.error,
        bitrate: Number(this.settings.bitrate ?? 96),
        path: '/opus',
        hasOpusHead: !!this.opusHead,
      };
    },
  };

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

  function configMessage() {
    if (!out.opusHead) return null;
    return Buffer.concat([Buffer.from([0x02]), out.opusHead]);
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
    if (conn.pendingConfig) {
      const m = configMessage();
      conn.pendingConfig = false;
      if (m) {
        conn.writing = true;
        try {
          conn.socket.write(wsEncode(m), () => {
            conn.writing = false;
            pump(conn);
          });
        } catch {
          conn.writing = false;
          closeConn(conn);
        }
        return;
      }
    }
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

  // the core anti-drift rule: at most 2 packets queued, drop-oldest
  function enqueue(conn, msg) {
    conn.queue.push(msg);
    while (conn.queue.length > MAX_QUEUE) {
      conn.queue.shift();
      conn.dropped++;
      out.dropped++;
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
    // data frame: a 1-byte ping asks for the current packet seq (explicit resync)
    if (payload.length === 1) {
      const p = Buffer.allocUnsafe(5);
      p.writeUInt8(0x01, 0);
      p.writeUInt32LE(out.pktSeq, 1);
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

  return out;
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}
