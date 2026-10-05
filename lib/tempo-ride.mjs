// Tidal setcps is a single clock mutation, not a ramp. Bound both the number
// of writes and their rate; no scene origins or cycle resets appear here.
export function tempoRideSteps(fromCps, toCps, seconds, stepHz = 4) {
  if (![fromCps, toCps].every(c => Number.isFinite(c) && c > 0 && c <= 4)) throw Error('cps must be > 0 and <= 4');
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) throw Error('morph seconds must be > 0 and <= 300');
  if (!Number.isFinite(stepHz) || stepHz < 1 || stepHz > 10) throw Error('morph stepHz must be 1..10');
  const count = Math.max(1, Math.floor(seconds * stepHz));
  return Array.from({ length: count }, (_, i) => {
    const fraction = (i + 1) / count;
    const cps = i === count - 1 ? toCps : fromCps + (toCps - fromCps) * fraction;
    return { fraction, at: seconds * 1000 * fraction, cps, command: `setcps ${cps}` };
  });
}
