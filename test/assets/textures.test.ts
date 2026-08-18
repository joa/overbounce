/**
 * TGA decoding and .skin parsing.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Real Quake III assets are used when Q3_BASEQ3 points at a baseq3 directory.
 * Nothing is committed; see pk3.test.ts.
 */

import { existsSync, openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { decodeTga } from '../../src/assets/tga.js';
import { parseSkin, shaderForSurface } from '../../src/assets/skin.js';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseMd3 } from '../../src/assets/md3.js';

/** Build an uncompressed 24-bit TGA. Pixels are BGR, bottom row first. */
function makeTga(
  width: number,
  height: number,
  bgrRows: number[][],
  topDown = false,
): Uint8Array {
  const out = new Uint8Array(18 + width * height * 3);
  const v = new DataView(out.buffer);
  v.setUint8(2, 2); // uncompressed true colour
  v.setUint16(12, width, true);
  v.setUint16(14, height, true);
  v.setUint8(16, 24);
  v.setUint8(17, topDown ? 0x20 : 0);
  let p = 18;
  for (const row of bgrRows) {
    for (const c of row) {
      out[p++] = c;
    }
  }
  return out;
}

describe('TGA decoding', () => {
  it('decodes a 24-bit image and converts BGR to RGBA', () => {
    // One pixel, stored BGR as (blue=1, green=2, red=3).
    const img = decodeTga(makeTga(1, 1, [[1, 2, 3]], true));
    expect(img.width).toBe(1);
    expect(img.height).toBe(1);
    expect(Array.from(img.data)).toEqual([3, 2, 1, 255]);
  });

  it('flips bottom-up images, which is the usual storage order', () => {
    // Two rows, bottom row first: bottom is red, top is blue.
    const bottomUp = makeTga(1, 2, [
      [0, 0, 255], // BGR red  -> stored first -> BOTTOM row
      [255, 0, 0], // BGR blue -> stored second -> TOP row
    ]);
    const img = decodeTga(bottomUp);
    // Output is top row first, so blue must come out first.
    expect(Array.from(img.data.slice(0, 4))).toEqual([0, 0, 255, 255]);
    expect(Array.from(img.data.slice(4, 8))).toEqual([255, 0, 0, 255]);
  });

  it('honours the top-down descriptor bit', () => {
    const topDown = makeTga(1, 2, [[0, 0, 255], [255, 0, 0]], true);
    const img = decodeTga(topDown);
    expect(Array.from(img.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it('decodes RLE images', () => {
    // Header, then one run-length packet of 4 identical pixels.
    const out = new Uint8Array(18 + 1 + 3);
    const v = new DataView(out.buffer);
    v.setUint8(2, 10); // RLE true colour
    v.setUint16(12, 2, true);
    v.setUint16(14, 2, true);
    v.setUint8(16, 24);
    v.setUint8(17, 0x20);
    out[18] = 0x80 | 3; // run of 4
    out[19] = 10;
    out[20] = 20;
    out[21] = 30;

    const img = decodeTga(out);
    expect(img.width).toBe(2);
    expect(img.data.length).toBe(2 * 2 * 4);
    for (let i = 0; i < 4; i++) {
      expect(Array.from(img.data.slice(i * 4, i * 4 + 4))).toEqual([30, 20, 10, 255]);
    }
  });

  it('rejects colour-mapped files rather than half-decoding them', () => {
    const out = new Uint8Array(64);
    new DataView(out.buffer).setUint8(2, 1);
    expect(() => decodeTga(out)).toThrow(/colour-mapped/);
  });
});

describe('.skin parsing', () => {
  it('maps surfaces to shaders', () => {
    const skin = parseSkin(
      'u_torso,models/players/sarge/sarge.tga\nu_rshoulder,models/players/sarge/sarge.tga\n',
    );
    expect(skin.surfaces.get('u_torso')).toBe('models/players/sarge/sarge.tga');
    expect(skin.surfaces.size).toBe(2);
  });

  it('ignores tags, blank shaders and comments', () => {
    const skin = parseSkin(
      ['// a comment', 'tag_head,', 'u_torso,tex.tga', 'nodraw,', ''].join('\n'),
    );
    expect(skin.surfaces.size).toBe(1);
    expect(skin.surfaces.has('tag_head')).toBe(false);
    expect(skin.surfaces.has('nodraw')).toBe(false);
  });

  it('falls back to the shader baked into the MD3', () => {
    const skin = parseSkin('u_torso,from_skin.tga');
    expect(shaderForSurface(skin, 'u_torso', 'from_md3.tga')).toBe('from_skin.tga');
    expect(shaderForSurface(skin, 'u_other', 'from_md3.tga')).toBe('from_md3.tga');
    expect(shaderForSurface(null, 'u_torso', 'from_md3.tga')).toBe('from_md3.tga');
    expect(shaderForSurface(null, 'u_torso', undefined)).toBeNull();
  });
});

const baseq3 = process.env.Q3_BASEQ3;
const available = !!baseq3 && existsSync(baseq3);

describe.skipIf(!available)('real Quake III player assets', () => {
  async function mount(): Promise<Pk3FileSystem> {
    const fs = new Pk3FileSystem();
    for (const n of readdirSync(baseq3!).filter((f) => f.toLowerCase().endsWith('.pk3')).sort()) {
      await fs.mount(n, await openAsBlob(join(baseq3!, n)));
    }
    return fs;
  }

  it('resolves every surface of sarge to a texture that decodes', async () => {
    const fs = await mount();

    for (const part of ['lower', 'upper', 'head'] as const) {
      const md3Bytes = await fs.readFile(`models/players/sarge/${part}.md3`);
      expect(md3Bytes).not.toBeNull();
      const model = parseMd3(
        md3Bytes!.buffer.slice(
          md3Bytes!.byteOffset,
          md3Bytes!.byteOffset + md3Bytes!.byteLength,
        ) as ArrayBuffer,
      );

      const skinText = await fs.readText(`models/players/sarge/${part}_default.skin`);
      expect(skinText).not.toBeNull();
      const skin = parseSkin(skinText!);

      for (const surface of model.surfaces) {
        const reference = shaderForSurface(skin, surface.name, surface.shaders[0]);
        expect(reference).not.toBeNull();

        const path = fs.findImage(reference!);
        expect(path, `no image for ${part}/${surface.name} -> ${reference}`).not.toBeNull();

        if (path!.endsWith('.tga')) {
          const bytes = await fs.readFile(path!);
          const img = decodeTga(bytes!);
          expect(img.width).toBeGreaterThan(0);
          expect(img.data.length).toBe(img.width * img.height * 4);
        }
      }
    }
  });

  it('has the tag chain a three-part player needs', async () => {
    const fs = await mount();
    const read = async (p: string) => {
      const b = (await fs.readFile(p))!;
      return parseMd3(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    };

    const lower = await read('models/players/sarge/lower.md3');
    const upper = await read('models/players/sarge/upper.md3');

    const lowerTags = new Set(lower.tags.slice(0, lower.numTags).map((t) => t.name));
    const upperTags = new Set(upper.tags.slice(0, upper.numTags).map((t) => t.name));

    // The legs carry tag_torso; the torso carries tag_head and tag_weapon.
    expect(lowerTags.has('tag_torso')).toBe(true);
    expect(upperTags.has('tag_head')).toBe(true);
    expect(upperTags.has('tag_weapon')).toBe(true);
  });
});
