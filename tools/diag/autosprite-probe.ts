/**
 * What an `deformVertexes autosprite` surface actually looks like in the BSP.
 *
 * `AutospriteDeform` (tr_shade_calc.c:349) assumes "all the triangles for this
 * shader are independant quads" and takes the midpoint of every group of FOUR
 * consecutive vertices. If a BSP surface does not group that way -- more than
 * four verts, indices that are not the quad pattern, a vertex order that is not
 * corner-by-corner -- every sprite collapses toward a shared centroid, which
 * reads as "the glow is shifted off the lamp".
 *
 * Usage: npx tsx tools/diag/autosprite-probe.ts public/dev-q3dm6.pk3 q3dm6
 */
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

const typeName = (t: number): string =>
  ({ 1: 'PLANAR', 2: 'PATCH', 3: 'TRISOUP', 4: 'FLARE' })[t] ?? `?${t}`;

const groups = new Map<string, number[]>();
for (let i = 0; i < bsp.surfaces.length; i++) {
  const entry = bsp.shaders[bsp.surfaces[i].shaderNum];
  if (!entry) continue;
  const sh = shaders.get(shaderKey(entry.shader));
  if (!sh) continue;
  const d = sh.deforms.find((x) => x.type === 'autosprite' || x.type === 'autosprite2');
  if (!d) continue;
  const key = `${entry.shader} [${d.type}]`;
  const list = groups.get(key) ?? [];
  list.push(i);
  groups.set(key, list);
}

for (const [key, list] of groups) {
  console.log(`\n=== ${key}  (${list.length} surfaces)`);
  const byShape = new Map<string, number>();
  for (const i of list) {
    const s = bsp.surfaces[i];
    const shape = `${typeName(s.surfaceType)} verts=${s.numVerts} idx=${s.numIndexes}`;
    byShape.set(shape, (byShape.get(shape) ?? 0) + 1);
  }
  for (const [shape, n] of byShape) console.log(`   ${n} x ${shape}`);

  // Detail on the first three.
  for (const i of list.slice(0, 3)) {
    const s = bsp.surfaces[i];
    const v = (k: number): [number, number, number] => [
      bsp.drawVerts[(s.firstVert + k) * 3],
      bsp.drawVerts[(s.firstVert + k) * 3 + 1],
      bsp.drawVerts[(s.firstVert + k) * 3 + 2],
    ];
    const idx: number[] = [];
    for (let k = 0; k < s.numIndexes; k++) idx.push(bsp.drawIndexes[s.firstIndex + k]);
    const mins = [Infinity, Infinity, Infinity];
    const maxs = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < s.numVerts; k++) {
      const p = v(k);
      for (let a = 0; a < 3; a++) {
        mins[a] = Math.min(mins[a], p[a]);
        maxs[a] = Math.max(maxs[a], p[a]);
      }
    }
    console.log(`  surface ${i}: verts=${s.numVerts} indexes=${s.numIndexes}`);
    console.log(`    indices: ${idx.join(',')}`);
    for (let k = 0; k < s.numVerts; k++) {
      const p = v(k);
      console.log(
        `    v${k} = ${p.map((x) => x.toFixed(1)).join(', ')}` +
          `   st=${bsp.drawSt[(s.firstVert + k) * 2].toFixed(3)},` +
          `${bsp.drawSt[(s.firstVert + k) * 2 + 1].toFixed(3)}`,
      );
    }
    console.log(`    bounds mins=${mins.map((x) => x.toFixed(1))} maxs=${maxs.map((x) => x.toFixed(1))}`);
    // The centre this project computes, per group of four.
    for (let q = 0; q * 4 + 3 < s.numVerts; q++) {
      const mid = [0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const p = v(q * 4 + k);
        for (let a = 0; a < 3; a++) mid[a] += p[a] * 0.25;
      }
      const d0 = v(q * 4);
      const r = Math.hypot(d0[0] - mid[0], d0[1] - mid[1], d0[2] - mid[2]) * 0.707;
      console.log(`    quad ${q}: mid=${mid.map((x) => x.toFixed(1))} radius=${r.toFixed(1)}`);
    }
  }
}
