/** Ask a Quake install whether an image reference resolves at all. */
import { openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';

const base = process.env.Q3_BASEQ3;
if (!base) {
  console.error('set Q3_BASEQ3');
  process.exit(2);
}
const fs = new Pk3FileSystem();
for (const name of readdirSync(base).filter((n) => n.toLowerCase().endsWith('.pk3')).sort()) {
  await fs.mount(name, await openAsBlob(join(base, name)));
}
for (const ref of process.argv.slice(2)) {
  console.log(`${ref} -> ${fs.findImage(ref.replace(/\.(tga|jpg|jpeg|png)$/i, '')) ?? 'NOT FOUND'}`);
}
