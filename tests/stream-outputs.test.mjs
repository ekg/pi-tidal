import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIcecastArgs, createIcecastOutput } from '../tools/stream/outputs/icecast.mjs';
import { buildHlsArgs } from '../tools/stream/outputs/hls.mjs';
import { writePcmFrame } from '../tools/stream/outputs/pcm-writer.mjs';

// --- buildIcecastArgs ------------------------------------------------------

test('buildIcecastArgs builds the exact ffmpeg argv for an Icecast push', () => {
  const settings = {
    host: 'ice.example', port: 8000, mount: '/live.ogg',
    sourceUser: 'src', sourcePassword: 'pw', bitrate: 128,
  };
  assert.deepEqual(buildIcecastArgs(settings, { rate: 48000, channels: 2 }), [
    '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', '-',
    '-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg',
    '-content_type', 'audio/ogg',
    'icecast://src:pw@ice.example:8000/live.ogg',
  ]);
});

// Regression: without -content_type Icecast announces the mount as audio/mpeg
// and every listener fails to demux Ogg/Opus ("Header missing") while status()
// still looks healthy. Found by decoding a real icecast2 mount back out.
test('buildIcecastArgs always declares the ogg content type', () => {
  const argv = buildIcecastArgs({ host: 'h', mount: '/m' }, { rate: 48000, channels: 2 });
  assert.equal(argv[argv.indexOf('-content_type') + 1], 'audio/ogg');
  assert.ok(argv.indexOf('-content_type') < argv.length - 1, 'content type precedes the URL');
});

test('buildIcecastArgs normalizes the mount and applies defaults', () => {
  const argv = buildIcecastArgs({ host: 'h', mount: 'stream.ogg' }, { rate: 44100, channels: 1 });
  assert.equal(argv[argv.length - 1], 'icecast://source:hackme@h:8000/stream.ogg');
  assert.equal(argv[argv.indexOf('-ar') + 1], '44100');
  assert.equal(argv[argv.indexOf('-ac') + 1], '1');
  assert.equal(argv[argv.indexOf('-b:a') + 1], '96k');
});

// --- buildHlsArgs ----------------------------------------------------------

test('buildHlsArgs builds the exact ffmpeg argv for fMP4 HLS', () => {
  const settings = { dir: '/tmp/hls', segmentMs: 2000, listSize: 6, bitrate: 128, codec: 'aac' };
  assert.deepEqual(buildHlsArgs(settings, { rate: 48000, channels: 2 }), [
    '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', '-',
    '-c:a', 'aac', '-b:a', '128k', '-f', 'hls',
    '-hls_time', '2', '-hls_list_size', '6',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_flags', 'delete_segments',
    '-hls_segment_filename', '/tmp/hls/seg%05d.m4s',
    '/tmp/hls/index.m3u8',
  ]);
});

test('buildHlsArgs honors a non-default codec and segment length', () => {
  const settings = { dir: '/d', segmentMs: 500, listSize: 12, bitrate: 64, codec: 'libopus' };
  const argv = buildHlsArgs(settings, { rate: 48000, channels: 2 });
  assert.equal(argv[argv.indexOf('-c:a') + 1], 'libopus');
  assert.equal(argv[argv.indexOf('-hls_time') + 1], '0.5');
  assert.equal(argv[argv.indexOf('-hls_list_size') + 1], '12');
});

// --- drop-on-backpressure policy ------------------------------------------

test('writePcmFrame writes below the threshold and drops above it', () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const stdin = {
    writable: true,
    writableLength: 0,
    written: [],
    write(c) { this.written.push(c); return true; },
  };
  assert.deepEqual(writePcmFrame(stdin, pcm, 64), { written: 4, dropped: false, needsDrain: false });
  assert.equal(stdin.written.length, 1);

  stdin.writableLength = 65; // over the 64-byte threshold
  assert.deepEqual(writePcmFrame(stdin, pcm, 64), { written: 0, dropped: true, needsDrain: false });
  assert.equal(stdin.written.length, 1, 'no write happens while backpressured');
});

test('writePcmFrame writes once more exactly at the threshold', () => {
  const stdin = { writable: true, writableLength: 64, write: () => false };
  assert.deepEqual(writePcmFrame(stdin, Buffer.from([0]), 64), { written: 1, dropped: false, needsDrain: true });
});

test('writePcmFrame treats a closed stdin as a no-op, not a drop', () => {
  const stdin = { writable: false, writableLength: 0, write: () => true };
  assert.deepEqual(writePcmFrame(stdin, Buffer.from([0]), 64), { written: 0, dropped: false, needsDrain: false });
  assert.deepEqual(writePcmFrame(null, Buffer.from([0]), 64), { written: 0, dropped: false, needsDrain: false });
});

// --- output lifecycle: disabled costs nothing, drop is wired through ------

function fakeChild() {
  return {
    stdin: { writable: true, writableLength: 0, written: [], write(c) { this.written.push(c); return true; }, end() {} },
    stderr: { on() {} },
    on() {},
    kill() {},
  };
}

test('createIcecastOutput spawns nothing until start(), then drops under backpressure', async () => {
  const spawned = [];
  const out = createIcecastOutput(
    { enabled: true, maxBufferedBytes: 64 },
    { rate: 48000, channels: 2 },
    { spawn: (cmd, args) => { const c = fakeChild(); c.cmd = cmd; c.args = args; spawned.push(c); return c; } },
  );
  assert.equal(out.active, false);
  assert.equal(spawned.length, 0, 'constructing a disabled/unstarted output spawns no process');

  await out.start();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, 'ffmpeg');

  const msg = Buffer.alloc(13 + 4); // header + 4 PCM bytes
  out.onFrame(msg);
  assert.equal(out.status().bytesOut, 4);

  spawned[0].stdin.writableLength = 1000; // encoder stalled
  out.onFrame(msg);
  assert.equal(out.status().dropped, 1);
  assert.equal(out.status().bytesOut, 4, 'dropped frames add no bytes');

  await out.stop();
  assert.equal(out.active, false);
});
