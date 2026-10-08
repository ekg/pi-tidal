// OUTPUT: icecast — Ogg/Opus push to an external Icecast server (lane 5).
//
// One ffmpeg process reads raw s16le PCM on stdin and pushes Ogg/Opus to an
// Icecast mount. It is a pure consumer of the fan-out frames; its own stdin
// buffer is bounded (drop-on-backpressure, see ./pcm-writer.mjs) so a stalled
// server never grows latency for streamd or the other outputs.
//
// ffmpeg absent, or an unreachable/refused Icecast server (ffmpeg exits), is
// reported in status().error and retried on a bounded exponential backoff —
// exactly like the capture watchdog, the daemon stays up.

import { spawn } from 'node:child_process';
import { writePcmFrame } from './pcm-writer.mjs';

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const CONNECT_GRACE_MS = 8000;
const DEFAULT_MAX_BUFFERED_BYTES = 128 * 1024;

function log(...a) {
  process.stdout.write(`[streamd ${new Date().toISOString()}] ${a.join(' ')}\n`);
}

export const icecastDefaults = {
  enabled: false,
  host: '127.0.0.1',
  port: 8000,
  mount: '/stream.ogg',
  sourceUser: 'source',
  sourcePassword: 'hackme',
  bitrate: 96,
  maxBufferedBytes: DEFAULT_MAX_BUFFERED_BYTES,
};

// Pure: the ffmpeg argv (without the leading `ffmpeg`) for a given config and
// stream format. Kept separate so it can be asserted byte-for-byte in tests.
export function buildIcecastArgs(settings, stream) {
  const rate = Number(stream?.rate ?? 48000);
  const channels = Number(stream?.channels ?? 2);
  const host = settings.host ?? '127.0.0.1';
  const port = Number(settings.port ?? 8000);
  let mount = String(settings.mount ?? '/stream.ogg');
  if (!mount.startsWith('/')) mount = `/${mount}`;
  const user = settings.sourceUser ?? 'source';
  const pass = settings.sourcePassword ?? 'hackme';
  const bitrate = Number(settings.bitrate ?? 96);
  const url = `icecast://${user}:${pass}@${host}:${port}${mount}`;
  return [
    '-f', 's16le',
    '-ar', String(rate),
    '-ac', String(channels),
    '-i', '-',
    '-c:a', 'libopus',
    '-b:a', `${bitrate}k`,
    '-f', 'ogg',
    // Icecast takes the mount's content-type from what the source declares.
    // WITHOUT this the mount is announced as audio/mpeg, and every listener
    // (VLC, ffplay, ffmpeg) tries to demux Ogg/Opus as MP3 and fails with
    // "Header missing" even though bytes are flowing and status() looks fine.
    // VERIFIED against a real icecast2: with -content_type the mount reports
    // audio/ogg and decoding the stream back out returns the actual audio.
    '-content_type', 'audio/ogg',
    url,
  ];
}

// settings is streamd's outputSettings('icecast', icecastDefaults) result;
// stream is {rate, channels}. deps.spawn is injectable for tests.
export function createIcecastOutput(settings, stream, deps = {}) {
  const spawnFn = deps.spawn ?? spawn;
  const maxBuffered = Number(settings.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES);

  return {
    name: 'icecast',
    settings,
    active: false,
    child: null,
    retryTimer: null,
    connectTimer: null,
    retryDelay: 0,
    dropped: 0,
    bytesOut: 0,
    error: null,
    _stderr: '',

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
      log(`icecast: ffmpeg failed (${this.error}); retrying in ${delay}ms`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this._spawnFfmpeg();
      }, delay);
      this.retryTimer.unref?.();
    },

    _spawnFfmpeg() {
      if (!this.active || this.child) return;
      const args = buildIcecastArgs(this.settings, stream);
      let child;
      try {
        child = spawnFn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (e) {
        this.error = `spawn ffmpeg failed: ${e.message}`;
        this._scheduleRetry();
        return;
      }
      this.child = child;
      this._stderr = '';
      log(`icecast: ffmpeg ${args.join(' ')}`);
      // Clear the error only once ffmpeg has survived a grace period. A refused
      // Icecast connection kills ffmpeg within ~100 ms; if it is still alive
      // after the grace it is genuinely streaming, so reset the backoff.
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (this.child === child) {
          this.error = null;
          this.retryDelay = 0;
        }
      }, CONNECT_GRACE_MS);
      this.connectTimer.unref?.();
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

    async start() {
      if (this.active) return;
      this.active = true;
      this.error = null;
      this.retryDelay = 0;
      log('output icecast started');
      this._spawnFfmpeg();
    },

    async stop() {
      if (!this.active) return;
      this.active = false;
      this._clearRetry();
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
      log('output icecast stopped');
    },

    onFrame(msg) {
      const child = this.child;
      if (!child || !child.stdin) return;
      const pcm = msg.subarray(13);
      const r = writePcmFrame(child.stdin, pcm, maxBuffered);
      if (r.dropped) {
        this.dropped++;
        return;
      }
      if (r.written) this.bytesOut += r.written;
    },

    handleHttp() {
      return false;
    },
    handleUpgrade() {
      return false;
    },

    status() {
      return {
        name: 'icecast',
        enabled: this.settings.enabled !== false,
        active: this.active,
        dropped: this.dropped,
        bytesOut: this.bytesOut,
        error: this.error,
        connected: !!this.child && !this.error,
      };
    },
  };
}
