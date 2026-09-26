import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const depth = Number(process.argv[2] ?? 2);
process.on('SIGTERM', () => {}); // exercise escalation, not just the happy path
console.log(`OWNED_PID=${process.pid}`);
if (depth > 0) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), String(depth - 1)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
} else {
  console.log('TREE_READY');
}
setInterval(() => {}, 1000);
