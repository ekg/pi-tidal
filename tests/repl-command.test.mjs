import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { replCommand } from '../lib/repl-command.mjs';
import { parseScene, sceneCommands } from '../lib/scenes.mjs';
import { tempoRideSteps } from '../lib/tempo-ride.mjs';

test('REPL queries parenthesize each IO action before >> sequencing', () => {
  const command = replCommand(['p "A" $ s "bd"', 'p "B" $ s "sn"', 'print 1']);
  assert.match(command, /\(p "A" \$ s "bd"\) >> \(p "B" \$ s "sn"\) >> \(print 1\)/);
  assert.throws(() => replCommand([]), /at least one/);
});

test('real installed Tidal compiles selected decks and their clocks start at zero (no audio boot)', {
  skip: process.env.TIDAL_HASKELL_TESTS !== '1',
}, async () => {
  for (const { deck, pair, slot, orbitsPerChannel = 6 } of [{ deck: 'A', pair: ['A', 'B'], slot: 0 }, { deck: 'C', pair: ['A', 'C'], slot: 1 }, { deck: 'Z', pair: ['Z', 'B'], slot: 0 }, { deck: 'Z', pair: ['A', 'B', 'Z'], slot: 2, orbitsPerChannel: 3 }]) {
    const scene = parseScene(`-- @scene {"cps":0.3}\nd1 $ s "bd*4"\nd7 $ n "<c4 e4>" # s "hoRhodes" # orbit ${orbitsPerChannel - 1}`, orbitsPerChannel);
    const commands = sceneCommands(scene, deck, 7, { pair, orbitsPerChannel });
    assert.match(commands[2], new RegExp(`"sceneSlot" ${slot}.*orbit ${slot * orbitsPerChannel}`));
    const source = `{-# LANGUAGE OverloadedStrings #-}
import Sound.Tidal.Context
import qualified Data.Map.Strict as M
default (Rational, Integer, Double, Pattern String)
getnow :: IO Rational
getnow = pure 10
p :: String -> ControlPattern -> IO ()
p name pat = if name == "piSceneClock${deck}"
  then print [M.lookup "scenePhase" (value e) | e <- queryArc pat (Arc 11 12)]
  else print (length (queryArc pat (Arc 11 12)))
main = do
  ${commands[0]}
  ${replCommand([...commands.slice(1), `print piSceneOrigin${deck}`])}
`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidal-compile-test-'));
    try {
      const file = path.join(dir, 'scene.hs'); fs.writeFileSync(file, source);
      const output = execFileSync('runghc', [file], { encoding: 'utf8', timeout: 20000 });
      assert.match(output, /__PI_TIDAL_BEGIN__/);
      assert.match(output, /Just 0\.0/);
      assert.match(output, /11 % 1/);
      assert.match(output, /__PI_TIDAL_END__/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('generated tempo ride setcps commands compile against installed Tidal without starting a stream', {
  skip: process.env.TIDAL_HASKELL_TESTS !== '1',
}, () => {
  const steps = tempoRideSteps(0.3, 0.6, 1);
  const source = `{-# LANGUAGE OverloadedStrings #-}
import Sound.Tidal.Context
import Sound.Tidal.Stream (Stream, streamOnce)
import qualified Data.Map.Strict as M
default (Rational, Integer, Double, Pattern String)
-- Type-check the real BootTidal definition, but never instantiate a Stream.
realSetcps :: Stream -> Pattern Double -> IO ()
realSetcps tidal = streamOnce tidal . cps
-- Offline once only queries the installed Tidal pattern implementation.
once :: ControlPattern -> IO ()
once pat = print [M.lookup "cps" (value e) | e <- queryArc pat (Arc 0 1)]
setcps :: Pattern Double -> IO ()
setcps = once . cps
main = ${replCommand([...steps.map(s => s.command), 'print ("ride compiled" :: String)'])}
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidal-tempo-compile-'));
  try {
    const file = path.join(dir, 'ride.hs'); fs.writeFileSync(file, source);
    const output = execFileSync('runghc', [file], { encoding: 'utf8', timeout: 20000 });
    assert.match(output, /Just 0\.375/);
    assert.match(output, /Just 0\.6/);
    assert.match(output, /ride compiled/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
