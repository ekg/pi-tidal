import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as helpers from '../lib/scenes.mjs';
import { createSceneController } from '../lib/scene-controller.mjs';
import { tidalStatements } from '../lib/tidal-chunks.mjs';
const { extractSc, parseScene, sceneCommands, patternExpression, createSceneRegistry, isSceneFile, deckIndex } = helpers;
const source = `-- @scene {"cps":0.3}
{- @sc
scene[\\mod].value({ |cycles| [2000 + cycles.sin, 0.1, 0.1, 1] });

// a blank line inside SC must not split the block
-}
let gentle = (# gain 0.4)
d1 $ gentle $ s "bd ~ bd ~" # orbit 0
d7 $ n "<c4 e4>" # s "hoRhodes" # orbit 5
`;

test('embedded SC extraction preserves blank lines and never forwards SC to GHCi', () => {
  const { sc, tidal } = extractSc(source);
  assert.equal(sc.length, 1);
  assert.match(sc[0], /blank line inside SC/);
  assert.ok(!tidal.includes('scene['));
  assert.ok(isSceneFile(source));
  assert.deepEqual(parseScene(source).lanes.map(x => x.orbit), [0, 5]);
});

test('lexer ignores markers inside strings and line comments; ordinary comments nest', () => {
  const text = '-- ignored {- @sc\nd1 $ s "{- @sc not code -}"\n{- comment {- nested -} -}';
  assert.equal(extractSc(text).sc.length, 0);
  assert.throws(() => extractSc('{- @sc missing end'), /Unterminated/);
  assert.equal(isSceneFile('d1 $ s "-- @scene {}"'), false);
});

test('multiple SC blocks join into one scene-owned setup closure', () => {
  assert.match(parseScene(source + '\n{- @sc\n// second setup\n-}').sc, /second setup/);
});

test('metadata validation rejects unknown settings and invalid tempo/quantization', () => {
  for (const options of [{}, {cps:0}, {cps:-1}, {cps:5}, {cps:'0.3'}, {cps:0.3, quantize:0}, {cps:0.3, quantize:1.5}, {cps:0.3, surprise:true}]) {
    assert.throws(() => parseScene(`-- @scene ${JSON.stringify(options)}\nd1 $ s "bd"`));
  }
  assert.throws(() => parseScene('d1 $ s "bd"'), /exactly one/);
  assert.throws(() => parseScene(source + '-- @scene {"cps":0.3}'), /exactly one/);
});

test('scene parser rejects commands, duplicate lanes, no lanes, and out-of-deck orbits', () => {
  for (const statement of ['hush', 'setcps 1', 'd17 $ s "bd"', 'd1 $ s "bd" # orbit 6', 'd1 $ s "bd" # orbit "0 1"', 'd1 $ s "bd" # orbit (pure 1)']) {
    assert.throws(() => parseScene('-- @scene {"cps":0.3}\n' + statement));
  }
  assert.throws(() => parseScene(source + '\nd1 $ s "sn"'), /unique/);
  assert.throws(() => parseScene('-- @scene {"cps":0.3}\n{- @sc 1.postln -}'), /no d1/);
});

test('local let and multiline pattern bodies remain expressions, not global helpers', () => {
  const scene = parseScene('-- @scene {"cps":0.3}\nlet fx = (# gain 0.4)\nd1 $ fx $ stack [\n  s "bd",\n  s "sn"\n  ]');
  const expression = patternExpression(scene, 'A');
  assert.match(expression, /let \{ fx/);
  assert.match(expression, /stack \[/);
});

test('decks force isolated routing; names d1..d16 do not collide across decks', () => {
  const scene = parseScene(source);
  assert.match(patternExpression(scene, 'A'), /# orbit 0/);
  assert.match(patternExpression(scene, 'B'), /# orbit 6/);
  assert.match(patternExpression(scene, 'B'), /# orbit 11/);
  assert.throws(() => patternExpression(scene, 'C'), /not in the active pair/);
  const defaults = parseScene('-- @scene {"cps":0.3}\nd1 $ s "bd"\nd16 $ s "hh"');
  assert.deepEqual(defaults.lanes.map(l => l.orbit), [0, 5]);
});

test('identifiers A..Z name decks; anything else is rejected', () => {
  assert.equal(deckIndex('A'), 0);
  assert.equal(deckIndex('Z'), 25);
  for (const bad of ['a', 'AA', '', '2', '#', null, 0]) assert.throws(() => deckIndex(bad), /letter A..Z/);
  const registry = createSceneRegistry();
  assert.throws(() => registry.plan('ab', 'x.tidal', source), /letter A..Z/);
  assert.throws(() => registry.stop('1'), /letter A..Z/);
});

test('orbit ownership follows the pair position, not the letter', () => {
  const scene = parseScene(source);
  // C selected into the B-side owns the same six orbits B did.
  assert.match(patternExpression(scene, 'C', ['A', 'C']), /# orbit 6/);
  assert.match(patternExpression(scene, 'C', ['A', 'C']), /# orbit 11/);
  // Z on the A-side owns orbits 0-5.
  assert.match(patternExpression(scene, 'Z', ['Z', 'B']), /# orbit 0/);
  assert.throws(() => patternExpression(scene, 'Z', ['A', 'B']), /not in the active pair/);
  const clockC = sceneCommands(scene, 'C', 9, { pair: ['A', 'C'] })[2];
  assert.match(clockC, /piSceneClockC/);
  assert.match(clockC, /"sceneSlot" 1/);
  assert.match(clockC, /orbit 6/);
  const clockZ = sceneCommands(scene, 'Z', 1, { pair: ['Z', 'B'] })[2];
  assert.match(clockZ, /"sceneSlot" 0/);
  assert.match(clockZ, /orbit 0/);
  assert.match(sceneCommands(scene, 'C', 9, { pair: ['A', 'C'] })[1], /p "piSceneC"/);
});

test('restart quantizes a future origin; edit does not redefine it; both rebase tick and notes', () => {
  const scene = parseScene(source);
  const restart = sceneCommands(scene, 'A', 7);
  assert.match(restart[0], /getnow/);
  assert.match(restart[0], /ceiling/);
  assert.ok(!restart.join('\n').includes('setCycle'));
  assert.match(restart[1], /filterWhen.*rotR piSceneOriginA/);
  assert.match(restart[2], /sig fromRational/);
  assert.match(restart[2], /sceneEpoch.*7/);
  assert.equal(sceneCommands(scene, 'A', 8, {restart:false}).length, 2);
  assert.match(sceneCommands(scene, 'B', 1)[2], /sceneSlot.*1.*orbit 6/);
});

test('registry snapshots, ownership and tempo rules', () => {
  const registry = createSceneRegistry();
  const a = registry.plan('A', 'one.tidal', source);
  registry.commit(a);
  const edit = registry.plan('A', 'one.tidal', source, false);
  assert.equal(edit.restart, false);
  assert.ok(edit.epoch > a.epoch);
  assert.throws(() => registry.plan('B', 'two.tidal', source.replace('0.3}', '0.4}')), /share one tempo/);
  assert.throws(() => registry.plan('A', 'one.tidal', source.replace('0.3}', '0.4}'), false), /explicit scene restart/);
  registry.commit(registry.plan('B', 'two.tidal', source));
  registry.setMix(0.5);
  assert.equal(registry.mix, 0.5);
  assert.throws(() => registry.setMix(NaN));
  registry.stop('A');
  assert.equal(registry.get('A'), undefined);
  assert.equal(registry.get('B').text, source);
  registry.clear();
  assert.equal(registry.entries().length, 0);
});

test('parked decks keep their own tempo; pair position is explicit and reversible', () => {
  const registry = createSceneRegistry();
  registry.commit(registry.plan('A', 'one.tidal', source));
  registry.commit(registry.plan('B', 'two.tidal', source));
  // C is parked: it is not audible, so a different cps is allowed until selected.
  const parked = registry.plan('C', 'three.tidal', source.replace('0.3}', '0.4}'));
  assert.equal(parked.restart, true);
  registry.commit(parked);
  assert.equal(registry.entries().length, 3);
  assert.deepEqual(registry.pair, ['A', 'B']);
  registry.setPair(1, 'C');
  assert.deepEqual(registry.pair, ['A', 'C']);
  // Pair decks share tempo: reloading C at 0.4 while A runs 0.3 is rejected.
  assert.throws(() => registry.plan('C', 'three.tidal', source.replace('0.3}', '0.4}'), true), /share one tempo/);
  assert.throws(() => registry.setPair(0, 'C'), /two different decks/);
  assert.throws(() => registry.setPair(2, 'D'), /pair position/);
  assert.throws(() => registry.setPair(0, 'c'), /letter A..Z/);
  registry.clear();
  assert.deepEqual(registry.pair, ['A', 'B']);
  assert.equal(registry.entries().length, 0);
});

test('pair snapshots restore atomically without aliases or partial invalid updates', () => {
  const registry = createSceneRegistry();
  registry.restorePair(['B', 'A']);
  assert.deepEqual(registry.pair, ['B', 'A']);
  const pair = ['B', 'C'];
  registry.restorePair(pair);
  pair[0] = 'Z';
  for (const invalid of [null, 'AB', [], ['A'], ['A', 'A'], ['B', 'bad']]) {
    assert.throws(() => registry.restorePair(invalid));
    assert.deepEqual(registry.pair, ['B', 'C']);
  }
});

test('SC runtime defaults to two slots, allocates only N chains and requires N*K orbits', () => {
  const sc = fs.readFileSync(new URL('../sc/scenes.scd', import.meta.url), 'utf8');
  assert.match(sc, /channelCount: 2, orbitsPerChannel: 6/);
  assert.match(sc, /Array\.newClear\(channelCount\)/);
  assert.match(sc, /manager\[\\channelCount\]\.do \{ \|slot\|/);
  assert.match(sc, /orbits\.size < \(channelCount \* orbitsPerChannel\)/);
  assert.match(sc, /slot \* manager\[\\orbitsPerChannel\]/);
  assert.match(sc, /install: \{ \|token, channelCount = 2, orbitsPerChannel = 6\|/);
  assert.match(sc, /warp: \\lin\)\.sqrt/);
  assert.ok(!sc.includes('Array.newClear(26)'));
  // The runtime accepts a logical deck letter and reports it, not a raw slot.
  assert.match(sc, /prepare: \{ \|slot, epoch, restart, source, token, deck\|/);
  assert.match(sc, /context\[\\deck\] = deck/);
  assert.match(sc, /format\(name/);
});

test('legacy do and continuation blocks remain intact while independent statements split', () => {
  assert.deepEqual(tidalStatements('do\n  setcps 0.3\n  d1 $ s "bd"\nd2 $ s "sn"'), ['do\n  setcps 0.3\n  d1 $ s "bd"', 'd2 $ s "sn"']);
  assert.deepEqual(tidalStatements('-- header\nd1 $ s "bd"\n  # gain 0.4'), ['d1 $ s "bd"\n  # gain 0.4']);
});

function fixture() {
  const registry = createSceneRegistry(), writes = [], requests = [], queries = [], labels = [];
  let failSc = false, failScDeck = null, failActivation = false, failStop = false;
  const controller = createSceneController({ ...helpers, registry, runtimePath:'/runtime/scenes.scd',
    ensure: async () => 'stack ready', ready: s => s === 'stack ready',
    writeRepl: code => writes.push(code), hush: () => writes.push('hush'), label: x => labels.push(x),
    queryRepl: async codes => { queries.push(codes.join('\n')); return codes.join().includes('queryArc') ? '4' : codes.join().includes('getcps') ? '0.3' : failActivation ? '(no output captured)' : '100.0'; },
    sc: async fn => {
      const code = fn('"ACK"'); requests.push(code);
      if (failStop && code.includes('stop].value')) { failStop = false; throw Error('stop failed'); }
      if (failSc && code.includes('prepare') && (!failScDeck || code.includes(`"${failScDeck}"`))) throw Error('bad SC');
    },
  });
  return { registry, writes, requests, queries, controller, labels,
    failSc: () => {failSc = true;}, failScFor: deck => {failSc = true; failScDeck = deck;}, failActivation: () => {failActivation = true;},
    failNextStop: () => {failStop = true;} };
}

test('controller loads once, preserves phase on edit, isolates stop, leaves routing clean', async () => {
  const f = fixture();
  await f.controller.activate(f.registry.plan('A', 'a.tidal', source));
  await f.controller.activate(f.registry.plan('B', 'b.tidal', source));
  assert.equal(f.writes.filter(x => x === 'hush').length, 1);
  const before = f.writes.length;
  await f.controller.activate(f.registry.plan('A', 'a.tidal', source, false));
  assert.ok(!f.writes.slice(before).some(x => x.includes('<- getnow')));
  await f.controller.action({action:'mix',mix:0.5,cycles:4}, '/tmp');
  assert.equal(f.registry.mix, 0.5);
  assert.match(f.requests.at(-1), /13\.333/);
  await f.controller.stop('A');
  assert.ok(f.registry.get('B'));
  assert.ok(!f.writes.slice(-2).join().includes('piSceneB'));
  await f.controller.leave();
  assert.match(f.requests.at(-1), /dispose/);
  assert.equal(f.controller.runtimeReady, false);
});

test('SC compile failure cannot commit a new scene or replace its last good snapshot', async () => {
  const f = fixture();
  await f.controller.activate(f.registry.plan('A', 'a.tidal', source));
  const old = f.registry.get('A');
  f.failSc();
  await assert.rejects(f.controller.activate(f.registry.plan('A', 'a.tidal', source + '\n-- bad edit', false)), /bad SC/);
  assert.equal(f.registry.get('A'), old);
});

test('failed activation cancels pending SC and restores the old origin/patterns', async () => {
  const f = fixture();
  await f.controller.activate(f.registry.plan('A', 'a.tidal', source));
  const old = f.registry.get('A');
  f.failActivation();
  await assert.rejects(f.controller.activate(f.registry.plan('A', 'a.tidal', source)), /not acknowledged/);
  assert.equal(f.registry.get('A'), old);
  assert.match(f.requests.at(-1), /cancel/);
  assert.ok(f.writes.includes('let piSceneOriginA = 100 :: Rational'));
});

test('recovery replays saved SC + patterns, restarts origins, and restores mix', async () => {
  const f = fixture();
  await f.controller.activate(f.registry.plan('A', 'a.tidal', source));
  await f.controller.activate(f.registry.plan('B', 'b.tidal', source));
  f.registry.setMix(0.65);
  f.controller.resetTransport();
  const before = f.writes.length;
  await f.controller.restore();
  assert.equal(f.registry.entries().length, 2);
  assert.equal(f.registry.mix, 0.65);
  assert.equal(f.writes.slice(before).filter(x => x.includes('<- getnow')).length, 2);
  assert.match(f.requests.at(-1), /mix.*0\.65/);
});

test('saving inactive files is not loading them; explicit action reads requested path', async () => {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-file-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.tidal'), source);
    assert.equal(f.registry.entries().length, 0);
    await f.controller.action({action:'load',deck:'A',file:'a.tidal'}, dir);
    assert.equal(f.registry.get('A').file, path.join(dir, 'a.tidal'));
    await assert.rejects(f.controller.action({action:'mix',mix:1}, dir), /Load the deck/);
    assert.ok((await f.controller.action({action:'status'}, dir)).includes('a.tidal'));
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('26 decks load; only the active pair runs patterns, SC contexts or hush', async () => {
  const f = fixture();
  await f.controller.activate(f.registry.plan('A', 'a.tidal', source));
  await f.controller.activate(f.registry.plan('B', 'b.tidal', source));
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    await f.controller.activate(f.registry.plan(letter, `${letter.toLowerCase()}.tidal`, source));
  }
  assert.equal(f.registry.entries().length, 26);
  // Parked decks get no SC context, no mixer, no render chain.
  assert.equal(f.requests.filter(r => r.includes('prepare')).length, 2);
  assert.equal(f.requests.filter(r => r.includes('install')).length, 1);
  assert.equal(f.writes.filter(x => x === 'hush').length, 1);
  // Parked decks never start pattern or clock streams (queries carry the p-commands).
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    assert.ok(!f.queries.some(q => q.includes(`p "piScene${letter}"`)), letter);
  }
  assert.ok(f.queries.some(q => q.includes('p "piSceneA" $')));
  assert.ok(f.queries.some(q => q.includes('p "piSceneB" $')));
  // Their Haskell is still validated at load time.
  assert.ok(f.writes.some(w => w.includes('let piSceneCandidateZ')));
  assert.deepEqual(f.registry.pair, ['A', 'B']);
  const status = await f.controller.action({action: 'status'}, '/tmp');
  assert.match(status, /pair A \(mix 0\) \/ B \(mix 1\)/);
  assert.match(status, /Z: z\.tidal, epoch \d+ \(parked\)/);
  assert.match(status, /A: a\.tidal, epoch \d+, origin 100/);
  // The default A/B mix action stays unchanged with a full registry.
  const message = await f.controller.action({action: 'mix', mix: 0.5, cycles: 0}, '/tmp');
  assert.match(message, /A=0, B=1/);
});

test('selecting a parked deck parks the displaced deck and routes by pair slot', async () => {
  const f = fixture();
  await f.controller.activate(f.registry.plan('A', 'a.tidal', source));
  await f.controller.activate(f.registry.plan('B', 'b.tidal', source));
  await f.controller.activate(f.registry.plan('C', 'c.tidal', source)); // parked
  const message = await f.controller.action({action: 'select', deck: 'C', slot: 1}, '/tmp');
  assert.match(message, /selected into mix position 1/);
  assert.match(message, /B parked/);
  assert.deepEqual(f.registry.pair, ['A', 'C']);
  // B keeps its record (parked, not stopped) and its runtime is released.
  assert.ok(f.registry.get('B'));
  assert.ok(f.writes.includes('p "piSceneB" silence'));
  assert.ok(f.writes.includes('p "piSceneClockB" silence'));
  assert.ok(f.requests.some(r => r.includes('stop].value(1)')));
  // C takes over the slot-1 SC context with its own letter.
  const prepare = f.requests.filter(r => r.includes('prepare')).at(-1);
  assert.match(prepare, /\.value\(1, /);
  // ACK must keep the old fifth argument position across SC/plugin versions.
  assert.match(prepare, /, "ACK", "C"\)/);
  assert.ok(f.queries.some(q => q.includes('p "piSceneC" $') && q.includes('# orbit 6')));
  assert.ok(f.queries.some(q => q.includes('piSceneClockC') && q.includes('"sceneSlot" 1')));
  // The crossfade now speaks in pair letters, and A is untouched.
  const mix = await f.controller.action({action: 'mix', mix: 1, cycles: 0}, '/tmp');
  assert.match(mix, /A=0, C=1/);
  const bAgain = f.writes.filter(w => w.includes('p "piSceneA" silence'));
  assert.equal(bAgain.length, 0);
});

test('a failed select rolls back the pair and restores the displaced deck', async () => {
  const f = fixture();
  await f.controller.activate(f.registry.plan('A', 'a.tidal', source));
  await f.controller.activate(f.registry.plan('B', 'b.tidal', source));
  await f.controller.activate(f.registry.plan('C', 'c.tidal', source));
  f.failScFor('C');
  await assert.rejects(f.controller.action({action: 'select', deck: 'C', slot: 1}, '/tmp'), /bad SC/);
  assert.deepEqual(f.registry.pair, ['A', 'B']);
  // B was parked before the new deck claimed the slot, and B was restored after.
  const stopAt = f.requests.findIndex(r => r.includes('stop].value(1)'));
  const prepareC = f.requests.findIndex(r => r.includes('prepare') && r.includes('"C"'));
  const restoreB = f.requests.findLastIndex(r => r.includes('prepare') && r.includes('"B"'));
  assert.ok(stopAt >= 0 && stopAt < prepareC, 'displaced deck parked before the new one claims the slot');
  assert.ok(prepareC < restoreB, 'failed activation rolls back before the audible deck is restored');
  assert.ok(f.writes.includes('p "piSceneB" silence'));
  assert.ok(f.queries.some(q => q.includes('p "piSceneB" $')));;
  // C's parked record survives for another attempt.
  assert.ok(f.registry.get('C'));
  assert.equal(f.registry.get('B').origin, 100);
});

test('a failed displaced-slot release restores its silenced pattern', async () => {
  const f = fixture();
  for (const deck of 'ABC') await f.controller.activate(f.registry.plan(deck, `${deck}.tidal`, source));
  const previousB = f.registry.get('B');
  f.failNextStop();
  await assert.rejects(f.controller.action({action: 'select', deck: 'C', slot: 1}, '/tmp'), /stop failed/);
  assert.deepEqual(f.registry.pair, ['A', 'B']);
  assert.ok(f.registry.get('B').epoch > previousB.epoch, 'B was restarted after its streams were silenced');
  assert.match(f.requests.at(-1), /, "ACK", "B"\)/);
});

test('recovery can restore B/A with a different-tempo parked deck', async () => {
  const f = fixture();
  f.registry.restorePair(['B', 'A']);
  for (const deck of 'BA') await f.controller.activate(f.registry.plan(deck, `${deck}.tidal`, source));
  await f.controller.activate(f.registry.plan('C', 'c.tidal', source.replace('0.3}', '0.4}')));
  f.controller.resetTransport();
  const before = f.requests.length;
  await f.controller.restore();
  assert.deepEqual(f.registry.pair, ['B', 'A']);
  assert.equal(f.registry.entries().length, 3);
  assert.equal(f.requests.slice(before).filter(r => r.includes('prepare')).length, 2);
  assert.equal(f.registry.get('C').scene.cps, 0.4);
});

test('select validates slots, letters, loaded decks, duplicates and tempo conflicts', async () => {
  const f = fixture();
  await f.controller.activate(f.registry.plan('A', 'a.tidal', source));
  await f.controller.activate(f.registry.plan('B', 'b.tidal', source));
  await assert.rejects(f.controller.action({action: 'select', deck: 'C', slot: undefined}, '/tmp'), /pair position/);
  await assert.rejects(f.controller.action({action: 'select', deck: 'C', slot: 2}, '/tmp'), /pair position/);
  await assert.rejects(f.controller.action({action: 'select', deck: 'AB', slot: 1}, '/tmp'), /letter A..Z/);
  await assert.rejects(f.controller.action({action: 'select', deck: 'C', slot: 1}, '/tmp'), /Load deck C/);
  await assert.rejects(f.controller.action({action: 'select', deck: 'B', slot: 0}, '/tmp'), /already audible at mix position 1/);
  assert.match(await f.controller.action({action: 'select', deck: 'A', slot: 0}, '/tmp'), /already holds mix position 0/);
  // A parked deck at another tempo cannot join while A is audible...
  await f.controller.activate(f.registry.plan('D', 'd.tidal', source.replace('0.3}', '0.4}')));
  await assert.rejects(f.controller.action({action: 'select', deck: 'D', slot: 1}, '/tmp'), /runs at 0\.4 cps but audible A runs at 0\.3/);
  // ...and the failed attempt must not have silenced or freed B.
  assert.ok(!f.writes.includes('p "piSceneB" silence'));
  assert.ok(!f.requests.some(r => r.includes('stop].value')));
  assert.deepEqual(f.registry.pair, ['A', 'B']);
});

test('stopping a parked deck drops its record without touching the pair slot', async () => {
  const f = fixture();
  await f.controller.activate(f.registry.plan('A', 'a.tidal', source));
  await f.controller.activate(f.registry.plan('C', 'c.tidal', source));
  const message = await f.controller.action({action: 'stop', deck: 'C'}, '/tmp');
  assert.match(message, /deck C stopped/);
  assert.equal(f.registry.get('C'), undefined);
  assert.deepEqual(f.registry.pair, ['A', 'B']);
  assert.ok(!f.requests.some(r => r.includes('stop].value')));
  // B holds pair position 1 while unloaded: stopping it clears that slot only.
  await f.controller.action({action: 'stop', deck: 'B'}, '/tmp');
  assert.ok(f.requests.some(r => r.includes('stop].value(1)')));
  assert.equal(f.registry.get('B'), undefined);
});

test('recovery restores the pair audibly and parked decks without DSP', async () => {
  const f = fixture();
  await f.controller.activate(f.registry.plan('A', 'a.tidal', source));
  await f.controller.activate(f.registry.plan('B', 'b.tidal', source));
  await f.controller.activate(f.registry.plan('C', 'c.tidal', source));
  await f.controller.action({action: 'select', deck: 'C', slot: 1}, '/tmp');
  await f.controller.activate(f.registry.plan('D', 'd.tidal', source)); // parked
  f.registry.setMix(0.7);
  const preparesBefore = f.requests.filter(r => r.includes('prepare')).length;
  f.controller.resetTransport();
  const before = f.writes.length;
  await f.controller.restore();
  assert.deepEqual(f.registry.pair, ['A', 'C']);
  assert.equal(f.registry.mix, 0.7);
  // Only the two pair decks restart their origins; B and D stay parked.
  assert.equal(f.writes.slice(before).filter(x => x.includes('<- getnow')).length, 2);
  assert.ok(f.writes.slice(before).some(x => x.includes('piSceneOriginA <- getnow')));
  assert.ok(f.writes.slice(before).some(x => x.includes('piSceneOriginC <- getnow')));
  assert.equal(f.requests.filter(r => r.includes('prepare')).length - preparesBefore, 2);
  assert.ok(!f.writes.slice(before).some(x => x.includes('p "piSceneB" $')));
  assert.ok(!f.writes.slice(before).some(x => x.includes('p "piSceneD" $')));
  assert.match(f.requests.at(-1), /mix.*0\.7/);
  // Parked decks keep their records so a later select still works.
  assert.ok(f.registry.get('B'));
  assert.ok(f.registry.get('D'));
});
