// Preserve indented do/let/continuation bodies as one GHCi expression. Splitting
// each physical line broke valid do blocks and was incompatible with scene code.
export function tidalStatements(chunk) {
  const statements = [];
  for (const line of chunk.split('\n')) {
    if (!line.trim() || /^\s*--/.test(line)) continue;
    if (/^\s/.test(line) && statements.length) statements[statements.length - 1] += '\n' + line;
    else statements.push(line.trimEnd());
  }
  return statements;
}
