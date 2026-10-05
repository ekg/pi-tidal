// Boot signals are latched, not searched in a bounded log tail. stdout data
// events can split ANY byte of a banner; a healthy boot must survive that.
export const BOOT_TIMEOUT_MS = 150_000;
export const REPL_TIMEOUT_MS = 90_000;
export const ENSURE_TIMEOUT_MS = BOOT_TIMEOUT_MS + REPL_TIMEOUT_MS + 20_000;
export const isStackReady = status => status === 'stack ready';

export function createBootSignals() {
  let buffer = '', listening = false, died = false;
  return {
    feed(text) {
      buffer = (buffer + text).slice(-8192);
      listening ||= buffer.includes('listening on port 57120');
      died ||= buffer.includes('exited with exit code');
    },
    reset() { buffer = ''; listening = false; died = false; },
    get listening() { return listening; },
    get died() { return died; },
  };
}

export function inspectBootLog(text, { exists = true, fresh = true } = {}) {
  if (!exists) return { ready: true, error: '' }; // stock SuperDirt
  if (!fresh) return { ready: false, error: '' };
  const lines = text.trim().split('\n');
  const failures = lines.filter(l => /\bFAIL\b/.test(l));
  return { ready: !failures.length && /^\[[^\]]+\]\s+done\s*$/.test(lines.at(-1)),
    error: failures.slice(-2).join('\n') };
}
