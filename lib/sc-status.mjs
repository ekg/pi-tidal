// An absent observation or UDP timeout is not proof of a dead audio server.
export function formatScStatus(observation) {
  if (!observation) return '? (not checked)';
  return observation.alive ? `✓ (${observation.synths} synths)` : '? (no reply)';
}
