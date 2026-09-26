import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Snapshot only descendants of the process we spawned. Never kill by executable
// name: another session may own a perfectly healthy sclang/scsynth.
export function ownedProcessIds(root, rows) {
  const children = new Map();
  for (const { pid, ppid } of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const result = [], seen = new Set();
  function visit(pid) {
    if (seen.has(pid)) return;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) visit(child);
    result.push(pid);
  }
  visit(root);
  return result;
}

function identity(pid) {
  try {
    // Fields after '(comm)': state, ppid, ... starttime (field 22).
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(/\) /).at(-1).trim().split(/\s+/);
    if (fields[0] === 'Z') return null; // exited, awaiting its parent to reap
    return fields[19];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

// Linux: wait until this exact tree has exited before allowing another boot.
// Capture start times to avoid signalling a PID reused during shutdown.
export async function stopOwnedProcessTree(root, { timeoutMs = 2000 } = {}) {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim().split('\n').map(line => {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      return { pid, ppid };
    });
  const owned = ownedProcessIds(root, rows)
    .map(pid => ({ pid, start: identity(pid) })).filter(item => item.start !== null);
  const alive = item => identity(item.pid) === item.start;
  const signal = (item, sig) => {
    if (!alive(item)) return;
    try { process.kill(item.pid, sig); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  owned.forEach(item => signal(item, 'SIGTERM'));
  const deadline = Date.now() + timeoutMs;
  while (owned.some(alive) && Date.now() < deadline) await delay(25);
  owned.forEach(item => signal(item, 'SIGKILL'));
  const killDeadline = Date.now() + 1000;
  while (owned.some(alive) && Date.now() < killDeadline) await delay(25);
  const survivors = owned.filter(alive);
  if (survivors.length) throw Error(`owned processes did not exit: ${survivors.map(item => item.pid)}`);
  return owned.map(item => item.pid);
}
