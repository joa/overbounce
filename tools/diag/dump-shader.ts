/** Print a parsed shader's stages, from a pak set. */
import { openAsBlob, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { mergeShaderFiles } from '../../src/assets/shader.js';

const src = process.env.Q3_BASEQ3;
const fs = new Pk3FileSystem();
if (src) {
  for (const n of readdirSync(src).filter((n) => n.toLowerCase().endsWith('.pk3')).sort()) {
    await fs.mount(n, await openAsBlob(join(src, n)));
  }
} else {
  const p = process.env.PAK ?? 'public/dev-q3dm6.pk3';
  await fs.mount(basename(p), await openAsBlob(p));
}
const texts: string[] = [];
for (const p of fs.list({ prefix: 'scripts/' })) {
  if (p.endsWith('.shader')) {
    const t = await fs.readText(p);
    if (t) texts.push(t);
  }
}
const shaders = mergeShaderFiles(texts);
for (const name of process.argv.slice(2)) {
  const s = shaders.get(name);
  console.log(name, s ? JSON.stringify(s.stages.map((st) => ({ map: st.map, anim: st.animFrames })), null, 1) : 'NOT FOUND');
}
