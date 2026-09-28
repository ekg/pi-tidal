// Choose ONE stereo PipeWire sink for SuperCollider's JACK output ports.
// Prefer the virtual Tidal Main sink (its playback stream follows Ubuntu's
// default output), then XREAL if the bridge is unavailable, then the configured
// default sink, then a complete stereo fallback. Never use capture ports.
export function selectStereoSinkPorts(pwLinkInputs, defaultSinkInspect = "") {
  const ports = pwLinkInputs.split(/\r?\n/).map(s => s.trim());
  const pairs = new Map();
  for (const port of ports) {
    const m = /^(.*):playback_(FL|FR)$/.exec(port);
    if (!m) continue; // playback_FL/FR ports are outputs; capture ports cannot match
    const pair = pairs.get(m[1]) ?? {};
    pair[m[2]] = port;
    pairs.set(m[1], pair);
  }
  const complete = [...pairs].filter(([, p]) => p.FL && p.FR);
  const configured = /node\.name\s*=\s*"([^"]+)"/.exec(defaultSinkInspect)?.[1];
  const chosen = complete.find(([name]) => name === 'tidal_main')
    ?? complete.find(([name]) => /xreal/i.test(name))
    ?? complete.find(([name]) => name === configured)
    ?? complete[0];
  return chosen ? chosen[1] : null;
}
