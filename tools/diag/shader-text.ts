/**
 * The raw `.shader` source of a named shader, exactly as it appears in the pak.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The parsed form tells you what we made of a shader; this tells you what the
 * shader actually says. Diagnosing a shader bug needs both, side by side.
 *
 *   PAK=public/dev-q3dm17.pk3 npx tsx tools/diag/shader-text.ts <name>...
 */

import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';

const p = process.env.PAK ?? 'public/dev-q3dm6.pk3';
const fs = new Pk3FileSystem();
await fs.mount(basename(p), await openAsBlob(p));

const files: [string, string][] = [];
for (const path of fs.list({ prefix: 'scripts/' })) {
  if (path.endsWith('.shader')) {
    const t = await fs.readText(path);
    if (t) files.push([path, t]);
  }
}

for (const wanted of process.argv.slice(2)) {
  let found = false;
  for (const [path, text] of files) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().toLowerCase() !== wanted.toLowerCase()) {
        continue;
      }
      // Print from the name to the brace that closes it.
      let depth = 0;
      let started = false;
      const out: string[] = [];
      for (let j = i; j < lines.length; j++) {
        out.push(lines[j]);
        for (const ch of lines[j]) {
          if (ch === '{') {
            depth++;
            started = true;
          } else if (ch === '}') {
            depth--;
          }
        }
        if (started && depth === 0) break;
      }
      console.log(`--- ${path}:${i + 1}`);
      console.log(out.join('\n'));
      found = true;
    }
  }
  if (!found) {
    console.log(`--- ${wanted}: NOT DECLARED in any .shader`);
  }
}
