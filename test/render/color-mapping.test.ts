/**
 * `R_SetColorMappings` and `R_ColorShiftLightingBytes`, against the C.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is the half of VISUALS.md's B3 that is a PORT, so it gets the treatment
 * a port gets here: expectations derived from id's source, not from what the
 * code happens to produce. The filmic curve next door in `post.ts` is an
 * aesthetic addition and cannot be tested this way, which is exactly why the
 * two are separate files.
 *
 * The values below come from `tr_image.c:2125` (`R_SetColorMappings`),
 * `tr_bsp.c:100` (`R_ColorShiftLightingBytes`) and the cvar defaults in
 * `tr_init.c:886` / `:911` / `:935`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  GAMMA_MAX,
  GAMMA_MIN,
  OVERBRIGHT_BITS_MAX,
  R_GAMMA_DEFAULT,
  R_MAP_OVERBRIGHT_BITS_DEFAULT,
  clampColorMapping,
  gammaRamp,
  gammaRampIsIdentity,
  gammaTable,
  getColorMapping,
  identityLight,
  lightingShift,
  resetColorMapping,
  setColorMapping,
} from '../../src/render/color-mapping.js';
import { OVERBRIGHT_SHIFT, colorShiftLightingBytes } from '../../src/render/bsp-mesh.js';

afterEach(() => {
  resetColorMapping();
});

describe('defaults', () => {
  it('is Quake in a window: overbright 0, map overbright 2, gamma 1', () => {
    const m = getColorMapping();
    // R_SetColorMappings forces tr.overbrightBits to 0 when there is no
    // hardware gamma ramp AND when the app is not fullscreen. A canvas is both.
    expect(m.overbrightBits).toBe(0);
    expect(m.mapOverBrightBits).toBe(R_MAP_OVERBRIGHT_BITS_DEFAULT);
    expect(m.gamma).toBe(R_GAMMA_DEFAULT);
  });

  it('leaves the lightmap shift at the value the renderer hardcoded before', () => {
    expect(lightingShift()).toBe(OVERBRIGHT_SHIFT);
    expect(lightingShift()).toBe(2);
  });

  it('has identityLight 1, which fog.ts and md3-mesh.ts assume', () => {
    expect(identityLight()).toBe(1);
  });

  it('has an identity gamma ramp, so the post chain cannot change colour', () => {
    expect(gammaRampIsIdentity()).toBe(true);
    const table = gammaTable();
    for (let i = 0; i < 256; i++) {
      expect(table[i]).toBe(i);
    }
  });
});

describe('R_SetColorMappings clamping', () => {
  it('clamps r_gamma below 0.5 and above 3.0, as Cvar_Set does', () => {
    expect(clampColorMapping({ gamma: 0.1, overbrightBits: 0, mapOverBrightBits: 2 }).gamma).toBe(
      GAMMA_MIN,
    );
    expect(clampColorMapping({ gamma: 9, overbrightBits: 0, mapOverBrightBits: 2 }).gamma).toBe(
      GAMMA_MAX,
    );
  });

  it('clamps tr.overbrightBits into 0..2 (24-bit colour)', () => {
    expect(
      clampColorMapping({ gamma: 1, overbrightBits: -3, mapOverBrightBits: 2 }).overbrightBits,
    ).toBe(0);
    expect(
      clampColorMapping({ gamma: 1, overbrightBits: 7, mapOverBrightBits: 2 }).overbrightBits,
    ).toBe(OVERBRIGHT_BITS_MAX);
  });
});

describe('s_gammatable', () => {
  it('is the identity when g == 1, via the branch and not via pow', () => {
    const table = gammaTable({ gamma: 1, overbrightBits: 0, mapOverBrightBits: 2 });
    for (let i = 0; i < 256; i++) {
      expect(table[i]).toBe(i);
    }
  });

  it('doubles through the shift, and saturates rather than wrapping', () => {
    // inf <<= shift; if (inf > 255) inf = 255;
    const table = gammaTable({ gamma: 1, overbrightBits: 1, mapOverBrightBits: 2 });
    expect(table[0]).toBe(0);
    expect(table[10]).toBe(20);
    expect(table[127]).toBe(254);
    expect(table[128]).toBe(255);
    expect(table[255]).toBe(255);
  });

  it('matches 255 * pow(i/255, 1/g) + 0.5 truncated, for g != 1', () => {
    const g = 2;
    const table = gammaTable({ gamma: g, overbrightBits: 0, mapOverBrightBits: 2 });
    for (let i = 0; i < 256; i++) {
      // The +0.5f then assignment to int is round-half-UP, not to-nearest-even.
      const expected = Math.trunc(255 * Math.pow(i / 255, 1 / g) + 0.5);
      expect(table[i]).toBe(Math.min(255, expected));
    }
  });

  it('keeps the endpoints pinned for every gamma in range', () => {
    for (const gamma of [0.5, 0.8, 1, 1.2, 2, 3]) {
      const table = gammaTable({ gamma, overbrightBits: 0, mapOverBrightBits: 2 });
      expect(table[0]).toBe(0);
      expect(table[255]).toBe(255);
    }
  });
});

describe('the continuous ramp the shader evaluates', () => {
  it('agrees with the byte table to within the table’s own step size', () => {
    // The shader cannot afford a 256-entry lookup texture for a curve this
    // simple, so it evaluates the closed form. This is the assertion that
    // makes that substitution a measured decision rather than an assumption.
    //
    // The tolerance is not slack. `s_gammatable` rounds the gamma curve to a
    // BYTE and only then applies `inf <<= shift`, so its output steps in
    // multiples of `1 << overbrightBits` — at `r_overBrightBits 2` the table
    // can only ever produce values divisible by 4. The continuous form
    // quantizes once, at the end. The two therefore cannot agree more closely
    // than the table's own step, and the closed form is the SMOOTHER of the
    // two, not the less accurate one.
    for (const gamma of [0.5, 0.8, 1, 1.2, 2, 3]) {
      for (const overbrightBits of [0, 1, 2]) {
        const m = { gamma, overbrightBits, mapOverBrightBits: 2 };
        const table = gammaTable(m);
        const step = 1 << overbrightBits;
        for (let i = 0; i < 256; i++) {
          const shader = Math.round(gammaRamp(i / 255, m) * 255);
          expect(Math.abs(shader - table[i])).toBeLessThanOrEqual(step);
        }
      }
    }
  });

  it('is exact to a byte when there is no overbright shift to magnify it', () => {
    for (const gamma of [0.5, 0.8, 1, 1.2, 2, 3]) {
      const m = { gamma, overbrightBits: 0, mapOverBrightBits: 2 };
      const table = gammaTable(m);
      for (let i = 0; i < 256; i++) {
        expect(Math.abs(Math.round(gammaRamp(i / 255, m) * 255) - table[i])).toBeLessThanOrEqual(1);
      }
    }
  });

  it('stays inside 0..1', () => {
    const m = { gamma: 3, overbrightBits: 2, mapOverBrightBits: 2 };
    expect(gammaRamp(0, m)).toBe(0);
    expect(gammaRamp(1, m)).toBe(1);
    expect(gammaRamp(0.9, m)).toBeLessThanOrEqual(1);
  });
});

describe('the overbright interlock', () => {
  it('moves brightness out of the lightmap as it moves into the ramp', () => {
    // shift = r_mapOverBrightBits - tr.overbrightBits, and the ramp then
    // shifts back up by tr.overbrightBits. The two halves are one mechanism.
    setColorMapping({ overbrightBits: 1 });
    expect(lightingShift()).toBe(1);
    expect(gammaTable()[10]).toBe(20);
    expect(identityLight()).toBe(0.5);

    setColorMapping({ overbrightBits: 2 });
    expect(lightingShift()).toBe(0);
    expect(gammaTable()[10]).toBe(40);
    expect(identityLight()).toBe(0.25);
  });

  it('never produces a negative shift, which C leaves undefined', () => {
    setColorMapping({ overbrightBits: 2, mapOverBrightBits: 0 });
    expect(lightingShift()).toBe(0);
  });
});

describe('R_ColorShiftLightingBytes', () => {
  it('normalises by the brightest channel instead of saturating to white', () => {
    // 100 << 2 = 400, over 255, so all three scale by 255/400 rather than the
    // red clamping to 255 and the hue sliding toward white.
    expect(colorShiftLightingBytes(100, 50, 25)).toEqual([255, 127, 63]);
  });

  it('leaves values that fit alone', () => {
    expect(colorShiftLightingBytes(10, 20, 30)).toEqual([40, 80, 120]);
  });

  it('follows the installed mapping rather than a constant', () => {
    setColorMapping({ overbrightBits: 2 });
    // shift 0 now: the brightness has moved into the framebuffer ramp.
    expect(colorShiftLightingBytes(10, 20, 30)).toEqual([10, 20, 30]);

    setColorMapping({ overbrightBits: 0, mapOverBrightBits: 3 });
    expect(colorShiftLightingBytes(10, 20, 30)).toEqual([80, 160, 240]);
  });

  it('is unchanged from the hardcoded behaviour with no configuration', () => {
    // The whole point: adding the knob must not move the default picture.
    resetColorMapping();
    for (const [r, g, b] of [
      [0, 0, 0],
      [1, 2, 3],
      [64, 64, 64],
      [100, 50, 25],
      [255, 255, 255],
    ]) {
      let rr = r << OVERBRIGHT_SHIFT;
      let gg = g << OVERBRIGHT_SHIFT;
      let bb = b << OVERBRIGHT_SHIFT;
      if ((rr | gg | bb) > 255) {
        const max = Math.max(rr, gg, bb);
        rr = Math.trunc((rr * 255) / max);
        gg = Math.trunc((gg * 255) / max);
        bb = Math.trunc((bb * 255) / max);
      }
      expect(colorShiftLightingBytes(r, g, b)).toEqual([rr, gg, bb]);
    }
  });
});
