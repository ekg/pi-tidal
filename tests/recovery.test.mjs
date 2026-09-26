import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSclangTransport } from '../lib/sclang-command.mjs';
import { ownedProcessIds } from '../lib/process-tree.mjs';
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
