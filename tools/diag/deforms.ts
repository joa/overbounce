/**
 * Every deforming shader a map's surfaces name, with the deform our parser made
 * of it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `map-shaders.ts` answers "what is in the map"; this narrows it to the
 * surfaces whose VERTICES move, which is the set `bsp-mesh.ts` has to give a
 * vertex expression and a bounding volume that survives it.
 *
 *   npx tsx tools/diag/deforms.ts q3dm4 public/dev-q3dm4.pk3 public/pak0.pk3
 */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { mergeShaderFiles, shaderKey } from '../../src/assets/shader.js';
import { SurfaceType } from '../../src/collision/bsp.js';

const TYPE: Record<number, string> = {
  0: 'BAD',
  1: 'PLANAR',
  2: 'PATCH',
  3: 'TRISOUP',
  4: 'FLARE',
};

const map = process.argv[2];
const fs = new Pk3FileSystem();
for (const p of process.argv.slice(3)) {
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

const bytes = (await fs.readFile(`maps/${map}.bsp`))!;
const bsp = parseBsp(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
);

const used = new Map<string, number[]>();
for (let i = 0; i < bsp.surfaces.length; i++) {
  const n = bsp.shaders[bsp.surfaces[i].shaderNum]?.shader ?? '';
  const list = used.get(n);
  if (list) list.push(i);
  else used.set(n, [i]);
}

for (const [name, indices] of [...used].sort((a, b) => b[1].length - a[1].length)) {
  const sh = shaders.get(shaderKey(name));
  if (!sh || !sh.deforms.length) continue;
  console.log(`${String(indices.length).padStart(4)}  ${name}`);
  for (const d of sh.deforms) console.log(`        deform ${JSON.stringify(d)}`);

  // The batch key `bsp-mesh.ts` uses, minus the owner: two surfaces that differ
  // here cannot share a mesh, and a deform that reads `normalLocal` at a seam
  // then has two chances to disagree with itself.
  const keys = new Set<string>();
  for (const i of indices) {
    const s = bsp.surfaces[i];
    const mins = [Infinity, Infinity, Infinity];
    const maxs = [-Infinity, -Infinity, -Infinity];
    for (let v = s.firstVert; v < s.firstVert + s.numVerts; v++) {
      for (let k = 0; k < 3; k++) {
        const c = bsp.drawVerts[v * 3 + k];
        if (c < mins[k]) mins[k] = c;
        if (c > maxs[k]) maxs[k] = c;
      }
    }
    const mid = mins.map((m, k) => Math.round((m + maxs[k]) / 2));
    keys.add(`${s.shaderNum}:${s.lightmapNum}:${s.fogNum}`);
    console.log(
      `        #${String(i).padStart(4)} ${TYPE[s.surfaceType]}` +
        (s.surfaceType === SurfaceType.PATCH ? ` ${s.patchWidth}x${s.patchHeight}` : '') +
        ` verts=${s.numVerts} lm=${s.lightmapNum} fog=${s.fogNum}` +
        ` mid=${mid.join(',')} size=${maxs.map((m, k) => Math.round(m - mins[k])).join('x')}`,
    );
  }
  console.log(`        -> ${keys.size} batch(es)`);
}
