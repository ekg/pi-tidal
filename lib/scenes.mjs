// Scene files are valid Haskell comments plus ordinary Tidal lanes. No SC ever
// reaches GHCi. Kept outside the extension so parsing/ownership can be tested.
import path from 'node:path';

export function extractSc(text) {
  let tidal = '', sc = [], i = 0;
  while (i < text.length) {
    if (text.startsWith('--', i)) {
      const end = text.indexOf('\n', i);
      const j = end < 0 ? text.length : end;
      tidal += text.slice(i, j); i = j;
    } else if (text[i] === '"') {
      const begin = i++;
      while (i < text.length) {
        if (text[i++] === '\\') i++;
        else if (text[i - 1] === '"') break;
      }
      tidal += text.slice(begin, i);
    } else if (text.startsWith('{-', i)) {
      const begin = i + 2; i += 2;
      let depth = 1;
      while (i < text.length && depth) {
        if (text.startsWith('{-', i)) { depth++; i += 2; }
        else if (text.startsWith('-}', i)) { depth--; if (depth) i += 2; }
        else i++;
      }
      if (depth) throw Error('Unterminated {- ... -} block');
      const body = text.slice(begin, i);
      if (/^\s*@sc\b/.test(body)) sc.push(body.replace(/^\s*@sc\b/, '').trim());
      // Preserve line boundaries, including blank lines inside SC blocks.
      tidal += body.replace(/[^\n]/g, ' '); i += 2;
    } else tidal += text[i++];
  }
  return { tidal, sc };
}

export function isSceneFile(text) {
  return /^\s*--\s*@scene\s+/m.test(extractSc(text).tidal);
}

export function parseScene(text, orbitsPerChannel = 6) {
  validateMixerConfig(2, orbitsPerChannel);
  const { tidal, sc } = extractSc(text);
  const headers = [...tidal.matchAll(/^\s*--\s*@scene\s+(.*)$/gm)];
  if (headers.length !== 1) throw Error('Scene needs exactly one -- @scene {"cps": ...} header');
  const options = JSON.parse(headers[0][1]);
  for (const key of Object.keys(options)) {
    if (!['cps', 'quantize', 'title'].includes(key)) throw Error(`Unknown scene option: ${key}`);
  }
  const cps = options.cps;
  const quantize = options.quantize ?? 1;
  if (!Number.isFinite(cps) || cps <= 0 || cps > 4) throw Error('cps must be > 0 and <= 4');
  if (!Number.isInteger(quantize) || quantize < 1 || quantize > 64) throw Error('quantize must be an integer 1..64');
  const lines = tidal.split('\n');
  const statements = [];
  for (const line of lines) {
    const clean = stripLineComment(line).trimEnd();
    if (!clean.trim()) continue;
    if (/^\s*(d\d+\s*\$|let\s+)/.test(clean)) statements.push(clean.trim());
    else if (/^\s+/.test(clean) && statements.length) statements[statements.length - 1] += '\n' + clean;
    else throw Error(`Unsupported scene statement: ${clean.trim().slice(0, 80)}. Use d1..d16 lanes and local let bindings.`);
  }
  const lanes = [], bindings = [], seen = new Set();
  for (const statement of statements) {
    if (statement.startsWith('let ')) {
      const binding = statement.slice(4).trim();
      if (!/^[a-z][\w']*\s*=/.test(binding)) throw Error('Scene let bindings must be simple name = expression bindings');
      bindings.push(binding); continue;
    }
    const [, number, pattern] = statement.match(/^d(\d+)\s*\$\s*([\s\S]+)$/) ?? [];
    const lane = Number(number);
    if (!lane || lane > 16 || seen.has(lane)) throw Error('Scene lanes must be unique d1..d16');
    seen.add(lane);
    // Orbit expressions must be local literals, never another channel's block.
    // Ignore quoted mini-notation when inspecting Haskell controls.
    const outsideStrings = pattern.replace(/"(?:\\.|[^"\\])*"/g, '""');
    const orbitUses = [...outsideStrings.matchAll(/\borbit\b/g)];
    const literalUses = [...outsideStrings.matchAll(/#\s*orbit\s+(\d+)(?=\s|$|\))/g)];
    if (orbitUses.length !== literalUses.length || literalUses.some(m => Number(m[1]) >= orbitsPerChannel)) throw Error(`Scene orbit must be a literal # orbit 0..${orbitsPerChannel - 1}`);
    const orbit = literalUses.length ? Number(literalUses.at(-1)[1]) : Math.min(lane - 1, orbitsPerChannel - 1);
    lanes.push({ lane, orbit, pattern });
  }
  if (!lanes.length) throw Error('Scene has no d1..d16 lanes');
  return { ...options, cps, quantize, sc: sc.join('\n'), lanes, bindings };
}

function stripLineComment(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (quoted && line[i] === '\\') { i++; continue; }
    if (line[i] === '"') quoted = !quoted;
    if (!quoted && line.slice(i, i + 2) === '--') return line.slice(0, i);
  }
  return line;
}

export const DEFAULT_PAIR = ['A', 'B'];

// Decks A..Z are logical identifiers. deckIndex is the letter's position in
// the alphabet; it names streams/records but owns no audio resources.
export function deckIndex(deck) {
  if (typeof deck !== 'string' || deck.length !== 1 || deck < 'A' || deck > 'Z') {
    throw Error('deck must be a single letter A..Z');
  }
  return deck.charCodeAt(0) - 65;
}

// Only channel members render. Channel index chooses a fixed orbit block;
// deck letters name streams, never audio resources. The default remains A/B.
export function deckSlot(deck, pair = DEFAULT_PAIR) {
  const slot = pair.indexOf(deck);
  if (slot < 0) throw Error(`deck ${deck} is not in the active pair ${pair[0]}/${pair[1]}; select it into the pair first`);
  return slot;
}

export function patternExpression(scene, deck, pair = DEFAULT_PAIR, orbitsPerChannel = 6) {
  const base = deckSlot(deck, pair) * orbitsPerChannel;
  const stack = `stack [${scene.lanes.map(l => `((${l.pattern}) # orbit ${base + l.orbit})`).join(', ')}]`;
  return scene.bindings.length ? `(let { ${scene.bindings.join('; ')} } in ${stack})` : stack;
}

export function sceneCommands(scene, deck, epoch, { restart = true, pair = DEFAULT_PAIR, orbitsPerChannel = 6, cps = scene.cps } = {}) {
  const slot = deckSlot(deck, pair);
  const origin = `piSceneOrigin${deck}`;
  const pat = patternExpression(scene, deck, pair, orbitsPerChannel);
  // One expression/line works even with legacy stdin chunk handling. Starting
  // at least one second ahead accommodates Tidal's look-ahead + OSC latency.
  const commands = [];
  if (restart) commands.push(`${origin} <- getnow >>= \\now -> pure (fromIntegral (ceiling ((now + ${cps}) / ${scene.quantize})) * ${scene.quantize} :: Rational)`);
  const window = `filterWhen (>= ${origin}) . rotR ${origin}`;
  commands.push(`p "piScene${deck}" $ ${window} $ ${pat}`);
  const tick = `s "piSceneTick*16" # pF "scenePhase" (segment 16 (sig fromRational)) # pI "sceneSlot" ${slot} # pI "sceneEpoch" ${epoch} # orbit ${slot * orbitsPerChannel}`;
  commands.push(`p "piSceneClock${deck}" $ ${window} $ ${tick}`);
  return commands;
}

export function stopCommands(deck) {
  deckIndex(deck);
  return [`p "piScene${deck}" silence`, `p "piSceneClock${deck}" silence`];
}

// Records are snapshots of what was activated, not just filenames. Recovery
// must not silently load unsent edits. Edits keep the origin; restarts replace it.
export function validateMixerConfig(channelCount, orbitsPerChannel) {
  if (!Number.isInteger(channelCount) || channelCount < 2 || channelCount > 26) throw Error('scene channel count must be an integer 2..26');
  if (!Number.isInteger(orbitsPerChannel) || orbitsPerChannel < 1 || orbitsPerChannel > 16) throw Error('scene orbits per channel must be an integer 1..16');
}

export function createSceneRegistry({ channelCount = 2, orbitsPerChannel = 6 } = {}) {
  validateMixerConfig(channelCount, orbitsPerChannel);
  const defaults = Array.from({ length: channelCount }, (_, i) => String.fromCharCode(65 + i));
  const decks = new Map();
  let epoch = 0, mix = 0, channels = [...defaults], gains = defaults.map((_, i) => i === 0 ? 1 : 0), tempoOverride;
  const registry = {
    channelCount, orbitsPerChannel,
    get: deck => decks.get(deck),
    entries: () => [...decks.entries()],
    get mix() { return mix; },
    get pair() { return [...channels]; }, // legacy name; channels is canonical
    get channels() { return [...channels]; },
    get gains() { return [...gains]; },
    get tempoOverride() { return tempoOverride; },
    setTempoOverride(cps) {
      if (cps !== undefined && (!Number.isFinite(cps) || cps <= 0 || cps > 4)) throw Error('cps must be > 0 and <= 4');
      tempoOverride = cps;
    },
    setMix(value) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw Error('mix must be 0..1 (pair position 0..1)');
      mix = value; gains[0] = 1 - value; gains[1] = value;
    },
    setGains(next) {
      if (!Array.isArray(next) || next.length !== channelCount || next.some(g => !Number.isFinite(g) || g < 0 || g > 1)) throw Error('channel gains must be 0..1, one per channel');
      gains = [...next];
    },
    restoreChannels(next) {
      if (!Array.isArray(next) || next.length !== channelCount) throw Error(`active channels need exactly ${channelCount} decks`);
      next.forEach(deckIndex);
      if (new Set(next).size !== channelCount) throw Error('the active pair needs two different decks; all channels must be distinct');
      channels = [...next];
    },
    restorePair(next) { registry.restoreChannels(next); },
    setPair(slot, deck) { registry.setChannel(slot, deck); },
    setChannel(slot, deck) {
      if (!Number.isInteger(slot) || slot < 0 || slot >= channelCount) throw Error(`pair position / channel must be 0..${channelCount - 1}`);
      deckIndex(deck);
      if (channels.some((d, i) => d === deck && i !== slot)) throw Error('the active pair needs two different decks; all channels must be distinct');
      channels[slot] = deck;
    },
    plan(deck, file, text, restart = true) {
      deckIndex(deck);
      const scene = parseScene(text, orbitsPerChannel);
      const previous = decks.get(deck);
      if (channels.includes(deck)) {
        for (const [other, record] of decks) {
          // Existing source metadata is not rewritten by a tempo ride. Unchanged
          // edits/restarts may keep it, but newcomers must match effective cps.
          const keepsDeclaration = tempoOverride !== undefined && previous && Math.abs(previous.scene.cps - scene.cps) < 1e-9;
          if (other !== deck && channels.includes(other) && !keepsDeclaration && Math.abs((tempoOverride ?? record.scene.cps) - scene.cps) > 1e-9) {
            throw Error('Active pair decks share one tempo: stop the other pair deck before changing cps (new scenes must match effective tempo)');
          }
        }
      }
      if (previous && !restart && Math.abs(previous.scene.cps - scene.cps) > 1e-9) throw Error('Tempo changes require an explicit scene restart');
      return { deck, file: path.resolve(file), text, scene, epoch: ++epoch, restart: restart || !previous };
    },
    commit(record) { decks.set(record.deck, record); },
    stop(deck) { deckIndex(deck); decks.delete(deck); },
    snapshot() {
      // Untouched default sessions retain exactly the historical snapshot shape.
      const result = { decks: registry.entries(), mix, pair: registry.pair };
      if (channelCount !== 2 || orbitsPerChannel !== 6 || gains[0] !== 1 - mix || gains[1] !== mix) Object.assign(result, { channels: registry.channels, gains: registry.gains, orbitsPerChannel });
      if (tempoOverride !== undefined) result.tempoOverride = tempoOverride;
      return result;
    },
    restoreSnapshot(saved) {
      registry.clear();
      try {
        if (saved.channels !== undefined) {
          if (saved.orbitsPerChannel !== orbitsPerChannel) throw Error('snapshot orbit configuration differs');
          registry.restoreChannels(saved.channels);
        } else if (saved.pair !== undefined) {
          if (!Array.isArray(saved.pair) || saved.pair.length !== 2 || new Set(saved.pair).size !== 2) throw Error('old scene snapshots need exactly two different pair decks');
          saved.pair.forEach(deckIndex);
          // Old pairs grow into the configured mixer without duplicate letters.
          const extra = defaults.filter(d => !saved.pair.includes(d));
          registry.restoreChannels([...saved.pair, ...extra].slice(0, channelCount));
        }
        registry.setTempoOverride(saved.tempoOverride);
        // Original declarations may differ after a ride; effective cps is global.
        for (const [deck, record] of saved.decks) {
          deckIndex(deck);
          if (decks.has(deck)) throw Error('duplicate deck in scene snapshot');
          registry.commit({ ...record, deck, scene: parseScene(record.text, orbitsPerChannel), epoch: ++epoch, restart: true });
        }
        if (tempoOverride === undefined) {
          const tempos = registry.entries().filter(([deck]) => channels.includes(deck)).map(([, record]) => record.scene.cps);
          if (tempos.some(cps => Math.abs(cps - tempos[0]) > 1e-9)) throw Error('Active pair decks share one tempo');
        }
        registry.setMix(saved.mix);
        if (saved.gains) registry.setGains(saved.gains);
      } catch (error) { registry.clear(); throw error; }
    },
    clear() { decks.clear(); mix = 0; channels = [...defaults]; gains = defaults.map((_, i) => i === 0 ? 1 : 0); tempoOverride = undefined; },
  };
  return registry;
}
