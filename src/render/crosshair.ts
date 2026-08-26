/**
 * The ten Quake III Arena crosshair styles.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The SELECTION MECHANICS here are a direct port of `CG_DrawCrosshair` in
 * `cgame/cg_draw.c` (fetched into `refs/quake3/cgame/cg_draw.c`; see
 * `tools/assets.manifest.json`), verified against that source rather than
 * recalled:
 *
 * ```c
 * ca = cg_drawCrosshair.integer;
 * if (ca < 0) { ca = 0; }
 * hShader = cgs.media.crosshairShader[ ca % NUM_CROSSHAIRS ];
 * ```
 *
 * `NUM_CROSSHAIRS` is 10 (`cg_local.h`), the shaders are registered as
 * `gfx/2d/crosshair%c` for `'a' + i` (`cg_main.c`'s `CG_RegisterGraphics`),
 * and the stock default is `cg_drawCrosshair "4"` (`cg_main.c`'s cvar table)
 * -- which is style 4, letter **'e'**, not 'd'. `DEFAULT_CROSSHAIR` and
 * `crosshairIndex` below preserve that arithmetic exactly, wraparound
 * included: style 10 lands back on letter 'a', the same quirk a Q3 player
 * setting `cg_drawCrosshair 10` hits.
 *
 * **The ICON ART is not a port.** `crosshaira.tga` .. `crosshairj.tga` are
 * retail Quake III assets -- not in the GPL source tree, and (per NOTICE)
 * never committed to this repository. What follows are ORIGINAL SVG
 * recreations spanning the same visual vocabulary the real set is known for
 * (dot, cross, ring, corner brackets, X, square, chevron), not pixel decodes
 * of the originals. Two are anchored by an actual reference rather than
 * picked freely: letter 'e' (style 4) is corner brackets because that is
 * unmistakably Quake III's default crosshair from a decade of official
 * screenshots, and letter 'd' (style 3) is a gapped plus because a community
 * thread independently describes "q3 crosshair 3" as "the open cross". The
 * other eight fill out the same style family without a specific claim to
 * pixel accuracy -- same standing as this project's CPM physics and DeFRaG
 * entity flags: read the header before treating this as verified fidelity.
 */

/** `NUM_CROSSHAIRS` in `cg_local.h`. */
export const NUM_CROSSHAIRS = 10;

/** `cg_drawCrosshair`'s stock default cvar value, from `cg_main.c`. */
export const DEFAULT_CROSSHAIR = 4;

const LETTERS = 'abcdefghij';

/**
 * `ca % NUM_CROSSHAIRS` from `CG_DrawCrosshair`, with the same `ca < 0`
 * clamp -- ported arithmetic, not reinvented. `style` is expected to already
 * be a non-negative integer (0 means "off" and is handled by the caller
 * before this is reached); this still clamps defensively so a stray negative
 * value degrades to letter 'a' instead of a negative array index.
 */
export function crosshairIndex(style: number): number {
  const ca = Math.max(0, Math.trunc(style));
  return ca % NUM_CROSSHAIRS;
}

function crosshairLetter(style: number): string {
  return LETTERS[crosshairIndex(style)];
}

/**
 * Inner markup for each of the ten styles, in a 24x24 box centred on
 * (12, 12) -- `cg_crosshairSize`'s own stock default is 24 virtual units, so
 * this reuses that number rather than picking a new one. `currentColor`
 * throughout so `.ob-cross`'s `color` (which already carries the same
 * `--ob-text` token the old hardcoded bars used) keeps styling it centrally.
 */
const SHAPES: Readonly<Record<string, string>> = {
  // a: dot.
  a: '<circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  // b: solid plus, no gap -- distinct from d's gapped cross.
  b:
    '<rect x="11.1" y="2.5" width="1.8" height="19" fill="currentColor"/>' +
    '<rect x="2.5" y="11.1" width="19" height="1.8" fill="currentColor"/>',
  // c: plain ring.
  c: '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  // d: gapped plus -- the shape this project's crosshair already used before
  // it had styles at all, and (per the file header) the one community
  // reference this set has: "q3 crosshair 3 (open cross)".
  d:
    '<rect x="2" y="11" width="7" height="2" fill="currentColor"/>' +
    '<rect x="15" y="11" width="7" height="2" fill="currentColor"/>' +
    '<rect x="11" y="2" width="2" height="7" fill="currentColor"/>' +
    '<rect x="11" y="15" width="2" height="7" fill="currentColor"/>',
  // e: corner brackets -- Quake III's actual stock default (style 4).
  e:
    '<path d="M5,9 L5,5 L9,5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/>' +
    '<path d="M19,9 L19,5 L15,5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/>' +
    '<path d="M5,15 L5,19 L9,19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/>' +
    '<path d="M19,15 L19,19 L15,19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/>',
  // f: dot inside a ring.
  f:
    '<circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
  // g: gapped X -- d rotated 45 degrees.
  g:
    '<line x1="6" y1="6" x2="10" y2="10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<line x1="18" y1="6" x2="14" y2="10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<line x1="6" y1="18" x2="10" y2="14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<line x1="18" y1="18" x2="14" y2="14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  // h: a wider, thinner ring with tick marks at the cardinal points.
  h:
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1"/>' +
    '<line x1="12" y1="1" x2="12" y2="4" stroke="currentColor" stroke-width="1.4"/>' +
    '<line x1="12" y1="20" x2="12" y2="23" stroke="currentColor" stroke-width="1.4"/>' +
    '<line x1="1" y1="12" x2="4" y2="12" stroke="currentColor" stroke-width="1.4"/>' +
    '<line x1="20" y1="12" x2="23" y2="12" stroke="currentColor" stroke-width="1.4"/>',
  // i: hollow square.
  i: '<rect x="7" y="7" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  // j: a single upward chevron.
  j: '<path d="M8,15 L12,10 L16,15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
};

/**
 * SVG markup for `style` (any non-negative integer; wraps through
 * `crosshairIndex` the same way the real cvar does). Callers handle `0`
 * ("off") themselves -- see `Hud.setCrosshairStyle`.
 */
export function crosshairSvg(style: number): string {
  const shape = SHAPES[crosshairLetter(style)];
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${shape}</svg>`;
}
