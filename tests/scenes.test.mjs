import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as helpers from '../lib/scenes.mjs';
import { createSceneController } from '../lib/scene-controller.mjs';
import { tidalStatements } from '../lib/tidal-chunks.mjs';
const { extractSc, parseScene, sceneCommands, patternExpression, createSceneRegistry, isSceneFile } = helpers;
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
  assert.throws(() => patternExpression(scene, 'C'), /deck must/);
  const defaults = parseScene('-- @scene {"cps":0.3}\nd1 $ s "bd"\nd16 $ s "hh"');
  assert.deepEqual(defaults.lanes.map(l => l.orbit), [0, 5]);
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

test('legacy do and continuation blocks remain intact while independent statements split', () => {
  assert.deepEqual(tidalStatements('do\n  setcps 0.3\n  d1 $ s "bd"\nd2 $ s "sn"'), ['do\n  setcps 0.3\n  d1 $ s "bd"', 'd2 $ s "sn"']);
  assert.deepEqual(tidalStatements('-- header\nd1 $ s "bd"\n  # gain 0.4'), ['d1 $ s "bd"\n  # gain 0.4']);
});

function fixture() {
  const registry = createSceneRegistry(), writes = [], requests = [], labels = [];
  let failSc = false, failActivation = false;
  const controller = createSceneController({ ...helpers, registry, runtimePath:'/runtime/scenes.scd',
    ensure: async () => 'stack ready', ready: s => s === 'stack ready',
    writeRepl: code => writes.push(code), hush: () => writes.push('hush'), label: x => labels.push(x),
    queryRepl: async codes => codes.join().includes('queryArc') ? '4' : codes.join().includes('getcps') ? '0.3' : failActivation ? '(no output captured)' : '100.0',
    sc: async fn => { const code = fn('"ACK"'); requests.push(code); if (failSc && code.includes('prepare')) throw Error('bad SC'); },
  });
  return { registry, writes, requests, controller, labels,
    failSc: () => {failSc = true;}, failActivation: () => {failActivation = true;} };
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
