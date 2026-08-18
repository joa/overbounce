/**
 * Report which item MD3 surfaces would render untextured, for a given .pk3.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `loadMd3` falls back to a flat grey material when a surface's shader name
 * resolves to neither a shader script nor an image on disk, so "the items are
 * grey blobs" is not a rendering bug -- it is a packing bug, and this tells
 * you which files are missing rather than making you guess from a screenshot.
 *
 *   npx tsx tools/diag/item-textures.ts public/dev-q3dm6.pk3
 */

import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseMd3 } from '../../src/assets/md3.js';
import { mergeShaderFiles } from '../../src/assets/shader.js';
import { ITEMS, ItemType } from '../../src/game/items.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: tsx tools/diag/item-textures.ts <pak.pk3>');
  process.exit(2);
}

const fs = new Pk3FileSystem();
await fs.mount(basename(path), await openAsBlob(path));

const shaderTexts: string[] = [];
for (const p of fs.list({ prefix: 'scripts/' })) {
  if (p.endsWith('.shader')) {
    const text = await fs.readText(p);
    if (text) {
      shaderTexts.push(text);
    }
  }
}
const shaders = mergeShaderFiles(shaderTexts);

let ok = 0;
let viaShader = 0;
let missing = 0;
let stageMissing = 0;

for (const item of ITEMS) {
  if (item.type === ItemType.TEAM) {
    continue;
  }
  for (const model of item.models) {
    const bytes = await fs.readFile(model);
    if (!bytes) {
      continue;
    }
    for (const surface of parseMd3(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).surfaces) {
      for (const ref of surface.shaders) {
        const name = ref.replace(/\.(tga|jpg|jpeg|png)$/i, '');
        const shader = shaders.get(name);
        const image = fs.findImage(name);
        if (image) {
          ok++;
        } else if (shader) {
          viaShader++;
          // A shader resolves only as far as its stage images do. A quad's
          // envmap stage with no `models/powerups/quad.tga` behind it renders
          // exactly as grey as no shader at all.
          for (const stage of shader.stages) {
            for (const map of [stage.map, ...stage.animFrames]) {
              if (!map || stage.isLightmap || stage.isWhite) {
                continue;
              }
              if (!fs.findImage(map.replace(/\.(tga|jpg|jpeg|png)$/i, ''))) {
                console.log(`  STAGE    ${name} -> ${map}`);
                stageMissing++;
              }
            }
          }
        } else {
          missing++;
          console.log(`  MISSING  ${model} [${surface.name}] -> ${ref}`);
        }
      }
    }
  }
}

console.log(
  `\nitem surfaces: image=${ok} shaderOnly=${viaShader}` +
    ` missing=${missing} stageImagesMissing=${stageMissing}`,
);

// Non-zero on any gap, so this can gate a dev-pak build rather than only
// informing one.
process.exit(missing + stageMissing > 0 ? 1 : 0);
