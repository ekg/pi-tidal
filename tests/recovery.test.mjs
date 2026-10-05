import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSclangTransport } from '../lib/sclang-command.mjs';
import { ownedProcessIds, stopOwnedProcessTree } from '../lib/process-tree.mjs';
import { createLifecycleQueue } from '../lib/lifecycle.mjs';
import { formatScStatus } from '../lib/sc-status.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import extension, { importFreshModule } from '../extensions/tidal.ts';

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

test('widget distinguishes unchecked/no-reply from a live server', () => {
  assert.equal(formatScStatus(null), '? (not checked)');
  assert.equal(formatScStatus({ alive: false, synths: 0 }), '? (no reply)');
  assert.equal(formatScStatus({ alive: true, synths: 132 }), '✓ (132 synths)');
});

test('reload sees newly added helper exports even when the old module is cached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidal-reload-test-'));
  const file = path.join(dir, 'helper.mjs');
  try {
    fs.writeFileSync(file, 'export const revision = 1;');
    const stale = await import(pathToFileURL(file).href);
    const first = await importFreshModule(file);
    assert.equal(stale.revision, 1);
    assert.equal(first.revision, 1);
    fs.writeFileSync(file, 'export const revision = 2; export function stopOwnedProcessTree() { return "stopped"; }');
    assert.equal((await import(pathToFileURL(file).href)).stopOwnedProcessTree, undefined);
    const fresh = await importFreshModule(file);
    assert.equal(fresh.revision, 2);
    assert.equal(fresh.stopOwnedProcessTree(), 'stopped');
    assert.equal(await importFreshModule(file), fresh); // unchanged code reuses one module
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('extension imports and registers the livecoding tools without booting audio', async () => {
  const tools = new Map();
  await extension({
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand() {}, on() {},
  });
  for (const name of ['tidal_eval', 'tidal_sc', 'tidal_sc_reload', 'tidal_panic', 'tidal_restart']) {
    assert.equal(typeof tools.get(name)?.execute, 'function', name);
  }
});

test('all hush entry points persist their cleared scene state', () => {
	// Contract check only: do not boot a real server to exercise emergency stop.
	const source = fs.readFileSync(new URL('../extensions/tidal.ts', import.meta.url), 'utf8');
	assert.match(source, /async function leaveScenesForHush\(\): Promise<void> \{\s*await sceneQueue\(\(\) => sceneController\.leave\(\)\);[\s\S]*?persistScenes\(\);\s*\}/);
	assert.equal((source.match(/await leaveScenesForHush\(\)/g) ?? []).length, 4);
});

test('cold session recovery restores old A/B snapshots and new A-Z pairs', async () => {
	const sceneText = (cps = 0.3) => `-- @scene {"cps":${cps}}\nd1 $ s "bd" # orbit 0\n`;
	const entry = data => ({ type: "custom", customType: "tidal-scenes", data });
	async function bootWithSnapshot(data, dir) {
		const tools = new Map();
		const events = new Map();
		await extension({
			registerTool: t => tools.set(t.name, t),
			registerCommand() {},
			on: (name, fn) => events.set(name, fn),
		});
		await events.get("session_start")({}, { hasUI: false, cwd: dir, sessionManager: { getBranch: () => [entry(data)] } });
		const out = await tools.get("tidal_scene").execute("t", { action: "status" }, null, null, { cwd: dir });
		return out.content[0].text;
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tidal-scene-recovery-"));
	try {
		// Old snapshot format (pre A-Z): no pair field, only A/B decks.
		const legacy = {
			decks: [
				["A", { file: path.join(dir, "a.tidal"), text: sceneText() }],
				["B", { file: path.join(dir, "b.tidal"), text: sceneText() }],
			],
			mix: 0.25,
		};
		const empty = await bootWithSnapshot({decks: [], mix: 0, pair: ['A', 'B']}, dir);
		assert.match(empty, /none loaded/);
		const oldText = await bootWithSnapshot(legacy, dir);
		assert.match(oldText, /pair A \(mix 0\) \/ B \(mix 1\)/);
		assert.match(oldText, /A: a\.tidal, epoch \d+/);
		assert.match(oldText, /mix 0\.25/);
		// New format: a non-default pair plus parked decks survive a cold start.
		const modern = {
			decks: [
				["A", { file: path.join(dir, "a.tidal"), text: sceneText() }],
				["C", { file: path.join(dir, "c.tidal"), text: sceneText() }],
			],
			mix: 0.75,
			pair: ["A", "C"],
		};
		const newText = await bootWithSnapshot(modern, dir);
		assert.match(newText, /pair A \(mix 0\) \/ C \(mix 1\)/);
		assert.match(newText, /C: c\.tidal, epoch \d+/);
		assert.match(newText, /mix 0\.75/);
		// Restore the pair first, atomically. A/B can be parked at unrelated
		// tempos, and B may occupy the zero side of a valid saved pair.
		for (const pair of [['B', 'A'], ['B', 'C'], ['C', 'D']]) {
			const decks = [...'ABCD'].map((deck, i) => [deck, {
				file: path.join(dir, `${deck.toLowerCase()}.tidal`),
				text: sceneText(pair.includes(deck) ? 0.3 : 0.4 + i * 0.1),
			}]);
			const text = await bootWithSnapshot({decks, pair, mix: 0.6}, dir);
			assert.ok(text.includes(`pair ${pair[0]} (mix 0) / ${pair[1]} (mix 1):`));
			assert.match(text, /mix 0\.6/);
			for (const [deck] of decks) assert.ok(text.includes(`${deck}: ${deck.toLowerCase()}.tidal`));
		}
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
