/**
 * Merged lightmaps: the BSP's 128x128 pages packed into atlas textures.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) Quake3e contributors
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from Quake3e (https://github.com/ec-/Quake3e), `renderervk/tr_bsp.c`:
 * `FillBorders`, `SetLightmapParams` and `R_GetLightmapCoords`, plus
 * `log2pad` from `qcommon/qcommon.h`. This is NOT in id's source --
 * `r_mergeLightmaps` is Quake3e's, on by default there.
 *
 * ## Why
 *
 * `bsp-mesh.ts` batches surfaces by (shader, lightmap page, fog volume). The
 * page is in that key only because every page is its own texture and so its
 * own material. Pack the pages into one texture and the page drops out of the
 * key: measured on world model 0, acc_fuzzle goes from 360 batches to 59,
 * mega_rl from 66 to 15, q3dm6 from 87 to 72 (`tools/diag/quake3e-scan.ts`,
 * `.agent/plans/QUAKE3E.md` section 1). A q3map2 map that spreads one shader
 * across many small pages gains the most.
 *
 * ## The border is the whole trick
 *
 * Each page goes into the atlas as `LIGHTMAP_LEN` = 128 + 2*2 texels, and
 * `fillBorders` copies the outermost row and column outward twice. Without it
 * bilinear filtering at a page's edge blends in the NEIGHBOURING page, which
 * is Quake3e's "Fixed adjacent texels leaking in merged lightmaps". Two texels
 * is also enough for the coordinates real maps actually carry: the worst
 * lightmap UV overshoot on any bundled map is 0.27 of a texel past its page
 * (ob_crypt; de4th_run2, 0.12).
 *
 * Everything here is pure data so it tests in Node; the texture itself is made
 * in `bsp-mesh.ts`, next to the colour shift that fills it.
 */

import { LIGHTMAP_SIZE } from '../collision/bsp.js';

/** Texels of copied edge around every page. */
export const LIGHTMAP_BORDER = 2;

/** A page as it sits in the atlas, border included. */
export const LIGHTMAP_LEN = LIGHTMAP_SIZE + LIGHTMAP_BORDER * 2;

/** `log2pad`: the power of two at or above `v` (`roundup`), or at or below it. */
export function log2pad(v: number, roundup: boolean): number {
  let x = 1;

  while (x < v) {
    x <<= 1;
  }

  if (!roundup) {
    if (x > v) {
      x >>= 1;
    }
  }

  return x;
}

export interface LightmapLayout {
  /** Atlas texture size, in texels. Every atlas of a map shares it. */
  width: number;
  height: number;
  /** Pages per row and per column. */
  countX: number;
  countY: number;
  /** `tr.lightmapMod`: pages per atlas. */
  perAtlas: number;
  /** How many atlases the map needs -- `SetLightmapParams`' return value. */
  atlases: number;
  /** `tr.lightmapScale`: one page's 0..1 span, as a fraction of the atlas. */
  scaleS: number;
  scaleT: number;
}

/**
 * `SetLightmapParams`, behind `R_LoadLightmaps`' own gate.
 *
 * Null when the map should keep one texture per page: a single page ("do not
 * merge single lightmap" -- a border for nothing), or a device whose texture
 * limit cannot hold two pages side by side.
 *
 * Grows width then height alternately, each to the next power of two that
 * fits one more page, until every page fits or the width reaches the limit.
 * A map with more pages than one atlas holds gets several, `perAtlas` each.
 */
export function lightmapLayout(numLightmaps: number, maxTextureSize: number): LightmapLayout | null {
  if (numLightmaps <= 1 || maxTextureSize < LIGHTMAP_LEN * 2) {
    return null;
  }

  let width = log2pad(LIGHTMAP_LEN, true);
  let height = log2pad(LIGHTMAP_LEN, true);

  let countX = 1;
  let countY = 1;

  while (width < maxTextureSize && countX * countY < numLightmaps) {
    width = log2pad(width + LIGHTMAP_LEN, true);
    countX = Math.floor(width / LIGHTMAP_LEN);
    if (countX * countY >= numLightmaps) {
      break;
    }
    height = log2pad(height + LIGHTMAP_LEN, true);
    countY = Math.floor(height / LIGHTMAP_LEN);
  }

  const perAtlas = countX * countY;

  return {
    width,
    height,
    countX,
    countY,
    perAtlas,
    atlases: Math.floor((numLightmaps + perAtlas - 1) / perAtlas),
    scaleS: LIGHTMAP_SIZE / width,
    scaleT: LIGHTMAP_SIZE / height,
  };
}

/** Where one page lives: which atlas, and its interior's corner in 0..1. */
export interface LightmapCoords {
  atlas: number;
  offsetS: number;
  offsetT: number;
  /** Page cell, for copying the pixels in. */
  cellX: number;
  cellY: number;
}

/** `R_GetLightmapCoords`. The offset is to the INTERIOR, past the border. */
export function lightmapCoords(layout: LightmapLayout, lightmapIndex: number): LightmapCoords {
  const atlas = Math.floor(lightmapIndex / layout.perAtlas);
  const cN = lightmapIndex % layout.perAtlas;
  const cX = cN % layout.countX;
  const cY = Math.floor(cN / layout.countX);

  return {
    atlas,
    offsetS: (LIGHTMAP_BORDER + cX * LIGHTMAP_LEN) / layout.width,
    offsetT: (LIGHTMAP_BORDER + cY * LIGHTMAP_LEN) / layout.height,
    cellX: cX,
    cellY: cY,
  };
}

/**
 * Move lightmap coordinates `[from, to)` of a flat `[s, t, s, t, ...]` list
 * from page space into atlas space -- `R_LoadFaces`' and `ParseMesh`'s
 * `lightmap * tr.lightmapScale + lightmapX`. Returns the atlas the page is in.
 *
 * Indices are VERTICES, not array slots.
 */
export function remapLightmapSt(
  st: number[],
  from: number,
  to: number,
  layout: LightmapLayout,
  lightmapIndex: number,
): number {
  const c = lightmapCoords(layout, lightmapIndex);
  for (let v = from; v < to; v++) {
    st[v * 2] = st[v * 2] * layout.scaleS + c.offsetS;
    st[v * 2 + 1] = st[v * 2 + 1] * layout.scaleT + c.offsetT;
  }
  return c.atlas;
}

/**
 * `FillBorders`, on one `LIGHTMAP_LEN` square RGBA page whose interior is
 * already written. Extends the edge rows and columns outward one ring at a
 * time, inner ring first, and averages each ring's corners from their two
 * neighbours -- which, working through the copies, lands every corner texel on
 * the interior's own corner.
 */
export function fillBorders(img: Uint8Array): void {
  const at = (x: number, y: number, o: number): number => (y * LIGHTMAP_LEN + x) * 4 + o;
  const copy = (dx: number, dy: number, sx: number, sy: number): void => {
    for (let o = 0; o < 4; o++) {
      img[at(dx, dy, o)] = img[at(sx, sy, o)];
    }
  };
  const average = (dx: number, dy: number, ax: number, ay: number, bx: number, by: number): void => {
    for (let o = 0; o < 4; o++) {
      img[at(dx, dy, o)] = (img[at(ax, ay, o)] + img[at(bx, by, o)]) >> 1;
    }
  };

  for (let n = LIGHTMAP_BORDER; n > 0; n--) {
    const x0 = n - 1;
    const x1 = LIGHTMAP_LEN - n;
    const y0 = n - 1;
    const y1 = LIGHTMAP_LEN - n;
    const len = LIGHTMAP_SIZE + (LIGHTMAP_BORDER * 2 - n);
    for (let i = n; i < len; i++) {
      copy(i, y0, i, y0 + 1);
      copy(x0, i, x0 + 1, i);
      copy(i, y1, i, y1 - 1);
      copy(x1, i, x1 - 1, i);
    }

    // interpolate corners
    average(x0, y0, x0, y0 + 1, x0 + 1, y0);
    average(x1, y0, x1 - 1, y0, x1, y0 + 1);
    average(x0, y1, x0, y1 - 1, x0 + 1, y1);
    average(x1, y1, x1, y1 - 1, x1 - 1, y1);
  }
}

/**
 * Copy a finished `LIGHTMAP_LEN` page into its cell of an atlas -- what
 * `R_LoadMergedLightmaps` uploads at `(x * LIGHTMAP_LEN, y * LIGHTMAP_LEN)`.
 */
export function blitPage(atlas: Uint8Array, atlasWidth: number, page: Uint8Array, cellX: number, cellY: number): void {
  for (let y = 0; y < LIGHTMAP_LEN; y++) {
    const src = y * LIGHTMAP_LEN * 4;
    const dst = ((cellY * LIGHTMAP_LEN + y) * atlasWidth + cellX * LIGHTMAP_LEN) * 4;
    atlas.set(page.subarray(src, src + LIGHTMAP_LEN * 4), dst);
  }
}
