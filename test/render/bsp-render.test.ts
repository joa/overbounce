/**
 * The render half of the BSP: lightmaps, UVs and indexed surfaces.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `buildWorldSurfaces` itself needs a GPU device to build materials, so what is
 * testable in Node is everything up to that: the overbright shift, and whether
 * the data coming out of a real map is self-consistent enough to draw. Both are
 * where the bugs actually live — a wrong index or an unshifted lightmap is a
 * silently wrong picture, not a crash.
 */

import { existsSync, openAsBlob, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseBsp, SurfaceType, LIGHTMAP_BYTES } from '../../src/collision/bsp.js';
import type { BspFile } from '../../src/collision/bsp.js';
import { colorShiftLightingBytes, OVERBRIGHT_SHIFT } from '../../src/render/bsp-mesh.js';
import { Pk3FileSystem } from '../../src/assets/pk3.js';

describe('R_ColorShiftLightingBytes', () => {
  it('shifts by r_mapOverBrightBits', () => {
    // The whole point: lightmaps are stored dark and scaled up at load. Skip
    // this and every Quake map renders as a murky brown cave.
    expect(OVERBRIGHT_SHIFT).toBe(2);
    expect(colorShiftLightingBytes(10, 20, 30)).toEqual([40, 80, 120]);
  });

  it('leaves black black', () => {
    expect(colorShiftLightingBytes(0, 0, 0)).toEqual([0, 0, 0]);
  });

  it('normalises by the brightest channel instead of clamping', () => {
    // 100 << 2 = 400, over range. Clamping each channel would give
    // [255, 200, 100] and shift the hue toward white; Quake scales the whole
    // colour by 255/400 and keeps the ratios.
    const [r, g, b] = colorShiftLightingBytes(100, 50, 25);
    expect(r).toBe(255);
    // 200 * 255 / 400 = 127.5, truncated.
    expect(g).toBe(127);
    expect(b).toBe(63);

    // The ratios survive, which is what "normalize by color" means.
    expect(g / r).toBeCloseTo(0.5, 1);
    expect(b / r).toBeCloseTo(0.25, 1);
  });

  it('never exceeds a byte', () => {
    for (const v of [64, 100, 200, 255]) {
      const out = colorShiftLightingBytes(v, v, v);
      for (const c of out) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
    }
  });

  it('keeps a pure hue pure', () => {
    // A saturated red light must not pick up green or blue on the way through.
    expect(colorShiftLightingBytes(200, 0, 0)).toEqual([255, 0, 0]);
  });
});

const MAPS = ['public/maps/hntourney1.bsp', 'public/maps/feliz-a1.bsp', 'public/maps/mega_rl.bsp']
  .filter((p) => existsSync(p));

describe.skipIf(!MAPS.length)('render lumps from real maps', () => {
  const load = (p: string): BspFile =>
    parseBsp(readFileSync(p).buffer as ArrayBuffer);

  it('parses a lightmap lump that is a whole number of pages', () => {
    for (const path of MAPS) {
      const bsp = load(path);
      expect(bsp.lightmaps.length, path).toBe(bsp.numLightmaps * LIGHTMAP_BYTES);
    }
  });

  it('gives every vertex finite texture coordinates', () => {
    for (const path of MAPS) {
      const bsp = load(path);
      const n = bsp.drawVerts.length / 3;
      expect(bsp.drawSt.length, path).toBe(n * 2);
      expect(bsp.drawLightmapSt.length, path).toBe(n * 2);
      expect(bsp.drawNormals.length, path).toBe(n * 3);
      expect(bsp.drawColors.length, path).toBe(n * 4);

      for (let i = 0; i < bsp.drawSt.length; i++) {
        expect(Number.isFinite(bsp.drawSt[i]), `${path} st[${i}]`).toBe(true);
      }
    }
  });

  it('keeps lightmap coordinates inside the page', () => {
    // A lightmap UV outside 0..1 would sample a neighbouring surface's light.
    // A small epsilon: the compiler's own rounding can land a hair outside.
    for (const path of MAPS) {
      const bsp = load(path);
      for (const surface of bsp.surfaces) {
        if (surface.lightmapNum < 0 || surface.surfaceType === SurfaceType.PATCH) {
          continue;
        }
        for (let i = 0; i < surface.numVerts; i++) {
          const v = surface.firstVert + i;
          for (let c = 0; c < 2; c++) {
            const uv = bsp.drawLightmapSt[v * 2 + c];
            expect(uv, `${path} lm uv`).toBeGreaterThan(-0.01);
            expect(uv, `${path} lm uv`).toBeLessThan(1.01);
          }
        }
      }
    }
  });

  it('has in-range indices for every indexed surface', () => {
    // Indices are relative to the surface's own firstVert. An out-of-range one
    // draws garbage triangles across the level rather than failing loudly.
    for (const path of MAPS) {
      const bsp = load(path);
      for (const surface of bsp.surfaces) {
        if (surface.surfaceType === SurfaceType.PATCH || surface.numIndexes === 0) {
          continue;
        }
        expect(surface.numIndexes % 3, path).toBe(0);
        for (let i = 0; i < surface.numIndexes; i++) {
          const idx = bsp.drawIndexes[surface.firstIndex + i];
          expect(idx, `${path} index`).toBeGreaterThanOrEqual(0);
          expect(idx, `${path} index`).toBeLessThan(surface.numVerts);
        }
      }
    }
  });

  it('references a lightmap page that exists, or none at all', () => {
    for (const path of MAPS) {
      const bsp = load(path);
      for (const surface of bsp.surfaces) {
        expect(surface.lightmapNum, path).toBeLessThan(bsp.numLightmaps);
      }
    }
  });

  it('names a real shader for every surface', () => {
    for (const path of MAPS) {
      const bsp = load(path);
      for (const surface of bsp.surfaces) {
        expect(bsp.shaders[surface.shaderNum], path).toBeDefined();
      }
    }
  });

  it('has patch dimensions that are odd and at least 3', () => {
    // A Bezier control mesh is 3x3 sub-patches; even dimensions cannot tile.
    for (const path of MAPS) {
      const bsp = load(path);
      for (const surface of bsp.surfaces) {
        if (surface.surfaceType !== SurfaceType.PATCH) {
          continue;
        }
        expect(surface.patchWidth % 2, path).toBe(1);
        expect(surface.patchHeight % 2, path).toBe(1);
        expect(surface.patchWidth, path).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

const baseq3 = process.env.Q3_BASEQ3;

describe.skipIf(!baseq3 || !existsSync(baseq3))('shader names resolve to images', () => {
  it('finds an image for most of a real map\'s shaders', async () => {
    const fs = new Pk3FileSystem();
    for (const n of readdirSync(baseq3!).filter((f) => f.toLowerCase().endsWith('.pk3')).sort()) {
      await fs.mount(n, await openAsBlob(join(baseq3!, n)));
    }

    const data = await fs.readFile('maps/q3dm6.bsp');
    if (!data) {
      return; // not a retail baseq3
    }
    const bsp = parseBsp(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    );

    let found = 0;
    const missing: string[] = [];
    for (const shader of bsp.shaders) {
      if (fs.findImage(shader.shader)) {
        found++;
      } else {
        missing.push(shader.shader);
      }
    }

    // Not 100%, and it should not be: names like textures/sfx/zap_scroll1000
    // exist only inside .shader scripts, which are deliberately not parsed.
    // The bar is that direct lookup covers the great majority of a map.
    const ratio = found / bsp.shaders.length;
    expect(ratio, `only ${found}/${bsp.shaders.length}; missing ${missing.slice(0, 5)}`)
      .toBeGreaterThan(0.75);
  });
});
