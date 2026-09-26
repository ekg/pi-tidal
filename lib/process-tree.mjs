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
