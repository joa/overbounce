/**
 * Which of a map's surfaces are drawn translucent, and which way they face.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A translucent surface does not write depth, so anything drawn after it shows
 * through. That is correct for a lamp glow and wrong for a floor, and the only
 * way to tell them apart is to look at what the map actually marked.
 *
 *   npx tsx tools/diag/blend-surfaces.ts public/dev-q3dm6.pk3 q3dm6
 */

import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { mergeShaderFiles } from '../../src/assets/shader.js';
import {
  isAdditiveStage,
  isAlphaBlendedStage,
  isFilterStage,
  shaderBlendBase,
  shaderKey,
} from '../../src/assets/shader.js';

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

interface Row {
  name: string;
  kind: string;
  surfaces: number;
  /** How many of them face mostly up — i.e. are walkable floor. */
  facingUp: number;
}
const rows = new Map<string, Row>();

for (const surf of bsp.surfaces) {
  const name = bsp.shaders[surf.shaderNum]?.shader ?? '';
  const shader = shaders.get(shaderKey(name));
  if (!shader) {
    continue;
  }
  // Stage 0 decides, not the diffuse -- see `shaderBlendBase`.
  const base = shaderBlendBase(shader);
  if (!base) {
    continue;
  }

  let kind = '';
  if (isAdditiveStage(base)) kind = 'additive';
  else if (isFilterStage(base)) kind = 'filter';
  else if (isAlphaBlendedStage(base)) kind = 'blend';
  if (!kind) {
    continue;
  }

  const row = rows.get(name) ?? { name, kind, surfaces: 0, facingUp: 0 };
  row.surfaces++;
  // The collision parser keeps positions only, so "horizontal" is inferred
  // from them: every vertex at the same z is a floor or a ceiling, and both
  // are things you should not be able to see through.
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < surf.numVerts; i++) {
    const z = bsp.drawVerts[(surf.firstVert + i) * 3 + 2];
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (surf.numVerts > 2 && maxZ - minZ < 0.5) {
    row.facingUp++;
  }
  rows.set(name, row);
}

const all = [...rows.values()].sort((a, b) => b.surfaces - a.surfaces);
for (const r of all) {
  const flag = r.facingUp > 0 ? `  <-- ${r.facingUp} HORIZONTAL` : '';
  console.log(`${r.kind.padEnd(9)} ${String(r.surfaces).padStart(4)}  ${r.name}${flag}`);
}
console.log(`\n${all.length} translucent shaders, ${all.reduce((n, r) => n + r.surfaces, 0)} surfaces`);
