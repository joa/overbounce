/**
 * Check `makeMeshNormals` against the normals q3map baked into a real map.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The port of `MakeMeshNormals` has one way to be silently, catastrophically
 * wrong: the cross product in the wrong order, which flips every patch normal
 * in the map. Nothing about the geometry looks different — the winding is
 * unchanged — but lighting inverts and `deformVertexes bulge` pushes INTO the
 * surface instead of out of it.
 *
 * q3map already wrote a normal at every control point, so the map itself is
 * the oracle. A control point sits exactly on a grid vertex (Bezier at u=0 or
 * u=1 hits the endpoint), so the two are directly comparable, and agreement
 * means `dot > 0` — the smoothed normal need not equal the stored one, only
 * point the same way.
 *
 *   npx tsx tools/diag/patch-normals.ts q3dm4 public/dev-q3dm4.pk3
 */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { SurfaceType } from '../../src/collision/bsp.js';
import { PATCH_SUBDIVISIONS, makeMeshNormals, tessellatePatch } from '../../src/render/bsp-mesh.js';

const map = process.argv[2];
const fs = new Pk3FileSystem();
for (const p of process.argv.slice(3)) {
  await fs.mount(basename(p), await openAsBlob(p));
}

const bytes = (await fs.readFile(`maps/${map}.bsp`))!;
const bsp = parseBsp(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
);

let patches = 0;
let compared = 0;
let agree = 0;
let worst = 1;
let worstAt = '';

for (let i = 0; i < bsp.surfaces.length; i++) {
  const s = bsp.surfaces[i];
  if (s.surfaceType !== SurfaceType.PATCH) continue;
  const w = s.patchWidth;
  const h = s.patchHeight;
  if (w < 3 || h < 3) continue;
  patches++;

  const grid = tessellatePatch(bsp, i);
  if (!grid) continue;
  const normals = makeMeshNormals(grid.width, grid.height, grid.xyz);

  // Control point (cx, cy) lands on grid vertex (cx * SUB/2, cy * SUB/2) only
  // for even cx/cy -- the ones that are a sub-patch corner. Those are the
  // control points that lie ON the surface; the odd ones are off-curve
  // handles, whose stored normal is not a normal of any grid vertex.
  for (let cy = 0; cy < h; cy += 2) {
    for (let cx = 0; cx < w; cx += 2) {
      const gx = (cx / 2) * PATCH_SUBDIVISIONS;
      const gy = (cy / 2) * PATCH_SUBDIVISIONS;
      const g = (gx * grid.height + gy) * 3;
      const v = (s.firstVert + cy * w + cx) * 3;

      const dot =
        normals[g] * bsp.drawNormals[v] +
        normals[g + 1] * bsp.drawNormals[v + 1] +
        normals[g + 2] * bsp.drawNormals[v + 2];
      // A zero normal is the degenerate case id also leaves zeroed.
      if (normals[g] === 0 && normals[g + 1] === 0 && normals[g + 2] === 0) continue;

      compared++;
      if (dot > 0) agree++;
      if (dot < worst) {
        worst = dot;
        worstAt = `surface #${i} ctrl (${cx},${cy})`;
      }
    }
  }
}

console.log(`${map}: ${patches} patches, ${compared} control points compared`);
console.log(`  same side as q3map: ${agree}/${compared} (${((100 * agree) / compared).toFixed(1)}%)`);
console.log(`  worst dot: ${worst.toFixed(3)}  at ${worstAt}`);
