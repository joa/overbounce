/** What fog volumes a map declares, and which surfaces claim them. */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { mergeShaderFiles, shaderKey } from '../../src/assets/shader.js';

const [pak, map] = process.argv.slice(2);
const fs = new Pk3FileSystem();
await fs.mount(basename(pak), await openAsBlob(pak));
const texts: string[] = [];
for (const p of fs.list({ prefix: 'scripts/' })) {
  if (p.endsWith('.shader')) {
    const t = await fs.readText(p);
    if (t) texts.push(t);
  }
}
const shaders = mergeShaderFiles(texts);
const bytes = (await fs.readFile(`maps/${map}.bsp`))!;
const bsp = parseBsp(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
);

const fogs = (bsp as unknown as { fogs?: { shader: string; brushNum: number }[] }).fogs;
console.log(`LUMP_FOGS entries: ${fogs ? fogs.length : 'NOT PARSED'}`);
for (const f of fogs ?? []) {
  const sh = shaders.get(shaderKey(f.shader));
  console.log(
    `  ${f.shader}  brush=${f.brushNum}  stages=${sh ? sh.stages.length : 'no shader'}` +
      `  fogParms=${sh?.fogParms ? JSON.stringify(sh.fogParms) : 'none'}`,
  );
}

const claimed = new Map<number, number>();
for (const s of bsp.surfaces) {
  const n = (s as unknown as { fogNum?: number }).fogNum ?? -1;
  claimed.set(n, (claimed.get(n) ?? 0) + 1);
}
console.log('surfaces by fogNum:', [...claimed].sort((a, b) => a[0] - b[0]));
