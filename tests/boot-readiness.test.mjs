import test from 'node:test';
import assert from 'node:assert/strict';
import { createBootSignals, inspectBootLog, isStackReady, BOOT_TIMEOUT_MS, REPL_TIMEOUT_MS, ENSURE_TIMEOUT_MS } from '../lib/boot-readiness.mjs';

test('every possible stdout banner fragmentation still latches readiness', () => {
  const banner = 'SuperDirt: listening on port 57120\n';
  for (let cut = 1; cut < banner.length; cut++) {
    const signals = createBootSignals();
    signals.feed(banner.slice(0, cut)); signals.feed(banner.slice(cut));
    assert.equal(signals.listening, true, `cut ${cut}`);
    signals.feed('noise\n'.repeat(2000));
    assert.equal(signals.listening, true, 'truncating the ring cannot lose a boot signal');
  }
});

test('death latches even across chunks and resets only with a new owned boot', () => {
  const signals = createBootSignals();
  signals.feed('Server exited with ex'); signals.feed('it code 0');
  assert.equal(signals.died, true);
  signals.reset();
  assert.equal(signals.died, false);
  assert.equal(signals.listening, false);
});

test('stale logs, incomplete self-tests and failed stages cannot report ready', () => {
  assert.equal(inspectBootLog('[16] done').ready, true);
  assert.equal(inspectBootLog('[16] done', {fresh:false}).ready, false);
  assert.equal(inspectBootLog('[1] ok define\n[2] audio test in progress').ready, false);
  assert.equal(inspectBootLog('[1] FAIL routing\n[16] done').ready, false);
  assert.equal(inspectBootLog('[1] ok something done inside stage').ready, false);
  assert.equal(inspectBootLog('', {exists:false}).ready, true);
  assert.match(inspectBootLog('[1] FAIL routing\n[16] done').error, /routing/);
});

test('total deadline covers SC + GHCi stage budgets, and failure text never passes ready predicate', () => {
  assert.ok(ENSURE_TIMEOUT_MS > BOOT_TIMEOUT_MS + REPL_TIMEOUT_MS);
  assert.ok(isStackReady('stack ready'));
  for (const status of ['stack did not become ready within 120s', 'repl did not become ready within 90s', 'SC outside plugin', '']) assert.equal(isStackReady(status), false);
});
