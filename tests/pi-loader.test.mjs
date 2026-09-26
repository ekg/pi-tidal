import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Point PI_JITI_MODULE at the installed Pi package's node_modules/jiti/lib/jiti.mjs.
// Native Node tests alone missed the stale-helper failure in Pi's TS loader.
test('Pi/Jiti reload sees changed helper exports and can run shutdown', {
  skip: !process.env.PI_JITI_MODULE,
}, async () => {
  const { createJiti } = await import(pathToFileURL(process.env.PI_JITI_MODULE).href);
  const entry = fileURLToPath(new URL('../extensions/tidal.ts', import.meta.url));
  const jiti = createJiti(entry, { moduleCache: false });
  const { default: extension, importFreshModule } = await jiti.import(entry);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidal-pi-loader-'));
  const file = path.join(dir, 'helper.mjs');
  try {
    fs.writeFileSync(file, 'export const revision = 1;');
    assert.equal((await importFreshModule(file)).revision, 1);
    fs.writeFileSync(file, 'export const revision = 2; export function stopOwnedProcessTree() { return "stopped"; }');
    const fresh = await importFreshModule(file);
    assert.equal(fresh.revision, 2);
    assert.equal(fresh.stopOwnedProcessTree(), 'stopped');
    const tools = new Map(), events = new Map();
    await extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on: (name, fn) => events.set(name, fn) });
    assert.ok(tools.has('tidal_sc'));
    await events.get('session_shutdown')({ reason: 'reload' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
