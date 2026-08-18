/**
 * What is drawn on the floor directly under each item spawn.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Weapon and item spawns in Quake maps usually sit on a decal: a separate,
 * co-planar world surface whose shader glows. Finding it by name is guesswork,
 * so this finds it by POSITION -- every surface whose vertices sit within a
 * short radius of an item entity's origin, nearest first.
 *
 *   npx tsx tools/diag/pad-surfaces.ts public/dev-q3dm17.pk3 q3dm17
 */

import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { parseEntities } from '../../src/collision/cm-load.js';

const [pak, map] = process.argv.slice(2);
const fs = new Pk3FileSystem();
await fs.mount(basename(pak), await openAsBlob(pak));

const bytes = (await fs.readFile(`maps/${map}.bsp`))!;
const bsp = parseBsp(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
);

const ents = parseEntities(bsp.entities);

for (const ent of ents) {
  const cls = ent['classname'] ?? '';
  if (!/^(weapon|item|ammo)_/.test(cls)) {
    continue;
  }
  const origin = (ent['origin'] ?? '0 0 0').split(/\s+/).map(Number);

  const near: { d: number; name: string; verts: number; z: number }[] = [];
  for (const surf of bsp.surfaces) {
    let best = Infinity;
    let z = 0;
    for (let i = 0; i < surf.numVerts; i++) {
      const v = (surf.firstVert + i) * 3;
      const dx = bsp.drawVerts[v] - origin[0];
      const dy = bsp.drawVerts[v + 1] - origin[1];
      const dz = bsp.drawVerts[v + 2] - origin[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < best) {
        best = d;
        z = bsp.drawVerts[v + 2];
      }
    }
    if (best < 64) {
      near.push({ d: best, name: bsp.shaders[surf.shaderNum]?.shader ?? '?', verts: surf.numVerts, z });
    }
  }
  near.sort((a, b) => a.d - b.d);

  console.log(`${cls} @ ${origin.join(',')}`);
  for (const n of near.slice(0, 6)) {
    console.log(`   ${n.d.toFixed(1).padStart(6)}  z=${n.z.toFixed(0).padStart(5)}  ${n.name}`);
  }
}
