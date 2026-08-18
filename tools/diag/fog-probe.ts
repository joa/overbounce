/** What fog volumes a map declares, and which surfaces claim them. */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { mergeShaderFiles, shaderKey } from '../../src/assets/shader.js';
import { fogIndexOf, loadFogs } from '../../src/render/fog.js';

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

// `loadFogs` is the thing under test: the 1-based table with the sentinel at 0.
const table = loadFogs(bsp, shaders);
console.log(`\nloadFogs table length ${table.length} (entry 0 is the sentinel):`);
for (let i = 0; i < table.length; i++) {
  const f = table[i];
  console.log(
    `  [${i}] ${
      f
        ? `brush=${f.originalBrushNumber} colour=${f.color.map((c) => c.toFixed(2))} ` +
          `depth=${f.depthForOpaque} hasSurface=${f.hasSurface} ` +
          `bounds=${JSON.stringify(f.bounds)}`
        : 'null (no fog)'
    }`,
  );
}

const claimed = new Map<number, number>();
for (const s of bsp.surfaces) {
  const n = (s as unknown as { fogNum?: number }).fogNum ?? -1;
  claimed.set(n, (claimed.get(n) ?? 0) + 1);
}
console.log('\nsurfaces by fogNum:', [...claimed].sort((a, b) => a[0] - b[0]));

// Which surfaces belong to each volume, and which of them are the volume's own
// "fogonly" faces -- the ones RB_FogPass draws for FP_LE.
for (let i = 1; i < table.length; i++) {
  if (!table[i]) continue;
  let own = 0;
  let stageless = 0;
  for (const s of bsp.surfaces) {
    if (fogIndexOf(s.fogNum, table) !== i) continue;
    own++;
    const entry = bsp.shaders[s.shaderNum];
    const sh = entry ? shaders.get(shaderKey(entry.shader)) : undefined;
    if (sh && sh.stages.length === 0 && sh.surfaceparms.has('fog')) stageless++;
  }
  console.log(`  fog[${i}]: ${own} surfaces inside, ${stageless} of them stage-less fogonly faces`);
}

// A point, if one was given: which volume is it in?
const at = process.argv.slice(5, 8).map(Number);
if (at.length === 3 && at.every(Number.isFinite)) {
  for (let i = 1; i < table.length; i++) {
    const f = table[i];
    if (!f) continue;
    const inside = at.every((v, a) => v >= f.bounds[0][a] && v <= f.bounds[1][a]);
    console.log(`point ${at} ${inside ? 'IS' : 'is not'} inside fog[${i}]`);
  }
}
