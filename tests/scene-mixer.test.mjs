import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as helpers from '../lib/scenes.mjs';
import { createSceneController } from '../lib/scene-controller.mjs';
import { createLifecycleQueue } from '../lib/lifecycle.mjs';
import { tempoRideSteps } from '../lib/tempo-ride.mjs';
const source = '-- @scene {"cps":0.3}\nd1 $ s "bd"\nd16 $ s "hh"';

function fixture(config) {
  const registry = helpers.createSceneRegistry(config), queue = createLifecycleQueue();
  const writes = [], requests = [], queries = [], labels = [], timers = new Map();
  let clock = 0, timerId = 0, cps = 0.3, failStep = false, failRollback = false, failDeck, stepGate, failGain = false, oldRuntime = false;
  const controller = createSceneController({ ...helpers, registry, runtimePath: '/runtime/scenes.scd',
    ensure: async () => 'ready', ready: s => s === 'ready', writeRepl: code => writes.push(code),
    hush: () => writes.push('hush'), label: text => labels.push(text), enqueue: queue,
    now: () => clock, setTimer: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimer: id => timers.delete(id),
    queryRepl: async codes => {
      queries.push(codes.join('\n'));
      const command = codes.find(c => c.startsWith('setcps '));
      if (command) {
        cps = Number(command.slice(7));
        if (stepGate) { const gate = stepGate; stepGate = undefined; gate.entered(); await gate.wait; }
        if (failStep) { failStep = false; throw Error('lost tempo ack'); }
        if (failRollback) throw Error('disconnected');
      }
      return codes.join().includes('queryArc') ? '4' : codes.join().includes('getcps') ? String(cps) : '100';
    },
    sc: async fn => {
      const code = fn('"ACK"'); requests.push(code);
      if (oldRuntime && code.includes('gains].isNil')) throw Error('old SC scene runtime');
      if (failGain && code.includes('gains')) { failGain = false; throw Error('lost SC gain ack'); }
      if (failDeck && code.includes('prepare') && code.includes(`"${failDeck}"`)) throw Error('bad SC');
    },
  });
  return { registry, controller, writes, queries, requests, labels, timers, queue,
    action: params => queue(() => controller.action(params, '/tmp')),
    load: async decks => { for (const deck of decks) await queue(() => controller.activate(registry.plan(deck, `${deck}.tidal`, source))); },
    tick: async () => {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      clock = timer.at; timers.delete(id); timer.fn(); await queue(async () => {});
    },
    failStep: (rollback = false) => { failStep = true; failRollback = rollback; },
    failDeck: deck => { failDeck = deck; },
    failGain: () => { failGain = true; },
    oldRuntime: () => { oldRuntime = true; },
    advanceClock: milliseconds => { clock += milliseconds; },
    holdStep: () => {
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      stepGate = { entered, wait };
      return { started, release };
    },
  };
}

test('N channels allocate only N contexts for 26 letters and route K-orbit blocks', async () => {
  const f = fixture({ channelCount: 4, orbitsPerChannel: 2 });
  await f.load('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  assert.deepEqual(f.registry.channels, ['A', 'B', 'C', 'D']);
  assert.equal(f.requests.filter(r => r.includes('prepare')).length, 4);
  assert.equal(f.requests.filter(r => r.includes('install')).length, 1);
  assert.match(f.requests.find(r => r.includes('install')), /install\]\.value\("ACK", 4, 2\)/);
  for (const [i, deck] of [...'ABCD'].entries()) {
    const q = f.queries.find(q => q.includes(`p "piScene${deck}"`));
    assert.match(q, new RegExp(`# orbit ${i * 2}\\)`));
    assert.match(q, new RegExp(`# orbit ${i * 2 + 1}\\)`));
    assert.match(q, new RegExp(`"sceneSlot" ${i}.*orbit ${i * 2}`));
  }
  await f.action({ action: 'gain', channel: 2, gain: 0.25, seconds: 1 });
  assert.deepEqual(f.registry.gains, [1, 0, 0.25, 0]);
  await f.action({ action: 'mix', mix: 0.5 });
  assert.deepEqual(f.registry.gains, [0.5, 0.5, 0.25, 0]);
  await f.action({ action: 'select', deck: 'Z', slot: 3 });
  assert.deepEqual(f.registry.channels, ['A', 'B', 'C', 'Z']);
  assert.match(f.queries.findLast(q => q.includes('p "piSceneZ"')), /# orbit 6/);
  f.failDeck('Y');
  await assert.rejects(f.action({ action: 'select', deck: 'Y', slot: 2 }), /bad SC/);
  assert.deepEqual(f.registry.channels, ['A', 'B', 'C', 'Z']);
  assert.equal(f.registry.get('C').origin, 100);
  const snapshot = f.registry.snapshot();
  f.controller.resetTransport(); await f.queue(() => f.controller.restore());
  assert.deepEqual(f.registry.gains, snapshot.gains);
  assert.deepEqual(f.registry.channels, snapshot.channels);
  assert.match(await f.action({ action: 'status' }), /scene channels A\/B\/C\/Z/);
});

test('K literal orbit validation, config bounds and old snapshot shapes', () => {
  assert.deepEqual(helpers.parseScene(source, 2).lanes.map(l => l.orbit), [0, 1]);
  assert.equal(helpers.parseScene(source + '\nd2 $ s "sn" # orbit 10', 12).lanes.at(-1).orbit, 10);
  assert.throws(() => helpers.parseScene(source + '\nd2 $ s "sn" # orbit 2', 2), /0\.\.1/);
  for (const config of [{ channelCount: 1 }, { channelCount: 27 }, { channelCount: 2.5 }, { orbitsPerChannel: 0 }, { orbitsPerChannel: 17 }]) assert.throws(() => helpers.createSceneRegistry(config));
  const old = helpers.createSceneRegistry();
  old.commit(old.plan('A', 'A.tidal', source));
  old.setMix(0.2);
  assert.deepEqual(Object.keys(old.snapshot()), ['decks', 'mix', 'pair']);
  const expanded = helpers.createSceneRegistry({ channelCount: 4 });
  expanded.restoreSnapshot({ ...old.snapshot(), pair: ['B', 'A'] });
  assert.deepEqual(expanded.channels, ['B', 'A', 'C', 'D']);
  assert.deepEqual(expanded.gains, [0.8, 0.2, 0, 0]);
  old.restoreSnapshot({ decks: old.entries(), mix: 0.2 });
  assert.deepEqual(old.pair, ['A', 'B']);
  old.restoreSnapshot({ decks: old.entries(), pair: ['B', 'A'], mix: 0.2 });
  assert.deepEqual(old.pair, ['B', 'A']);
});

test('bounded linear tempo sequence reaches exact target without resetting phase', () => {
  const steps = tempoRideSteps(0.3, 0.6, 1, 4);
  assert.deepEqual(steps.map(s => s.at), [250, 500, 750, 1000]);
  assert.deepEqual(steps.map(s => s.cps), [0.375, 0.44999999999999996, 0.5249999999999999, 0.6]);
  assert.ok(steps.every(s => /^setcps /.test(s.command)));
  assert.equal(tempoRideSteps(0.6, 0.3, 300, 10).length, 3000);
  for (const args of [[0, 0.3, 1], [0.3, 5, 1], [0.3, 0.6, 0], [0.3, 0.6, 301], [0.3, 0.6, 1, 11]]) assert.throws(() => tempoRideSteps(...args));
});

test('morph steps both gain and the global tempo, preserves origins and persists effective cps', async () => {
  const f = fixture(); await f.load('AB');
  const before = f.writes.length, origins = f.registry.entries().map(([, r]) => r.origin);
  await f.action({ action: 'morph', from: 0, to: 1, toCps: 0.6, seconds: 1 });
  assert.equal(f.timers.size, 1);
  for (let i = 0; i < 4; i++) await f.tick();
  assert.equal(f.timers.size, 0);
  assert.equal(f.registry.tempoOverride, 0.6);
  assert.deepEqual(f.registry.gains, [0, 1]);
  assert.equal(f.registry.mix, 1);
  assert.deepEqual(f.registry.entries().map(([, r]) => r.origin), origins);
  assert.equal(f.writes.length, before);
  assert.deepEqual(f.queries.filter(q => q.startsWith('setcps ')).map(q => q.split('\n')[0]), tempoRideSteps(0.3, 0.6, 1).map(s => s.command));
  assert.match(await f.action({ action: 'status' }), /declared cps 0\.3, effective cps 0\.6/);
  const saved = f.registry.snapshot();
  const recovered = helpers.createSceneRegistry(); recovered.restoreSnapshot(saved);
  assert.equal(recovered.tempoOverride, 0.6);
  assert.equal(recovered.get('A').scene.cps, 0.3);
  // Unchanged source edits preserve declared metadata and effective tempo.
  await f.queue(() => f.controller.activate(f.registry.plan('A', 'A.tidal', source, false)));
  assert.equal(f.registry.tempoOverride, 0.6);
  f.controller.resetTransport();
  await f.queue(() => f.controller.restore());
  assert.ok(f.writes.includes('setcps 0.6'));
  assert.equal(f.registry.tempoOverride, 0.6);
  assert.deepEqual(f.registry.gains, [0, 1]);
  await f.load('C');
  await assert.rejects(f.action({ action: 'select', deck: 'C', slot: 1 }), /audible A runs at 0\.6/);
  assert.throws(() => f.registry.plan('B', 'B.tidal', source.replace('0.3', '0.4')), /effective tempo/);
  await f.action({ action: 'stop', deck: 'B' });
  await f.queue(() => f.controller.activate(f.registry.plan('A', 'A.tidal', source, true)));
  assert.equal(f.registry.tempoOverride, undefined); // legitimate lone restart
  await f.action({ action: 'leave' }); assert.equal(f.registry.tempoOverride, undefined);
});

test('cancel holds acknowledged cps/gain targets and invalidates even queued steps', async () => {
  const f = fixture(); await f.load('AB');
  await f.action({ action: 'morph', from: 0, to: 1, toCps: 0.6, seconds: 1 });
  await f.tick();
  assert.equal(f.registry.tempoOverride, 0.375);
  assert.deepEqual(f.registry.gains, [0.75, 0.25]);
  const message = await f.action({ action: 'cancel' });
  assert.match(message, /effective cps 0\.375, gains \[0\.75, 0\.25\]/);
  assert.equal(f.timers.size, 0);
  const before = f.queries.length;
  await f.action({ action: 'cancel' }); assert.equal(f.queries.length, before);
  await f.action({ action: 'morph', from: 0, to: 1, toCps: 0.6, seconds: 1 });
  const queued = [...f.timers.values()][0].fn;
  await f.action({ action: 'cancel' }); queued(); await f.queue(async () => {});
  assert.equal(f.queries.length, before + 1); // only morph's current-cps sample
  assert.equal(f.timers.size, 0);
});

test('failed ride compensates to last acknowledged targets and leaves no timers', async () => {
  const f = fixture(); await f.load('AB');
  await f.action({ action: 'morph', from: 0, to: 1, toCps: 0.6, seconds: 1 });
  await f.tick(); f.failStep(); await f.tick();
  assert.equal(f.timers.size, 0);
  assert.equal(f.registry.tempoOverride, 0.375);
  assert.deepEqual(f.registry.gains, [0.75, 0.25]);
  assert.match(f.labels.at(-1), /failed.*restored last acknowledged targets/);
  assert.match(f.queries.at(-1), /^setcps 0\.375/);
  await f.action({ action: 'morph', from: 0, to: 1, toCps: 0.6, seconds: 1 });
  f.failStep(true); await f.tick();
  assert.equal(f.timers.size, 0);
  assert.match(await f.action({ action: 'status' }), /transport state unconfirmed; recovery required/);
});

test('stop, select, gain, mix, activation, reset and leave cancel a running ride', async () => {
  for (const operation of ['stop', 'select', 'gain', 'mix', 'activation', 'reset', 'leave']) {
    const f = fixture(); await f.load('ABC');
    await f.action({ action: 'morph', from: 0, to: 1, toCps: 0.6, seconds: 1 });
    if (operation === 'activation') await f.queue(() => f.controller.activate(f.registry.plan('A', 'A.tidal', source, false)));
    else if (operation === 'reset') f.controller.resetTransport();
    else await f.action({ action: operation, deck: operation === 'select' ? 'C' : 'A', slot: 1, channel: 0, gain: 0.5, mix: 0.5 });
    assert.equal(f.timers.size, 0, operation);
  }
});

test('in-flight ride step and cancellation serialize on the scene queue', async () => {
  const f = fixture(); await f.load('AB');
  await f.action({ action: 'morph', from: 0, to: 1, toCps: 0.6, seconds: 1 });
  const held = f.holdStep();
  const step = f.tick(); await held.started;
  let cancelled = false;
  const cancellation = f.action({ action: 'cancel' }).then(result => { cancelled = true; return result; });
  await Promise.resolve(); assert.equal(cancelled, false);
  held.release(); await step;
  assert.match(await cancellation, /effective cps 0\.375/);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.registry.gains, [0.75, 0.25]);
});

test('slow steps stretch the ride without a catch-up burst; SC failures roll tempo back', async () => {
  const f = fixture(); await f.load('AB');
  await f.action({ action: 'morph', from: 0, to: 1, toCps: 0.6, seconds: 1 });
  const held = f.holdStep(); const first = f.tick(); await held.started;
  f.advanceClock(1000); held.release(); await first;
  const secondAt = [...f.timers.values()][0].at;
  await f.tick();
  const thirdAt = [...f.timers.values()][0].at;
  assert.ok(thirdAt - secondAt >= 250);
  f.failGain(); await f.tick();
  assert.equal(f.timers.size, 0);
  assert.equal(f.registry.tempoOverride, 0.44999999999999996);
  assert.deepEqual(f.registry.gains, [0.5, 0.5]);
  assert.match(f.labels.at(-1), /lost SC gain ack.*restored last acknowledged targets/);
});

test('restore failure keeps unrecovered source and configuration available for retry', async () => {
  const f = fixture({ channelCount: 3 }); await f.load('ABCZ');
  const previousC = f.registry.get('C');
  await f.action({ action: 'gain', channel: 2, gain: 0.2 });
  f.controller.resetTransport(); f.failDeck('C');
  await assert.rejects(f.queue(() => f.controller.restore()), /bad SC/);
  assert.deepEqual(f.registry.channels, ['A', 'B', 'C']);
  assert.deepEqual(f.registry.gains, [1, 0, 0.2]);
  assert.equal(f.registry.get('C'), previousC);
  assert.equal(f.registry.get('Z').text, source);
});

test('mixed-version default A/B works, but old SC faders reject morph before any tempo request', async () => {
  const f = fixture(); await f.load('AB'); f.oldRuntime();
  await f.action({ action: 'mix', mix: 0.5 });
  const before = f.queries.length;
  await assert.rejects(f.action({ action: 'morph', from: 0, to: 1, toCps: 0.6, seconds: 1 }), /old SC scene runtime/);
  assert.equal(f.queries.length, before);
  assert.equal(f.registry.tempoOverride, undefined);
  assert.equal(f.timers.size, 0);
  await assert.rejects(f.action({ action: 'gain', channel: 0, gain: 0.2 }), /old SC scene runtime/);
  assert.deepEqual(f.registry.gains, [0.5, 0.5]);
});

test('scene mixer geometry is declared by the project, not guessed', async () => {
  const { resolveSceneMixerConfig, DEFAULT_SCENE_MIXER, SCENE_MIXER_CONFIG_FILES } = await import('../lib/scene-mixer-config.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-mixer-config-'));
  const read = file => fs.readFileSync(file, 'utf8');
  try {
    // Default keeps the historical 2 x 6 geometry.
    assert.deepEqual(resolveSceneMixerConfig({ env: {}, cwd: dir, readFile: read }), { ...DEFAULT_SCENE_MIXER, source: 'default' });
    // Environment wins.
    assert.deepEqual(
      resolveSceneMixerConfig({ env: { PI_TIDAL_SCENE_CHANNELS: '3', PI_TIDAL_SCENE_ORBITS: '4' }, cwd: dir, readFile: read }),
      { channelCount: 3, orbitsPerChannel: 4, source: 'environment' });
    // Project file next to the DSP layer.
    fs.mkdirSync(path.join(dir, 'sc'), { recursive: true });
    fs.writeFileSync(path.join(dir, SCENE_MIXER_CONFIG_FILES[0]), '{"channels":4,"orbits":6}\n');
    assert.deepEqual(resolveSceneMixerConfig({ env: {}, cwd: dir, readFile: read }),
      { channelCount: 4, orbitsPerChannel: 6, source: path.join(dir, SCENE_MIXER_CONFIG_FILES[0]) });
    // The file's orbit count must equal what the startup gives SuperDirt.
    fs.writeFileSync(path.join(dir, SCENE_MIXER_CONFIG_FILES[0]), '{"channels":4,"orbits":6}');
    assert.equal(resolveSceneMixerConfig({ env: {}, cwd: dir, readFile: read }).channelCount * 6, 24);
    // Invalid values fail loudly rather than silently mis-routing.
    fs.writeFileSync(path.join(dir, SCENE_MIXER_CONFIG_FILES[0]), '{"channels":1}');
    assert.throws(() => resolveSceneMixerConfig({ env: {}, cwd: dir, readFile: read }), /2\.\.26/);
    fs.writeFileSync(path.join(dir, SCENE_MIXER_CONFIG_FILES[0]), 'not json');
    assert.throws(() => resolveSceneMixerConfig({ env: {}, cwd: dir, readFile: read }), /is invalid/);
    assert.throws(() => resolveSceneMixerConfig({ env: { PI_TIDAL_SCENE_CHANNELS: '31' }, cwd: dir, readFile: read }), /2\.\.26/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
