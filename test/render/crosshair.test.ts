/**
 * The crosshair style index/wraparound math -- the one part of crosshair.ts
 * that IS a verified port of `CG_DrawCrosshair`'s `ca % NUM_CROSSHAIRS`
 * (see that file's own header). The icon art is original and untested here
 * for the same reason it carries no fidelity claim.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CROSSHAIR,
  NUM_CROSSHAIRS,
  crosshairIndex,
  crosshairSvg,
} from '../../src/render/crosshair.js';

describe('crosshairIndex', () => {
  it('is 10 styles, cvar-default 4', () => {
    expect(NUM_CROSSHAIRS).toBe(10);
    expect(DEFAULT_CROSSHAIR).toBe(4);
  });

  it('maps the default style to letter e (index 4)', () => {
    expect(crosshairIndex(DEFAULT_CROSSHAIR)).toBe(4);
  });

  it('wraps style 10 back to letter a (index 0) -- the same quirk cg_drawCrosshair 10 has', () => {
    expect(crosshairIndex(10)).toBe(0);
  });

  it('wraps past 10 the same way the cvar wraps', () => {
    expect(crosshairIndex(11)).toBe(1);
    expect(crosshairIndex(13)).toBe(3);
    expect(crosshairIndex(20)).toBe(0);
  });

  it('clamps a negative value to 0, matching the source\'s `if (ca < 0) ca = 0`', () => {
    expect(crosshairIndex(-5)).toBe(0);
  });

  it('truncates a non-integer rather than throwing', () => {
    expect(crosshairIndex(4.9)).toBe(4);
  });
});

describe('crosshairSvg', () => {
  it('returns distinct markup for all ten styles', () => {
    const svgs = new Set<string>();
    for (let style = 1; style <= NUM_CROSSHAIRS; style++) {
      const svg = crosshairSvg(style);
      expect(svg).toContain('<svg');
      svgs.add(svg);
    }
    expect(svgs.size).toBe(NUM_CROSSHAIRS);
  });

  it('style 10 renders identically to style 0-wrapped letter a, i.e. itself', () => {
    // Not a meaningful assertion about style 0 (the caller treats 0 as "off"
    // and never calls this) -- just pins that 10 and 20 (both -> letter a)
    // render the same icon.
    expect(crosshairSvg(10)).toBe(crosshairSvg(20));
  });
});
