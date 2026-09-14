/**
 * Merged lightmaps (Quake3e's `r_mergeLightmaps`), the pure half.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * What a wrong atlas looks like is a lightmap seam: a wall lit by the page
 * next to it along one edge, or a whole surface lit from the wrong cell. Both
 * read as "odd lighting", never as an error, so the arithmetic is pinned here.
 */

import { describe, expect, it } from 'vitest';
import {
  LIGHTMAP_BORDER,
  LIGHTMAP_LEN,
  blitPage,
  fillBorders,
  lightmapCoords,
  lightmapLayout,
  log2pad,
  remapLightmapSt,
} from '../../src/render/lightmap-atlas.js';

describe('log2pad', () => {
  it('rounds to a power of two in the asked direction', () => {
    expect(log2pad(132, true)).toBe(256);
    expect(log2pad(256, true)).toBe(256);
    expect(log2pad(132, false)).toBe(128);
    expect(log2pad(128, false)).toBe(128);
    expect(log2pad(1, true)).toBe(1);
  });
});

describe('SetLightmapParams', () => {
  it('does not merge a single page, or on a device too small for two', () => {
    expect(lightmapLayout(1, 4096)).toBeNull();
    expect(lightmapLayout(0, 4096)).toBeNull();
    expect(lightmapLayout(8, LIGHTMAP_LEN * 2 - 1)).toBeNull();
  });

  it('grows width then height until every page fits', () => {
    // acc_fuzzle's 34 pages. 256x256 (1x1) -> 512 wide (3x1, short) -> 512
    // high (3x3) -> 1024 wide (7x3 = 21, short) -> 1024 high (7x7 = 49). The
    // mid-loop break only looks after the WIDTH grows; the 49 is caught by the
    // while condition, so both axes grew in that pass.
    const l = lightmapLayout(34, 4096)!;
    expect([l.width, l.height, l.countX, l.countY]).toEqual([1024, 1024, 7, 7]);
    expect(l.perAtlas).toBe(49);
    expect(l.atlases).toBe(1);
  });

  it('fits two pages side by side before growing the height', () => {
    const l = lightmapLayout(2, 4096)!;
    expect([l.width, l.height, l.countX, l.countY]).toEqual([512, 256, 3, 1]);
  });

  it('spills into several atlases when the limit stops the growth', () => {
    const l = lightmapLayout(1000, 1024)!;
    expect([l.width, l.height, l.perAtlas]).toEqual([1024, 1024, 49]);
    expect(l.atlases).toBe(Math.ceil(1000 / 49));
  });

  it('scales a page span to 128 texels of the atlas', () => {
    const l = lightmapLayout(2, 4096)!;
    expect(l.scaleS).toBe(128 / 512);
    expect(l.scaleT).toBe(128 / 256);
  });
});

describe('R_GetLightmapCoords', () => {
  const l = lightmapLayout(34, 4096)!;

  it('offsets page 0 past the border', () => {
    const c = lightmapCoords(l, 0);
    expect(c.atlas).toBe(0);
    expect(c.offsetS).toBe(LIGHTMAP_BORDER / l.width);
    expect(c.offsetT).toBe(LIGHTMAP_BORDER / l.height);
  });

  it('fills a row before starting the next', () => {
    expect([lightmapCoords(l, 6).cellX, lightmapCoords(l, 6).cellY]).toEqual([6, 0]);
    const c = lightmapCoords(l, 7);
    expect([c.cellX, c.cellY]).toEqual([0, 1]);
    expect(c.offsetT).toBe((LIGHTMAP_BORDER + LIGHTMAP_LEN) / l.height);
  });

  it('moves to the next atlas after perAtlas pages', () => {
    const small = lightmapLayout(1000, 1024)!;
    expect(lightmapCoords(small, 48).atlas).toBe(0);
    expect(lightmapCoords(small, 49).atlas).toBe(1);
    expect(lightmapCoords(small, 49).cellX).toBe(0);
  });
});

describe('remapping coordinates', () => {
  it('lands a page’s 0..1 on its interior, and nothing else', () => {
    const l = lightmapLayout(34, 4096)!;
    // Two vertices before, two to move, one after.
    const st = [0.5, 0.5, 0.5, 0.5, 0, 0, 1, 1, 0.25, 0.75];
    expect(remapLightmapSt(st, 2, 4, l, 16)).toBe(0);

    const c = lightmapCoords(l, 16);
    expect(st.slice(0, 4)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(st[4]).toBeCloseTo(c.offsetS, 12);
    expect(st[5]).toBeCloseTo(c.offsetT, 12);
    // The far corner is exactly 128 texels on -- the border stays outside it.
    expect(st[6] * l.width).toBeCloseTo(c.offsetS * l.width + 128, 9);
    expect(st[7] * l.height).toBeCloseTo(c.offsetT * l.height + 128, 9);
    expect(st.slice(8)).toEqual([0.25, 0.75]);
  });
});

describe('FillBorders', () => {
  /** A page whose interior texel (x, y) is (x, y, x+y, 255). */
  function page(): Uint8Array {
    const img = new Uint8Array(LIGHTMAP_LEN * LIGHTMAP_LEN * 4);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const i = ((y + LIGHTMAP_BORDER) * LIGHTMAP_LEN + x + LIGHTMAP_BORDER) * 4;
        img.set([x, y, (x + y) & 255, 255], i);
      }
    }
    return img;
  }
  const px = (img: Uint8Array, x: number, y: number): number[] =>
    Array.from(img.subarray((y * LIGHTMAP_LEN + x) * 4, (y * LIGHTMAP_LEN + x) * 4 + 4));

  it('extends every edge texel outward across the whole border', () => {
    const img = page();
    fillBorders(img);
    const lo = LIGHTMAP_BORDER;
    const hi = LIGHTMAP_BORDER + 127;
    for (let i = lo; i <= hi; i++) {
      for (let b = 0; b < LIGHTMAP_BORDER; b++) {
        expect(px(img, i, b), `top ${i},${b}`).toEqual(px(img, i, lo));
        expect(px(img, i, LIGHTMAP_LEN - 1 - b), `bottom ${i},${b}`).toEqual(px(img, i, hi));
        expect(px(img, b, i), `left ${b},${i}`).toEqual(px(img, lo, i));
        expect(px(img, LIGHTMAP_LEN - 1 - b, i), `right ${b},${i}`).toEqual(px(img, hi, i));
      }
    }
  });

  it('lands every corner of the border on the interior’s corner texel', () => {
    const img = page();
    fillBorders(img);
    const lo = LIGHTMAP_BORDER;
    const hi = LIGHTMAP_BORDER + 127;
    for (let a = 0; a < LIGHTMAP_BORDER; a++) {
      for (let b = 0; b < LIGHTMAP_BORDER; b++) {
        expect(px(img, a, b)).toEqual(px(img, lo, lo));
        expect(px(img, LIGHTMAP_LEN - 1 - a, b)).toEqual(px(img, hi, lo));
        expect(px(img, a, LIGHTMAP_LEN - 1 - b)).toEqual(px(img, lo, hi));
        expect(px(img, LIGHTMAP_LEN - 1 - a, LIGHTMAP_LEN - 1 - b)).toEqual(px(img, hi, hi));
      }
    }
  });

  it('leaves the interior untouched', () => {
    const before = page();
    const after = page();
    fillBorders(after);
    for (let y = LIGHTMAP_BORDER; y < LIGHTMAP_BORDER + 128; y++) {
      for (let x = LIGHTMAP_BORDER; x < LIGHTMAP_BORDER + 128; x++) {
        expect(px(after, x, y)).toEqual(px(before, x, y));
      }
    }
  });
});

describe('blitPage', () => {
  it('writes a page into its own cell and no other', () => {
    const width = 512;
    const atlas = new Uint8Array(width * 256 * 4);
    const img = new Uint8Array(LIGHTMAP_LEN * LIGHTMAP_LEN * 4).fill(7);
    blitPage(atlas, width, img, 1, 0);
    const at = (x: number, y: number): number => atlas[(y * width + x) * 4];
    expect(at(LIGHTMAP_LEN, 0)).toBe(7);
    expect(at(LIGHTMAP_LEN * 2 - 1, LIGHTMAP_LEN - 1)).toBe(7);
    expect(at(LIGHTMAP_LEN - 1, 0)).toBe(0);
    expect(at(LIGHTMAP_LEN * 2, 0)).toBe(0);
    expect(at(LIGHTMAP_LEN, LIGHTMAP_LEN)).toBe(0);
  });
});
