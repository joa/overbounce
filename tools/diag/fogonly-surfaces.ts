/** Which surfaces carry a stage-less "fogonly" shader, and what fog they claim. */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { mergeShaderFiles, shaderKey } from '../../src/assets/shader.js';
import { fogIndexOf, isFogOnlyShader, loadFogs } from '../../src/render/fog.js';

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
const fogs = loadFogs(bsp, shaders);

for (let i = 0; i < bsp.surfaces.length; i++) {
  const s = bsp.surfaces[i];
  const entry = bsp.shaders[s.shaderNum];
  const declared = shaders.get(shaderKey(entry.shader)) ?? null;
  const isFogShader = declared?.fogParms != null || declared?.surfaceparms.has('fog');
  if (!isFogShader) continue;
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < s.numVerts; k++) {
    for (let a = 0; a < 3; a++) {
      const v = bsp.drawVerts[(s.firstVert + k) * 3 + a];
      mins[a] = Math.min(mins[a], v);
      maxs[a] = Math.max(maxs[a], v);
    }
  }
  console.log(
    `${entry.shader}  stages=${declared?.stages.length}  fogonly=${isFogOnlyShader(declared)}` +
      `  fogNum=${s.fogNum} -> table ${fogIndexOf(s.fogNum, fogs)}` +
      `  contentFlags=0x${entry.contentFlags.toString(16)} surfaceFlags=0x${entry.surfaceFlags.toString(16)}` +
      `  verts=${s.numVerts}  mins=${mins.map((v) => v.toFixed(0))} maxs=${maxs.map((v) => v.toFixed(0))}`,
  );
}
