import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSclangTransport } from '../lib/sclang-command.mjs';
import { ownedProcessIds, stopOwnedProcessTree } from '../lib/process-tree.mjs';
import { createLifecycleQueue } from '../lib/lifecycle.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import extension from '../extensions/tidal.ts';

test('multiline SC source is preserved; stdin receives one physical line', () => {
  const commands = [];
  const transport = createSclangTransport(command => commands.push(command));
  try {
    const code = '(\nvar value = 21;\n// preserve this comment\n(value * 2).postln;\n)';
    const file = transport.send(code, 'test "quote"\nlabel');
    assert.equal(fs.readFileSync(file, 'utf8'), code + '\n');
    assert.equal(commands[0].split('\n').length, 2);
    assert.ok(commands[0].includes(`this.executeFile(${JSON.stringify(file)})`));
    assert.ok(commands[0].includes('File.delete('));
    assert.ok(!commands[0].includes('var value'));
  } finally { transport.dispose(); }
});

test('transport cleans up files on failed stdin writes', () => {
  const transport = createSclangTransport(() => { throw Error('closed'); });
  assert.throws(() => transport.send('1.postln;'), /closed/);
  transport.dispose();
  transport.dispose();
});

test('teardown includes grandchildren, excludes other sessions, children first', () => {
  const rows = [
    {pid: 10, ppid: 1}, {pid: 11, ppid: 10}, {pid: 12, ppid: 11},
    {pid: 20, ppid: 1}, {pid: 21, ppid: 20},
  ];
  assert.deepEqual(ownedProcessIds(10, rows), [12, 11, 10]);
  assert.deepEqual(ownedProcessIds(99, rows), [99]);
});

test('shutdown waits for real grandchildren; escalates without killing an unrelated process', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/process-tree.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'inherit'] });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  let output = '';
  const exited = once(child, 'exit');
  const unrelatedExited = once(unrelated, 'exit');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('fixture did not become ready')), 5000);
      child.stdout.on('data', data => {
        output += data;
        if (output.includes('TREE_READY')) { clearTimeout(timer); resolve(); }
      });
      child.on('error', error => { clearTimeout(timer); reject(error); });
    });
    const pids = [...output.matchAll(/OWNED_PID=(\d+)/g)].map(match => Number(match[1]));
    assert.equal(pids.length, 3);
    const stopped = await stopOwnedProcessTree(child.pid, { timeoutMs: 100 });
    assert.deepEqual(new Set(stopped), new Set(pids));
    for (const pid of pids) {
      let state;
      try { state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0]; }
      catch (error) { assert.equal(error.code, 'ENOENT'); }
      assert.ok(state === undefined || state === 'Z', `surviving process ${pid}`);
    }
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    await stopOwnedProcessTree(child.pid, { timeoutMs: 50 });
    unrelated.kill();
    await Promise.all([exited, unrelatedExited]);
  }
});

test('boot/restart/shutdown run sequentially and failure does not poison the queue', async () => {
  const run = createLifecycleQueue();
  const events = [];
  const boot = run(async () => { events.push('boot'); await delay(10); events.push('boot done'); });
  const restart = run(async () => { events.push('restart'); throw Error('test failure'); });
  const rejected = assert.rejects(restart, /test failure/);
  const shutdown = run(async () => { events.push('shutdown'); });
  await Promise.all([boot, rejected, shutdown]);
  assert.deepEqual(events, ['boot', 'boot done', 'restart', 'shutdown']);
});

test('extension imports and registers the livecoding tools without booting audio', () => {
  const tools = new Map();
  extension({
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand() {}, on() {},
  });
  for (const name of ['tidal_eval', 'tidal_sc', 'tidal_sc_reload', 'tidal_panic', 'tidal_restart']) {
    assert.equal(typeof tools.get(name)?.execute, 'function', name);
  }
});
