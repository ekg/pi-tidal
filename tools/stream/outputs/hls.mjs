// OUTPUT: hls — segmented HTTP Live Streaming via ffmpeg (lane 5).
//
// One ffmpeg process reads raw s16le PCM on stdin, encodes AAC and writes an
// fMP4 HLS playlist + segments into a directory. streamd's existing HTTP
// server serves them under /hls/* by calling this output's handleHttp. The
// playlist is sent no-store so a player always sees the freshest segment.
//
// The stdin buffer is bounded exactly like icecast (drop-on-backpressure,
// see ./pcm-writer.mjs); an ffmpeg failure is reported in status().error and
// retried on a bounded exponential backoff.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePcmFrame } from './pcm-writer.mjs';

// This module lives in <stream>/outputs/, so the player page and the vendored
// hls.js sit one directory up.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STREAM_DIR = path.resolve(HERE, '..');

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const CONNECT_GRACE_MS = 8000;
const DEFAULT_MAX_BUFFERED_BYTES = 128 * 1024;

const CONTENT_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.ts': 'video/mp2t',
  '.aac': 'audio/aac',
};

function log(...a) {
  process.stdout.write(`[streamd ${new Date().toISOString()}] ${a.join(' ')}\n`);
}

export const hlsDefaults = {
  enabled: false,
  dir: '/tmp/tidal-stream-hls',
  segmentMs: 2000,
  listSize: 6,
  bitrate: 128,
  codec: 'aac',
  maxBufferedBytes: DEFAULT_MAX_BUFFERED_BYTES,
};

// Pure: the ffmpeg argv (without the leading `ffmpeg`) for a given config and
// stream format. fMP4 + AAC so a browser (with hls.js) can play it.
export function buildHlsArgs(settings, stream) {
  const rate = Number(stream?.rate ?? 48000);
  const channels = Number(stream?.channels ?? 2);
  const dir = settings.dir ?? hlsDefaults.dir;
  const segmentSec = Number(settings.segmentMs ?? 2000) / 1000;
  const listSize = Number(settings.listSize ?? 6);
  const bitrate = Number(settings.bitrate ?? 128);
  const codec = settings.codec ?? 'aac';
  return [
    '-f', 's16le',
    '-ar', String(rate),
    '-ac', String(channels),
    '-i', '-',
    '-c:a', codec,
    '-b:a', `${bitrate}k`,
    '-f', 'hls',
    '-hls_time', String(segmentSec),
    '-hls_list_size', String(listSize),
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_flags', 'delete_segments',
    '-hls_segment_filename', path.join(dir, 'seg%05d.m4s'),
    path.join(dir, 'index.m3u8'),
  ];
}

// settings is streamd's outputSettings('hls', hlsDefaults) result; stream is
// {rate, channels}. deps.spawn is injectable for tests.
export function createHlsOutput(settings, stream, deps = {}) {
  const spawnFn = deps.spawn ?? spawn;
  const maxBuffered = Number(settings.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES);

  return {
    name: 'hls',
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
      log(`hls: ffmpeg failed (${this.error}); retrying in ${delay}ms`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this._spawnFfmpeg();
      }, delay);
      this.retryTimer.unref?.();
    },

    _spawnFfmpeg() {
      if (!this.active || this.child) return;
      const dir = this.settings.dir ?? hlsDefaults.dir;
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        this.error = `cannot create hls dir '${dir}': ${e.message}`;
        this._scheduleRetry();
        return;
      }
      const args = buildHlsArgs(this.settings, stream);
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
      log(`hls: ffmpeg ${args.join(' ')}`);
      // Clear the error only after ffmpeg has survived a grace period; if it
      // is alive after that it is genuinely writing segments, so reset the
      // backoff.
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
      log('output hls started');
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
      log('output hls stopped');
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

    // Serve the playlist + segments written by ffmpeg under /hls/*. The
    // playlist is no-store (it is rewritten every segment); segments are
    // no-store too because delete_segments recycles their numbers.
    handleHttp(url, req, res) {
      // The player page and the vendored decoder live beside the sources, not in
      // the segment dir. Serve them BEFORE the /hls/ mapping so the live
      // playlist is never shadowed by them.
      if (req.method === 'GET' || req.method === 'HEAD') {
        const STATIC = {
          '/hls.html': ['hls.html', 'text/html; charset=utf-8'],
          '/hls': ['hls.html', 'text/html; charset=utf-8'],
          '/hls/': ['hls.html', 'text/html; charset=utf-8'],
          '/hls.min.js': [path.join('vendor', 'hls.min.js'), 'application/javascript; charset=utf-8'],
        };
        const hit = STATIC[url.pathname];
        if (hit) {
          let body;
          try {
            body = fs.readFileSync(path.join(STREAM_DIR, hit[0]));
          } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end(`${hit[0]} not found\n`);
            return true;
          }
          res.writeHead(200, {
            'Content-Type': hit[1],
            'Cache-Control': 'no-store',
            'Content-Length': body.length,
          });
          if (req.method === 'HEAD') res.end();
          else res.end(body);
          return true;
        }
      }
      const prefix = '/hls/';
      if (!url.pathname.startsWith(prefix)) return false;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('method not allowed\n');
        return true;
      }
      const base = path.resolve(this.settings.dir ?? hlsDefaults.dir);
      const rel = decodeURIComponent(url.pathname.slice(prefix.length));
      const full = path.resolve(base, rel);
      if (full !== base && !full.startsWith(base + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden\n');
        return true;
      }
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found\n');
        return true;
      }
      if (!stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found\n');
        return true;
      }
      const type = CONTENT_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'Content-Length': stat.size,
      });
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      const stream = fs.createReadStream(full);
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      stream.pipe(res);
      return true;
    },
    handleUpgrade() {
      return false;
    },

    status() {
      const dir = this.settings.dir ?? hlsDefaults.dir;
      return {
        name: 'hls',
        enabled: this.settings.enabled !== false,
        active: this.active,
        dropped: this.dropped,
        bytesOut: this.bytesOut,
        error: this.error,
        connected: !!this.child && !this.error,
        dir,
        playlist: '/hls/index.m3u8',
      };
    },
  };
}
