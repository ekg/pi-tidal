// sclang's readline stdin evaluates each physical line. Parenthesized multiline
// text is NOT an atomic stdin command. Preserve the source in a file and submit
// only its loader as one physical line (including // comments and leading vars).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createSclangTransport(write) {
  let dir;
  let sequence = 0;
  return {
    send(source, label = 'pi-tidal') {
      dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tidal-sc-'));
      const file = path.join(dir, `${++sequence}.scd`);
      fs.writeFileSync(file, source + '\n', { mode: 0o600 });
      const quoted = JSON.stringify(file);
      const command = `${JSON.stringify(label)}.postln; protect { this.executeFile(${quoted}) } { File.delete(${quoted}) };\n`;
      try { write(command); } catch (error) {
        fs.rmSync(file, { force: true });
        throw error;
      }
      return file;
    },
    dispose() {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    },
  };
}
