// Minimal .tidal scene reader for the audition job runner. Mirrors the format
// rules of lib/scenes.mjs (kept independent so this lane does not depend on the
// plugin's lib/**): one `-- @scene {...}` header, optional `{- @sc ... -}`
// blocks, and d1..d16 lanes with literal `# orbit N`. Only what the audition
// render needs is implemented — no registry, no mixer.

// Split a scene into its Tidal text (everything that reaches GHCi) and its
// `@sc` block bodies. Mirrors lib/scenes.mjs: `--` line comments, quoted
// mini-notation and `{- ... -}` blocks are all preserved/blanked correctly.
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
      tidal += body.replace(/[^\n]/g, ' '); i += 2;
    } else tidal += text[i++];
  }
  return { tidal, sc };
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

// Parse a scene for the audition render. Returns cps/quantize/title, the SC
// block source, the `let` bindings, and per-lane local orbit + pattern.
export function parseScene(text, orbitsPerChannel = 6) {
  if (!Number.isInteger(orbitsPerChannel) || orbitsPerChannel < 1 || orbitsPerChannel > 16) {
    throw Error('orbitsPerChannel must be an integer 1..16');
  }
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

  const statements = [];
  for (const line of tidal.split('\n')) {
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
    const outsideStrings = pattern.replace(/"(?:\\.|[^"\\])*"/g, '""');
    const orbitUses = [...outsideStrings.matchAll(/\borbit\b/g)];
    const literalUses = [...outsideStrings.matchAll(/#\s*orbit\s+(\d+)(?=\s|$|\))/g)];
    if (orbitUses.length !== literalUses.length || literalUses.some(m => Number(m[1]) >= orbitsPerChannel)) {
      throw Error(`Scene orbit must be a literal # orbit 0..${orbitsPerChannel - 1}`);
    }
    const orbit = literalUses.length ? Number(literalUses.at(-1)[1]) : Math.min(lane - 1, orbitsPerChannel - 1);
    lanes.push({ lane, orbit, pattern });
  }
  if (!lanes.length) throw Error('Scene has no d1..d16 lanes');
  return { ...options, cps, quantize, sc: sc.join('\n'), lanes, bindings };
}

// Physical orbit for a scene's LOCAL orbit inside a channel slot. This is the
// scene-mode remap (`base = slot * K`) that lib/scenes.mjs.patternExpression
// performs live; the scene text's own `# orbit N` is overridden by the
// appended physical value.
export function physicalOrbit(slot, localOrbit, orbitsPerChannel = 6) {
  return slot * orbitsPerChannel + localOrbit;
}

// The Tidal expression for a scene rendered in one channel slot: a `stack` of
// each lane with its orbit remapped into the slot's physical block, wrapped in
// the scene's `let` bindings when present.
export function patternExpression(scene, slot, orbitsPerChannel = 6) {
  const stack = `stack [${scene.lanes.map(l =>
    `((${l.pattern}) # orbit ${physicalOrbit(slot, l.orbit, orbitsPerChannel)})`).join(', ')}]`;
  return scene.bindings.length ? `(let { ${scene.bindings.join('; ')} } in ${stack})` : stack;
}
