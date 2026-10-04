import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanReplError } from '../lib/repl-error.mjs';

// A realistic (concatenated) ghci stderr burst for a type error, as the
// extension used to pass it through raw: ANSI codes, hard wraps mid-word,
// aligned continuation lines, bullets, and a trailing CALL STACK dump.
const rawTypeError = [
  '<interactive>:23:5: error:',
  '  \u2022 Couldn\u2019t match expected type \u2018Pattern ValueMap\u2019',
  '              with actual type \u2018ControlPattern\u2019',
  '  \u2022 In the first argument of d1',
  '<interactive>:23:5: error:',
  'PROTECTED CALL STACK:',
  '  handover, called at libs/tidal/src/Sound/Tidal/Stream.hs:234:10',
  '  call, called at libs/tidal/src/Sound/Tidal/Stream.hs:235:10',
  '  call, called at libs/tidal/src/Sound/Tidal/Stream.hs:236:10',
].join('\n');

test('strips ANSI escapes, \\r and other control characters', () => {
  const raw = '\x1B[31m\x1B[2G<interactive>:3:1: error:\r\n  \x1B[0mVariable not in scope: d9\x07';
  const out = cleanReplError(raw);
  assert.ok(!out.includes('\x1B'), 'no escape codes remain');
  assert.ok(!out.includes('\r'), 'no carriage returns remain');
  assert.ok(!out.includes('\x07'), 'no bell remains');
  assert.match(out, /Variable not in scope: d9/);
});

test('rejoins mid-word hard wraps into one line', () => {
  // 'mat' + 'ch' is a terminal hard-wrap broken mid-word at column 0: glued
  // back without a space; GHC's aligned `with actual type:` line (indented)
  // stays its own line instead of being glued into the message
  const out = cleanReplError(
    "Couldn't mat\nch expected type: Pattern ValueMap\n              with actual type: ControlPattern",
  );
  const lines = out.split('\n');
  assert.equal(lines.length, 2, 'two logical lines, not three');
  assert.equal(lines[0], "Couldn't match expected type: Pattern ValueMap");
  assert.equal(lines[1], 'with actual type: ControlPattern');
});

test('keeps • bullet lines as separate lines', () => {
  const out = cleanReplError(rawTypeError);
  const outLines = out.split('\n');
  assert.equal(outLines.filter(l => l.includes('•')).length, 2, 'each bullet stays its own line');
  assert.ok(outLines[1].startsWith('•'), 'second bullet starts a fresh line');
  // the aligned `with actual type` line stays separate, not glued to the bullet
  assert.ok(outLines.some(l => l === 'with actual type ‘ControlPattern’'));
});

test('keeps the expected/actual type lines and truncates the call stack', () => {
  const out = cleanReplError(rawTypeError);
  assert.match(out, /Couldn’t match expected type/);
  assert.match(out, /with actual type ‘ControlPattern’/);
  assert.match(out, /PROTECTED CALL STACK:/);
  assert.match(out, /… \(call stack truncated, 3 lines omitted\)/);
  assert.ok(!out.includes('handover, called at'), 'stack frames are dropped');
});

test('collapses blank runs and trims the block', () => {
  const out = cleanReplError('\n\n  <interactive>:3:1: error:   \n\n\nVariable not in scope: d9\n\n\n');
  assert.equal(out, '<interactive>:3:1: error:\n\nVariable not in scope: d9');
});

test('caps the line count with an explicit marker', () => {
  const raw = Array.from({length: 30}, (_, i) => `line ${i} of the error output.`).join('\n');
  const out = cleanReplError(raw);
  assert.equal(out.split('\n').length, 21, '20 lines + 1 marker');
  assert.match(out, /… \(10 more lines truncated\)$/);
  assert.ok(!out.includes('line 20 of'), 'only the first 20 lines are kept');
});

test('caps the character count with an explicit marker', () => {
  const raw = Array.from({length: 20}, () => 'x'.repeat(200)).join('\n');
  const out = cleanReplError(raw);
  assert.ok(out.length < 2300, 'output is bounded');
  assert.match(out, /… \(\d+ chars truncated\)$/);
});

test('custom bounds are honoured', () => {
  const raw = ['a.', 'b.', 'c.'].join('\n');
  assert.equal(cleanReplError(raw, {maxLines: 2}), 'a.\nb.\n… (1 more line truncated)');
  assert.equal(cleanReplError('a.\nb.\nc.'), 'a.\nb.\nc.');
  assert.equal(cleanReplError(''), '');
});

test('hard-wrapped single characters scatter back into words', () => {
  // the observed 'wi\nt\nh' garbage after ANSI stripping: letters alone on
  // continuation lines are re-joined into the original word
  const out = cleanReplError('Couldn’t match expected type: Pattern ValueMap wi\nt\nh actual type: ControlPattern');
  assert.match(out, /with actual type: ControlPattern/);
});
