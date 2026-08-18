/**
 * Every shader a map's surfaces name, with what our parser made of it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `blend-surfaces.ts` answers "what ends up translucent". This answers the
 * broader question that comes first: what is in the map at all, and which
 * shaders carry the markers -- polygonOffset, alphaFunc, sort -- that say a
 * surface is a decal layered over another one.
 *
 *   npx tsx tools/diag/map-shaders.ts public/dev-q3dm17.pk3 q3dm17 [filter]
 */

import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { mergeShaderFiles, shaderKey } from '../../src/assets/shader.js';

const [pak, map, filter] = process.argv.slice(2);
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

const used = new Map<string, number>();
for (const surf of bsp.surfaces) {
  const name = bsp.shaders[surf.shaderNum]?.shader ?? '';
  used.set(name, (used.get(name) ?? 0) + 1);
}

for (const [name, count] of [...used].sort((a, b) => b[1] - a[1])) {
  if (filter && !name.includes(filter)) {
    continue;
  }
  const sh = shaders.get(shaderKey(name));
  if (!sh) {
    console.log(`${String(count).padStart(4)}  ${name}   (no .shader -- plain image)`);
    continue;
  }
  const marks: string[] = [];
  const stages = sh.stages
    .map((st, i) => {
      const bits = [st.isLightmap ? '$lightmap' : (st.map ?? (st.isWhite ? '$whiteimage' : '-'))];
      if (st.blend.length) bits.push(st.blend.join(' '));
      if (st.alphaFunc) bits.push(`alphaFunc ${st.alphaFunc}`);
      if (st.directives.has('depthwrite')) bits.push('depthWrite');
      if (st.directives.has('depthfunc')) bits.push(`depthFunc ${st.directives.get('depthfunc')?.join(' ')}`);
      return `      [${i}] ${bits.join('  |  ')}`;
    })
    .join('\n');
  if (sh.surfaceparms.size) marks.push(`surfaceparm ${[...sh.surfaceparms].join(',')}`);
  if (!sh.lightmapped) marks.push('nolightmap');
  if (sh.twoSided) marks.push('cull none');
  console.log(`${String(count).padStart(4)}  ${name}  ${marks.join(' ')}`);
  console.log(stages);
}
