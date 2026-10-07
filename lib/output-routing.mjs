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

// Opt-in gate for ALSO linking SuperCollider to the tidal_stream sink. Default
// off: config `link: false`, unless PI_TIDAL_STREAM_LINK=1 (or `true`).
// With the gate off the boot link step must behave byte-for-byte as before.
export function streamLinkEnabled(config = {}, env = {}) {
  if (env.PI_TIDAL_STREAM_LINK === '1' || env.PI_TIDAL_STREAM_LINK === 'true') return true;
  return config?.link === true;
}

// The tidal_stream sink's playback ports, or null when the node does not exist.
// Only playback_FL/FR can match, so a capture port can never be selected; the
// contract's `pw-record --target tidal_stream -P stream.capture.sink` path needs
// the sink's monitor, which we never link to.
export function selectStreamLinkPorts(pwLinkInputs, sinkName = 'tidal_stream') {
  const pair = {};
  for (const rawLine of String(pwLinkInputs).split(/\r?\n/)) {
    const port = rawLine.trim();
    const m = /^(.*):playback_(FL|FR)$/.exec(port);
    if (!m || m[1] !== sinkName) continue;
    pair[m[2]] = port;
  }
  return pair.FL && pair.FR ? pair : null;
}

// The boot link step in one pure call: the physical sink pair (unchanged
// behaviour) and, only when the gate is on AND the node exists, the additive
// tidal_stream pair. With the gate off `stream` is always null, so a caller can
// skip it without changing the physical result.
export function planOutputLinks({ pwLinkInputs, defaultSink = '', config = {}, env = {}, sinkName = 'tidal_stream' } = {}) {
  return {
    physical: selectStereoSinkPorts(pwLinkInputs, defaultSink),
    stream: streamLinkEnabled(config, env) ? selectStreamLinkPorts(pwLinkInputs, sinkName) : null,
  };
}
