/**
 * The raymarched fog path: extinction, the box, and the slab test.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The march itself cannot be tested here -- it is a shader, and it prints
 * nothing. What CAN be tested is everything it is built on, and that is where
 * both of its real bugs lived: a box in the wrong space, and a ray that never
 * meets it. `?fogdebug` covers the rest.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VOLUMETRIC_OPTIONS,
  OPAQUE_TRANSMITTANCE,
  fogBox,
  fogExtinction,
  parseVolumetricOptions,
  slab,
} from '../../src/render/volumetric-fog.js';
import { DEFAULT_FOG_OPTIONS, FOG_FEATHER, parseFogOptions } from '../../src/render/fog.js';
import type { Fog } from '../../src/render/fog.js';

/**
 * de4th_run1's ground fog, as `R_LoadFogs` builds it: the whole map floor,
 * `[-1592,-760,8] .. [1592,760,208]`, red, opaque at 300 units.
 */
const GROUND_FOG: Fog = {
  originalBrushNumber: 1230,
  bounds: [
    [-1592, -760, 8],
    [1592, 760, 208],
  ],
  color: [0.65098, 0.07451, 0.11372],
  depthForOpaque: 300,
  tcScale: 1 / 2400,
  hasSurface: true,
  surface: [0, 0, -1, -208],
};

describe('depthForOpaque as an extinction coefficient', () => {
  it('transmits exactly the opaque fraction at depthForOpaque', () => {
    const sigma = fogExtinction(300);
    expect(Math.exp(-sigma * 300)).toBeCloseTo(OPAQUE_TRANSMITTANCE, 6);
  });

  it('keeps two volumes as different as their author made them', () => {
    // q3dm7 ships `hellfogdense` at 128 and `fog_intel` at 800. The whole point
    // of deriving sigma from the map is that this ratio survives.
    expect(fogExtinction(128) / fogExtinction(800)).toBeCloseTo(800 / 128, 6);
  });

  it('scales with the density multiplier', () => {
    expect(fogExtinction(300, 2)).toBeCloseTo(fogExtinction(300) * 2, 9);
  });

  it('floors depthForOpaque at 1, the way R_LoadFogs does', () => {
    // A shader with `fogparms ( 1 1 1 ) 0` must not divide by zero.
    expect(Number.isFinite(fogExtinction(0))).toBe(true);
    expect(fogExtinction(0)).toBe(fogExtinction(1));
    expect(fogExtinction(0.5)).toBe(fogExtinction(1));
  });
});

describe('the box, in three space', () => {
  /*
   * The trap this exists for: `(x, y, z) -> (x, z, -y)` negates one axis, so a
   * componentwise swizzle of both corners leaves min above max on it -- and a
   * slab test against such a box misses EVERY ray, silently.
   */
  it('keeps min below max on the negated axis', () => {
    const box = fogBox(GROUND_FOG);
    for (let i = 0; i < 3; i++) {
      expect(box.min[i]).toBeLessThan(box.max[i]);
    }
  });

  it('maps Q3 z to three y, which is the axis fog is layered on', () => {
    const box = fogBox(GROUND_FOG);
    // Q3 z 8..208 is the fog's thickness, and it has to stay the thickness.
    expect(box.min[1]).toBe(8);
    expect(box.max[1]).toBe(208);
  });

  it('maps Q3 y to three -z without losing the extent', () => {
    const box = fogBox(GROUND_FOG);
    expect(box.min[2]).toBe(-760);
    expect(box.max[2]).toBe(760);
    expect(box.min[0]).toBe(-1592);
    expect(box.max[0]).toBe(1592);
  });

  it('survives a volume whose Q3 bounds are entirely negative', () => {
    // q3dm4's pit sits below the origin on every axis, which is the case a
    // swizzle bug is most likely to survive by accident on a centred map.
    const pit: Fog = {
      ...GROUND_FOG,
      bounds: [
        [-640, -1024, -384],
        [256, -512, -256],
      ],
    };
    const box = fogBox(pit);
    expect(box.min).toEqual([-640, -384, 512]);
    expect(box.max).toEqual([256, -256, 1024]);
    for (let i = 0; i < 3; i++) {
      expect(box.min[i]).toBeLessThan(box.max[i]);
    }
  });
});

describe('the slab test', () => {
  const box = fogBox(GROUND_FOG);

  it('finds the span of a ray dropping into the volume from above', () => {
    // Straight down the three-y axis from well above the fog.
    const hit = slab([0, 1000, 0], [0, -1, 0], box);
    expect(hit).not.toBeNull();
    // Enters at y = 208 (792 units down), leaves at y = 8.
    expect(hit?.[0]).toBeCloseTo(792, 6);
    expect(hit?.[1]).toBeCloseTo(992, 6);
  });

  it('misses a ray that passes over the top', () => {
    // The bug that hid the whole feature: a camera above the volume firing a
    // level ray never enters it, and every ray did that when NDC y was flipped.
    expect(slab([0, 1000, 0], [1, 0, 0], box)).toBeNull();
  });

  it('enters at the eye when the eye is already inside', () => {
    const hit = slab([0, 100, 0], [0, -1, 0], box);
    expect(hit?.[0]).toBe(0);
    expect(hit?.[1]).toBeCloseTo(92, 6);
  });

  it('handles a ray exactly parallel to a pair of planes', () => {
    // `1 / 0` is Infinity and `0 * Infinity` is NaN, so the parallel case is
    // taken before the division. Inside the slab it constrains nothing...
    expect(slab([0, 100, 0], [1, 0, 0], box)).not.toBeNull();
    // ...and outside it, nothing can bring the ray back.
    expect(slab([0, 300, 0], [1, 0, 0], box)).toBeNull();
  });

  it('misses a box that is behind the ray', () => {
    // Firing UP from above the volume.
    expect(slab([0, 1000, 0], [0, 1, 0], box)).toBeNull();
  });
});

describe('?fog and the march parameters', () => {
  const vol = (q: string): ReturnType<typeof parseVolumetricOptions> =>
    parseVolumetricOptions(new URLSearchParams(q));

  it('defaults Modern to volumetric', () => {
    expect(parseFogOptions(new URLSearchParams('')).mode).toBe('volumetric');
    expect(DEFAULT_FOG_OPTIONS.mode).toBe('volumetric');
  });

  it('takes analytic, which is what the faithful preset asks for', () => {
    expect(parseFogOptions(new URLSearchParams('fog=analytic')).mode).toBe('analytic');
  });

  it('falls back to the default on an unknown mode', () => {
    expect(parseFogOptions(new URLSearchParams('fog=raymarch')).mode).toBe('volumetric');
  });

  it('refuses a step count that cannot describe a volume', () => {
    // 0 steps is not a cheaper march, it is no fog; 1 is a single slab and
    // reads as a flat card.
    expect(vol('fogsteps=0').steps).toBe(DEFAULT_VOLUMETRIC_OPTIONS.steps);
    expect(vol('fogsteps=1').steps).toBe(DEFAULT_VOLUMETRIC_OPTIONS.steps);
    expect(vol('fogsteps=8').steps).toBe(8);
  });

  it('clamps the noise so density can never go negative', () => {
    // Density is `1 + noise * (2n - 1)`, so anything above 1 would make the
    // fog ADD light between features.
    expect(vol('fognoise=5').noise).toBe(1);
    expect(vol('fognoise=0').noise).toBe(0);
  });

  it('ignores nonsense rather than removing the fog', () => {
    expect(vol('fogdensity=lots').density).toBe(DEFAULT_VOLUMETRIC_OPTIONS.density);
    expect(vol('fogdensity=-1').density).toBe(DEFAULT_VOLUMETRIC_OPTIONS.density);
  });

  it('damps the extinction depthForOpaque asks for', () => {
    // Quake's number was authored against a per-surface stain, not against an
    // integral through the volume. At 1 the volumes read as paint.
    //
    // The value is taste and is pinned anyway: it is the kind of constant that
    // gets nudged and then silently drifts, and a test naming it makes a
    // change deliberate. 0.5 originally, 0.6 since 2026-09-04.
    expect(DEFAULT_VOLUMETRIC_OPTIONS.density).toBe(0.6);
    expect(vol('').density).toBe(0.6);
    // Still well under Quake's own coefficient, which is the part that matters.
    expect(DEFAULT_VOLUMETRIC_OPTIONS.density).toBeLessThan(1);
    expect(vol('fogdensity=1').density).toBe(1);
  });

  it('shares ?fogfeather with the analytic path', () => {
    // One knob, one default: a player asking for a softer fog edge means the
    // same thing whichever path is drawing it.
    expect(vol('').feather).toBe(FOG_FEATHER);
    expect(vol('fogfeather=0.25').feather).toBe(0.25);
    // Zero is the bare box, and the march compiles no falloff term for it.
    expect(vol('fogfeather=0').feather).toBe(0);
    // ...and it is the same value the analytic path reads from the same URL.
    expect(vol('fogfeather=0.25').feather).toBe(
      parseFogOptions(new URLSearchParams('fogfeather=0.25')).feather,
    );
  });

  it('is off by default for the debug view', () => {
    expect(vol('').debug).toBe('off');
    expect(vol('fogdebug=span').debug).toBe('span');
    expect(vol('fogdebug=nonsense').debug).toBe('off');
  });
});
