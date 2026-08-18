/**
 * Are MD3 triangles wound the way three.js expects?
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The oracle is the model's OWN per-vertex normals. A triangle is correctly
 * wound when the normal you get from its winding (counter-clockwise = front,
 * which is three's `FrontSide`) agrees with the normals the artist baked in.
 * This is the same test that settled the BSP winding question; MD3 carries
 * normals per vertex, so it answers just as cleanly.
 *
 *   npx tsx tools/diag/md3-winding.ts public/dev-q3dm6.pk3 models/...md3
 */

import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseMd3 } from '../../src/assets/md3.js';

const [pak, ...models] = process.argv.slice(2);
const fs = new Pk3FileSystem();
await fs.mount(basename(pak), await openAsBlob(pak));

for (const path of models) {
  const bytes = await fs.readFile(path);
  if (!bytes) {
    console.log(`${path}: not in pak`);
    continue;
  }
  const model = parseMd3(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );

  let agree = 0;
  let disagree = 0;

  for (const surface of model.surfaces) {
    // Frame 0 only: winding is shared by every frame.
    for (let t = 0; t + 2 < surface.indices.length; t += 3) {
      const [ia, ib, ic] = [surface.indices[t], surface.indices[t + 1], surface.indices[t + 2]];
      const p = (i: number): [number, number, number] => [
        surface.xyz[i * 3],
        surface.xyz[i * 3 + 1],
        surface.xyz[i * 3 + 2],
      ];
      const [ax, ay, az] = p(ia);
      const [bx, by, bz] = p(ib);
      const [cx, cy, cz] = p(ic);

      // Counter-clockwise winding normal: (b-a) x (c-a).
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;

      // The artist's normal, averaged over the three vertices.
      const n = surface.normals;
      const anx = (n[ia * 3] + n[ib * 3] + n[ic * 3]) / 3;
      const any = (n[ia * 3 + 1] + n[ib * 3 + 1] + n[ic * 3 + 1]) / 3;
      const anz = (n[ia * 3 + 2] + n[ib * 3 + 2] + n[ic * 3 + 2]) / 3;

      const dot = nx * anx + ny * any + nz * anz;
      if (dot > 0) {
        agree++;
      } else if (dot < 0) {
        disagree++;
      }
    }
  }

  const verdict = disagree > agree ? '  <-- WOUND BACKWARDS' : '';
  console.log(`${path}\n    agree=${agree} disagree=${disagree}${verdict}`);
}
