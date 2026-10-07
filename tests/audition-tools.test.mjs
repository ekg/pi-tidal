import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuditionArgs,
  parseAuditionSubmitId,
  parseAuditionReport,
  parseAuditionJobs,
  parseAuditionStatus,
  parseSpectrumReport,
  parseOrbitScanReport,
  buildLiveReport,
  liveSnapshotPath,
  isAuditionStillRunning,
  AUDITION_CLI_ACTIONS,
  AUDITION_ACTIONS,
} from '../lib/audition-tools.mjs';

// Fixtures are the exact shapes tools/audition/audition-ctl prints per the
// frozen protocol in docs/stream-audition.md.

test('buildAuditionArgs covers the frozen CLI verbs', () => {
  assert.deepEqual(buildAuditionArgs('start'), ['start']);
  assert.deepEqual(buildAuditionArgs('stop'), ['stop']);
  assert.deepEqual(buildAuditionArgs('status'), ['status']);
  assert.deepEqual(buildAuditionArgs('submit', { scene: '/x/159.tidal' }), ['submit', '/x/159.tidal']);
  assert.deepEqual(
    buildAuditionArgs('submit', { scene: '/x/159.tidal', slot: 2, cps: 0.5, cycles: 8, withLive: true }),
    ['submit', '/x/159.tidal', '--slot', '2', '--cps', '0.5', '--cycles', '8', '--with-live'],
  );
  assert.deepEqual(buildAuditionArgs('report', { id: 'job-1' }), ['report', 'job-1']);
  assert.deepEqual(buildAuditionArgs('jobs'), ['jobs']);
  assert.deepEqual(buildAuditionArgs('jobs', { limit: 5 }), ['jobs', '--limit', '5']);
  // snapshotLive is not a CLI verb — it is in-process only.
  assert.deepEqual(AUDITION_ACTIONS, [...AUDITION_CLI_ACTIONS, 'snapshotLive']);
  assert.throws(() => buildAuditionArgs('snapshotLive'), /unknown audition action/);
  assert.throws(() => buildAuditionArgs('submit', {}), /requires a scene/);
  assert.throws(() => buildAuditionArgs('report', {}), /requires an id/);
});

test('parseAuditionSubmitId reads the single id line', () => {
  assert.equal(parseAuditionSubmitId('a1b2c3\n'), 'a1b2c3');
  assert.equal(parseAuditionSubmitId('\n  a1b2c3  \n'), 'a1b2c3');
  assert.equal(parseAuditionSubmitId(''), null);
});

test('parseAuditionReport passes the raw report JSON through', () => {
  const report = {
    id: 'a1b2c3', ok: true, error: null, state: 'done', startedMs: 0, finishedMs: 1200,
    cps: 0.5, slot: 2, renderCycles: 8, withLive: false,
    master: { peak: 0.9, rms: 0.2, headroomDb: 3.0 },
    bands: { sub: 0.3, bass: 0.2, lowmid: 0.15, mid: 0.15, highmid: 0.1, top: 0.1 },
    dominantHz: 180, chroma: Array(12).fill(0.1), key: 'D minor', dissonance: 0.2,
    decks: [], diffVsLive: { available: false, note: 'no live.json' },
  };
  assert.deepEqual(parseAuditionReport(JSON.stringify(report), { exitCode: 0 }), report);
});

test('exit 3 means still running and never throws on empty stdout', () => {
  assert.equal(isAuditionStillRunning(3), true);
  assert.equal(isAuditionStillRunning(0), false);
  const running = parseAuditionReport('{"ok":false,"state":"running"}\n', { exitCode: 3 });
  assert.deepEqual(running, { ok: false, state: 'running' });
  // defensive: exit 3 with unparseable/empty stdout still reports running
  assert.deepEqual(parseAuditionReport('', { exitCode: 3 }), { ok: false, state: 'running', exitCode: 3 });
  // unknown id: non-zero, non-3, unparseable -> null (caller surfaces the error)
  assert.equal(parseAuditionReport('audition-ctl: unknown job\n', { exitCode: 1 }), null);
});

test('parseAuditionJobs reads one id/state/createdISO/scene per line', () => {
  const text = [
    'a1b2c3 done 2026-10-07T12:00:00Z /home/erik/livecode/159.tidal',
    'd4e5f6 running 2026-10-07T12:01:00Z /home/erik/livecode/160.tidal',
    '',
  ].join('\n');
  assert.deepEqual(parseAuditionJobs(text), [
    { id: 'a1b2c3', state: 'done', createdISO: '2026-10-07T12:00:00Z', scene: '/home/erik/livecode/159.tidal' },
    { id: 'd4e5f6', state: 'running', createdISO: '2026-10-07T12:01:00Z', scene: '/home/erik/livecode/160.tidal' },
  ]);
  assert.deepEqual(parseAuditionJobs(''), []);
});

test('parseAuditionStatus reads the label/value lines', () => {
  const parsed = parseAuditionStatus([
    'scsynth: up (57111)',
    'superdirt: up (57121)',
    'graph: ok',
    'repl: ready',
    'owned pids: sclang:1234 repl:5678',
  ].join('\n'));
  assert.equal(parsed.scsynth, 'up (57111)');
  assert.equal(parsed.graph, 'ok');
  assert.equal(parsed.repl, 'ready');
  assert.equal(parsed['owned pids'], 'sclang:1234 repl:5678');
});

test('parseOrbitScanReport turns ~orbitScanReport lines into deck readings', () => {
  const raw = [
    'deck scan: metering 3 (master + scene channels). Read a moment later.',
    '--- orbit scan 2026-10-07 12:00:00  (rms / dominant Hz / L-M-H %)',
    'master  -30dB  180Hz  60/30/10',
    'ch0     -42dB  90Hz  80/15/5',
    'ch1     -55dB  2000Hz  10/40/50',
  ].join('\n');
  assert.deepEqual(parseOrbitScanReport(raw), [
    { name: 'master', rmsDb: -30, dominantHz: 180, low: 60, mid: 30, high: 10 },
    { name: 'ch0', rmsDb: -42, dominantHz: 90, low: 80, mid: 15, high: 5 },
    { name: 'ch1', rmsDb: -55, dominantHz: 2000, low: 10, mid: 40, high: 50 },
  ]);
  assert.deepEqual(parseOrbitScanReport('orbit scan: not started'), []);
});

test('parseSpectrumReport turns ~spectrumReport lines into 6-band shares + master rms/peak', () => {
  const raw = [
    '--- spectrum report 2026-10-07 12:00:00 ---',
    'master   rms -21.0 dB   peak -12.0 dB   ceiling-use 0.31 (31.0)',
    'master  rms -21.0   low-end 62.3%   shares 31.8 27.1 23.5 11.9 4.0 1.8',
    'ch0     rms -33.0   low-end 80.0%   shares 80 15 5 0 0 0',
  ].join('\n');
  const { sources, masterSummary } = parseSpectrumReport(raw);
  assert.equal(masterSummary.rmsDb, -21);
  assert.equal(masterSummary.peakDb, -12);
  assert.equal(masterSummary.headroomDb, 12);
  assert.equal(sources.length, 2);
  assert.deepEqual(Object.keys(sources[0].bands), ['sub', 'bass', 'lowmid', 'mid', 'highmid', 'top']);
  assert.ok(Math.abs(sources[0].bands.sub - 0.318) < 0.001);
  assert.ok(Math.abs(Object.values(sources[0].bands).reduce((a, b) => a + b, 0) - 1) < 1e-6);
  assert.equal(sources[1].name, 'ch0');
  assert.deepEqual(parseSpectrumReport('spectrum: not started').sources, []);
});

test('buildLiveReport emits 6-band master.bands (what diffVsLive needs) and keeps raw', () => {
  const raw = [
    'master   rms -21.0 dB   peak -12.0 dB   ceiling-use 0.31 (31.0)',
    'master  rms -21.0   low-end 62.3%   shares 31.8 27.1 23.5 11.9 4.0 1.8',
    'ch0     rms -33.0   low-end 80.0%   shares 80 15 5 0 0 0',
  ].join('\n');
  const spectrum = parseSpectrumReport(raw);
  const orbit = parseOrbitScanReport('master  -30dB  180Hz  60/30/10\nch0  -42dB  90Hz  80/15/5');
  const report = buildLiveReport({ spectrum, orbit, raw, takenMs: 1_700_000_000_000 });
  assert.equal(report.ok, true);
  assert.equal(report.takenISO, new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(Object.keys(report.master.bands), ['sub', 'bass', 'lowmid', 'mid', 'highmid', 'top']);
  assert.equal(report.master.dominantHz, 180);
  assert.equal(report.master.peakDb, -12);
  assert.equal(report.master.headroomDb, 12);
  assert.ok(report.master.peak > 0.25 && report.master.peak < 0.26);
  assert.equal(report.decks.length, 2);
  assert.equal(report.raw, raw);
  // no spectrum readings => not ok: a 3-way-only snapshot must never look usable
  assert.equal(buildLiveReport({ spectrum: { sources: [], masterSummary: null }, orbit, raw }).ok, false);
});

test('liveSnapshotPath honours PI_TIDAL_AUDITION_DIR and defaults under the home dir', () => {
  assert.equal(
    liveSnapshotPath({ env: { PI_TIDAL_AUDITION_DIR: '/tmp/aud' }, homedir: '/home/x' }),
    '/tmp/aud/reports/live.json',
  );
  assert.equal(liveSnapshotPath({ env: {}, homedir: '/home/x' }), '/home/x/livecode/sc/audition/reports/live.json');
});
