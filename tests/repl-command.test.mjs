import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { replCommand } from '../lib/repl-command.mjs';
import { parseScene, sceneCommands } from '../lib/scenes.mjs';

test('REPL queries parenthesize each IO action before >> sequencing', () => {
  const command = replCommand(['p "A" $ s "bd"', 'p "B" $ s "sn"', 'print 1']);
  assert.match(command, /\(p "A" \$ s "bd"\) >> \(p "B" \$ s "sn"\) >> \(print 1\)/);
  assert.throws(() => replCommand([]), /at least one/);
});

test('real installed Tidal compiles scene activation and its clock starts at zero (no audio boot)', {
  skip: process.env.TIDAL_HASKELL_TESTS !== '1',
}, () => {
  const scene = parseScene('-- @scene {"cps":0.3}\nd1 $ s "bd*4"\nd7 $ n "<c4 e4>" # s "hoRhodes" # orbit 5');
  const commands = sceneCommands(scene, 'A', 7);
  const source = `{-# LANGUAGE OverloadedStrings #-}
import Sound.Tidal.Context
import qualified Data.Map.Strict as M
default (Rational, Integer, Double, Pattern String)
getnow :: IO Rational
getnow = pure 10
p :: String -> ControlPattern -> IO ()
p name pat = if name == "piSceneClockA"
  then print [M.lookup "scenePhase" (value e) | e <- queryArc pat (Arc 11 12)]
  else print (length (queryArc pat (Arc 11 12)))
main = do
  ${commands[0]}
  ${replCommand([...commands.slice(1), 'print piSceneOriginA'])}
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidal-compile-test-'));
  try {
    const file = path.join(dir, 'scene.hs'); fs.writeFileSync(file, source);
    const output = execFileSync('runghc', [file], {encoding:'utf8',timeout:20000});
    assert.match(output, /__PI_TIDAL_BEGIN__/);
    assert.match(output, /Just 0\.0/);
    assert.match(output, /11 % 1/);
    assert.match(output, /__PI_TIDAL_END__/);
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});
