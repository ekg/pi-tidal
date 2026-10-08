import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import {
  buildOpusArgs,
  parseOggPackets,
  createOggState,
  createWsOpusOutput,
} from '../tools/stream/outputs/ws-opus.mjs';

// --- buildOpusArgs ---------------------------------------------------------

test('buildOpusArgs builds the exact ffmpeg argv for an Ogg/Opus stdout stream', () => {
  assert.deepEqual(buildOpusArgs({ bitrate: 96 }, { rate: 48000, channels: 2 }), [
    '-f', 's16le', '-ar', '48000', '-ac', '2',
    '-probesize', '32', '-analyzeduration', '0', '-i', '-',
    '-c:a', 'libopus', '-b:a', '96k', '-vbr', 'on',
    '-page_duration', '20000', '-f', 'ogg', '-',
  ]);
});

// Regression: these three flags are latency-critical, not cosmetic. Without the
// input probe flags ffmpeg blocks ~4.3 s before its first byte; without the
// small page_duration its ~1 s Ogg pages burst ~50 packets at once and the
// correct drop-oldest queue destroys almost all of them. Removing one must
// fail this suite rather than silently regress latency.
test('buildOpusArgs keeps the load-bearing input/output latency flags', () => {
  const argv = buildOpusArgs({ bitrate: 96 }, { rate: 48000, channels: 2 });
  assert.ok(argv.includes('-probesize'), 'has -probesize');
  assert.ok(argv.includes('-analyzeduration'), 'has -analyzeduration');
  assert.ok(argv.includes('-page_duration'), 'has -page_duration');
  // input options precede -i, output options precede the output url/format
  assert.ok(argv.indexOf('-probesize') < argv.indexOf('-i'));
  assert.ok(argv.indexOf('-analyzeduration') < argv.indexOf('-i'));
  assert.ok(argv.indexOf('-page_duration') > argv.indexOf('-i'));
  assert.equal(argv[argv.indexOf('-page_duration') + 1], '20000');
});

test('buildOpusArgs honors a different bitrate/rate/channels', () => {
  const argv = buildOpusArgs({ bitrate: 64 }, { rate: 44100, channels: 1 });
  assert.equal(argv[argv.indexOf('-b:a') + 1], '64k');
  assert.equal(argv[argv.indexOf('-ar') + 1], '44100');
  assert.equal(argv[argv.indexOf('-ac') + 1], '1');
});

// --- Ogg parsing: synthetic multi-page packet (explicit continuation) -----

function oggPage({ serial = 1, headerType = 0, lacing, data }) {
  const h = Buffer.alloc(27 + lacing.length);
  h.write('OggS', 0, 'latin1');
  h[4] = 0; // version
  h[5] = headerType; // bit0 continued, bit1 BOS, bit2 EOS
  h.writeBigInt64LE(0n, 6);
  h.writeUInt32LE(serial, 14);
  h.writeUInt32LE(0, 18);
  h.writeUInt32LE(0, 22); // CRC (the parser does not verify it)
  h[26] = lacing.length;
  lacing.forEach((v, i) => (h[27 + i] = v));
  return Buffer.concat([h, Buffer.from(data)]);
}

test('parseOggPackets reassembles a packet that spans two pages', () => {
  const packet = Buffer.alloc(300, 7);
  const page1 = oggPage({ headerType: 0x02, lacing: [255], data: packet.subarray(0, 255) });
  const page2 = oggPage({ headerType: 0x01, lacing: [45], data: packet.subarray(255) });
  const { packets } = parseOggPackets(createOggState(), Buffer.concat([page1, page2]));
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0].data, packet);
  assert.equal(packets[0].bos, true);
});

test('parseOggPackets yields a zero-length packet terminated by a 0 lacing value', () => {
  const page = oggPage({ lacing: [0, 3], data: Buffer.from([1, 2, 3]) });
  const { packets } = parseOggPackets(createOggState(), page);
  assert.equal(packets.length, 2);
  assert.equal(packets[0].data.length, 0);
  assert.deepEqual(packets[1].data, Buffer.from([1, 2, 3]));
});

// The client parser must not assume one packet per page: `-page_duration` is a
// tuning knob, so multi-packet pages, page-spanning packets and 255-lacing
// continuation must all still work.
test('parseOggPackets splits multiple packets on one page and spans pages', () => {
  const a = Buffer.alloc(100, 1);
  const b = Buffer.alloc(400, 2); // spans pages: 255 + 145 lacing
  const c = Buffer.from([9, 9, 9]);
  // page 1: packet a completes, packet b starts and continues (255 lacing)
  const page1 = oggPage({ headerType: 0x00, lacing: [100, 255], data: Buffer.concat([a, b.subarray(0, 255)]) });
  // page 2 (continued): packet b completes, then packet c on the same page
  const page2 = oggPage({ headerType: 0x01, lacing: [145, 3], data: Buffer.concat([b.subarray(255), c]) });
  const { packets } = parseOggPackets(createOggState(), Buffer.concat([page1, page2]));
  assert.equal(packets.length, 3);
  assert.deepEqual(packets[0].data, a);
  assert.deepEqual(packets[1].data, b);
  assert.deepEqual(packets[2].data, c);
});

// --- Ogg parsing: real ffmpeg fixture --------------------------------------

function ffmpegAvailable() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

function tonePcm(seconds, rate, channels) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.allocUnsafe(n * channels * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5 * 32767);
    for (let c = 0; c < channels; c++) buf.writeInt16LE(s, (i * channels + c) * 2);
  }
  return buf;
}

// One real Ogg/Opus stream, generated by the same ffmpeg argv the output uses.
let OGG = null;
if (ffmpegAvailable()) {
  const res = spawnSync('ffmpeg', buildOpusArgs({ bitrate: 96 }, { rate: 48000, channels: 2 }), {
    input: tonePcm(1, 48000, 2),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status === 0 && res.stdout && res.stdout.length) OGG = res.stdout;
}
const skipNoFfmpeg = OGG ? false : 'ffmpeg fixture unavailable';

test('parseOggPackets extracts OpusHead/OpusTags and the audio packet count', { skip: skipNoFfmpeg }, () => {
  const { packets } = parseOggPackets(createOggState(), OGG);
  assert.ok(packets.length > 2, 'at least the two headers plus audio');
  assert.equal(packets[0].data.toString('latin1', 0, 8), 'OpusHead');
  assert.equal(packets[0].data.length, 19, 'OpusHead v1 is 19 bytes');
  assert.equal(packets[1].data.toString('latin1', 0, 8), 'OpusTags');
  const audio = packets.slice(2);
  // 1 s of 20 ms Opus frames. libopus adds a small pre-skip, so allow a frame
  // either side rather than pinning an exact number.
  assert.ok(audio.length >= 49 && audio.length <= 52, `audio packets ~50, got ${audio.length}`);
  for (const p of audio) assert.ok(p.data.length > 0);
  // All packets carry the same Ogg bitstream serial.
  assert.equal(new Set(packets.map((p) => p.serial)).size, 1);
});

test('parseOggPackets is identical across whole-buffer and 1-byte-chunk input', { skip: skipNoFfmpeg }, () => {
  const whole = parseOggPackets(createOggState(), OGG).packets;
  const state = createOggState();
  const incremental = [];
  for (const byte of OGG) {
    for (const p of parseOggPackets(state, Buffer.from([byte])).packets) incremental.push(p);
  }
  assert.equal(incremental.length, whole.length, 'same packet count');
  for (let i = 0; i < whole.length; i++) {
    assert.deepEqual(incremental[i].data, whole[i].data, `packet ${i} identical`);
    assert.equal(incremental[i].serial, whole[i].serial);
  }
});

// --- output lifecycle: spawn argv, drop-on-backpressure, Ogg -> packet ------

function fakeChild() {
  return {
    stdout: new EventEmitter(),
    stdin: {
      writable: true,
      writableLength: 0,
      written: [],
      write(c) {
        this.written.push(c);
        return true;
      },
      end() {},
    },
    stderr: new EventEmitter(),
    on() {},
    kill() {},
  };
}

test('createWsOpusOutput spawns nothing until start(), then frames PCM into packets', { skip: skipNoFfmpeg }, async () => {
  const spawned = [];
  const out = createWsOpusOutput(
    { enabled: true, bitrate: 96, maxBufferedBytes: 64 },
    { rate: 48000, channels: 2 },
    {
      spawn: (cmd, args) => {
        const c = fakeChild();
        c.cmd = cmd;
        c.args = args;
        spawned.push(c);
        return c;
      },
    },
  );
  assert.equal(out.active, false);
  assert.equal(spawned.length, 0, 'constructing an unstarted output spawns no process');

  await out.start();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, 'ffmpeg');

  // Feed a real Ogg/Opus bitstream through ffmpeg's (fake) stdout.
  spawned[0].stdout.emit('data', OGG);
  assert.ok(out.status().packetsOut > 0, 'audio packets were produced');
  assert.ok(out.status().bytesOut > 0);
  assert.equal(out.status().hasOpusHead, true);

  // A stalled encoder drops source frames rather than growing latency.
  spawned[0].stdin.writableLength = 1000;
  out.onFrame(Buffer.alloc(13 + 3840));
  assert.equal(out.status().droppedPcm, 1);
  assert.equal(out.status().active, true);

  await out.stop();
  assert.equal(out.active, false);
});
