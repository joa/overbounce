/**
 * The pure parts of the grid-steered shadow map.
 *
 * The GPU path cannot be tested headlessly and is not the interesting part
 * anyway: what decides whether the feature looks good is the direction filter
 * and the texel snap, and both are ordinary arithmetic.
 */

import { describe, expect, it } from 'vitest';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  DEFAULT_SHADOW_OPTIONS,
  MAX_STEER_STEP_MS,
  castsShadow,
  clampElevation,
  parseShadowOptions,
  snapShadowCenter,
  steerShadowDirection,
} from '../../src/render/shadow-map.js';
import { applyAdditiveBlend, applyAlphaBlend, applyFilterBlend } from '../../src/render/blend.js';

const len = (v: readonly number[]): number => Math.hypot(v[0], v[1], v[2]);

describe('parseShadowOptions', () => {
  it('defaults with no query string', () => {
    expect(parseShadowOptions('')).toEqual(DEFAULT_SHADOW_OPTIONS);
  });

  it('reads the three modes', () => {
    expect(parseShadowOptions('?shadows=off').mode).toBe('off');
    expect(parseShadowOptions('?shadows=blob').mode).toBe('blob');
    expect(parseShadowOptions('?shadows=dynamic').mode).toBe('dynamic');
    // A bare `?shadows` means Quake's own shadow, not "whatever the default is
    // today" -- the default is a decision that can change and `?shadows=blob`
    // has to keep meaning the blob.
    expect(parseShadowOptions('?shadows').mode).toBe('blob');
  });

  it('keeps the default and warns on a value it does not know', () => {
    expect(parseShadowOptions('?shadows=stencil').mode).toBe(DEFAULT_SHADOW_OPTIONS.mode);
  });

  it('clamps strength and elevation into 0..1', () => {
    expect(parseShadowOptions('?shadowstrength=5').strength).toBe(1);
    expect(parseShadowOptions('?shadowstrength=-1').strength).toBe(0);
    expect(parseShadowOptions('?shadowelev=2').minElevation).toBe(1);
  });

  it('takes the tuning knobs', () => {
    const o = parseShadowOptions('?shadows=dynamic&shadowextent=96&shadowsize=2048&shadowdamp=0');
    expect(o.extent).toBe(96);
    expect(o.size).toBe(2048);
    expect(o.damping).toBe(0);
  });

  it('has a debug view, off unless asked for', () => {
    expect(parseShadowOptions('').debug).toBe(false);
    expect(parseShadowOptions('?shadowdebug').debug).toBe(true);
    expect(parseShadowOptions('?shadowdebug=0').debug).toBe(false);
  });
});

describe('clampElevation', () => {
  it('leaves a high sun alone', () => {
    const d = clampElevation([0, 0, 1], 0.5);
    expect(d).toEqual([0, 0, 1]);
  });

  it('raises a near-horizontal direction to the floor, keeping its heading', () => {
    const d = clampElevation([1, 0, 0], 0.5);
    expect(d[2]).toBeCloseTo(0.5, 6);
    // Still pointing +x, still unit length.
    expect(d[1]).toBeCloseTo(0, 6);
    expect(d[0]).toBeGreaterThan(0);
    expect(len(d)).toBeCloseTo(1, 6);
  });

  it('preserves the compass heading exactly', () => {
    const d = clampElevation([3, 4, 0.1], 0.6);
    // atan2 of the horizontal part is untouched.
    expect(Math.atan2(d[1], d[0])).toBeCloseTo(Math.atan2(4, 3), 6);
    expect(len(d)).toBeCloseTo(1, 6);
  });

  it('answers straight up for a degenerate sample', () => {
    expect(clampElevation([0, 0, 0], 0.5)).toEqual([0, 0, 1]);
    // A light directly below is what an all-black grid cell would give.
    expect(clampElevation([0, 0, -1], 0.5)).toEqual([0, 0, 1]);
  });
});

describe('steerShadowDirection', () => {
  const opts = { damping: 250, minElevation: 0.5 };

  it('adopts the first direction outright rather than easing from nowhere', () => {
    const d = steerShadowDirection(null, [1, 0, 1], 16, opts);
    expect(d).toEqual(clampElevation([1, 0, 1], 0.5));
  });

  it('moves toward the target without reaching it in one frame', () => {
    const from = clampElevation([1, 0, 1], 0.5);
    const d = steerShadowDirection(from, [-1, 0, 1], 16, opts);
    // Leaning the right way...
    expect(d[0]).toBeLessThan(from[0]);
    // ...but nowhere near arrived: 16ms against a 250ms constant is ~6%.
    expect(d[0]).toBeGreaterThan(0);
    expect(len(d)).toBeCloseTo(1, 6);
  });

  it('is frame-rate independent', () => {
    const from: [number, number, number] = [0, 0, 1];
    const target = [1, 0, 0.6];

    // One 32ms step against two 16ms steps. Exponential decay composes, so the
    // two agree to within the curvature of the sphere they are blending on.
    const coarse = steerShadowDirection(from, target, 32, opts);
    let fine = steerShadowDirection(from, target, 16, opts);
    fine = steerShadowDirection(fine, target, 16, opts);

    for (let i = 0; i < 3; i++) {
      expect(fine[i]).toBeCloseTo(coarse[i], 2);
    }
  });

  it('does not snap after a hitch', () => {
    // A tab switch or a stall hands this a dt in the hundreds of ms. Uncapped,
    // `1 - exp(-2000/250)` is 0.9997 and the light jumps on the frame the game
    // comes back -- which is exactly the swing the damper exists to prevent.
    const from: [number, number, number] = [0, 0, 1];
    const target = [1, 0, 0.6];
    const capped = steerShadowDirection(from, target, MAX_STEER_STEP_MS, opts);
    const absurd = steerShadowDirection(from, target, 2000, opts);
    for (let i = 0; i < 3; i++) {
      expect(absurd[i]).toBeCloseTo(capped[i], 6);
    }
    // And the cap really is a cap, not a clamp to nothing: it still moved.
    expect(absurd[0]).toBeGreaterThan(0.1);
    expect(absurd[0]).toBeLessThan(0.7);
  });

  it('snaps when damping is disabled', () => {
    const d = steerShadowDirection([0, 0, 1], [1, 0, 1], 16, { ...opts, damping: 0 });
    expect(d).toEqual(clampElevation([1, 0, 1], 0.5));
  });

  it('never lets the damped result dip below the elevation floor', () => {
    let d = steerShadowDirection(null, [0, 0, 1], 16, opts);
    for (let i = 0; i < 200; i++) {
      d = steerShadowDirection(d, [1, 0, 0], 16, opts);
      expect(d[2]).toBeGreaterThanOrEqual(0.5 - 1e-6);
      expect(len(d)).toBeCloseTo(1, 6);
    }
  });
});

describe('snapShadowCenter', () => {
  const texel = 0.3125; // 320 units over 1024 texels

  it('is idempotent — snapping an already-snapped centre moves nothing', () => {
    const dir = [0.3, -0.4, 0.866];
    const once = snapShadowCenter([123.456, -78.9, 42.1], dir, texel);
    const twice = snapShadowCenter(once, dir, texel);
    for (let i = 0; i < 3; i++) {
      expect(twice[i]).toBeCloseTo(once[i], 5);
    }
  });

  it('holds still while the true centre creeps by less than a texel', () => {
    const dir = [0, 0, 1];
    const a = snapShadowCenter([100, 200, 50], dir, texel);
    const b = snapShadowCenter([100.01, 200.02, 50], dir, texel);
    // The whole point: a sub-texel move must not move the projection at all,
    // or the shadow's edge boils while the player stands still.
    for (let i = 0; i < 3; i++) {
      expect(b[i]).toBeCloseTo(a[i], 6);
    }
  });

  it('never moves the centre by more than a texel', () => {
    const dir = [0.5, 0.2, 0.84];
    for (let i = 0; i < 50; i++) {
      const c = [i * 7.31, -i * 3.17, i * 1.9];
      const s = snapShadowCenter(c, dir, texel);
      const moved = Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]);
      expect(moved).toBeLessThanOrEqual(texel * Math.SQRT2 + 1e-6);
    }
  });

  it('does not disturb depth along the light', () => {
    const dir = [0, 0, 1];
    // With the light straight up, the snapped axes are x and y and z is the
    // depth axis, so z must come back untouched.
    const s = snapShadowCenter([10.7, -3.2, 91.234], dir, texel);
    expect(s[2]).toBeCloseTo(91.234, 5);
  });

  it('passes the centre through when there is no texel size', () => {
    expect(snapShadowCenter([1, 2, 3], [0, 0, 1], 0)).toEqual([1, 2, 3]);
  });
});

describe('castsShadow', () => {
  it('accepts an ordinary opaque surface', () => {
    expect(castsShadow(new MeshBasicNodeMaterial())).toBe(true);
  });

  it('rejects every Quake blendfunc that is not an opaque draw', () => {
    // The shadow pass draws casters solid black and receivers are darkened by
    // multiplication, so a glow, a filter decal and an alpha sheet are all
    // wrong on both sides. `blend.ts` marks all three the same way.
    for (const apply of [applyAdditiveBlend, applyFilterBlend, applyAlphaBlend]) {
      const m = new MeshBasicNodeMaterial();
      apply(m);
      expect(castsShadow(m)).toBe(false);
    }
  });

  it('demands every material of a multi-material mesh', () => {
    const opaque = new MeshBasicNodeMaterial();
    const glow = new MeshBasicNodeMaterial();
    applyAdditiveBlend(glow);
    expect(castsShadow([opaque, opaque])).toBe(true);
    expect(castsShadow([opaque, glow])).toBe(false);
  });
});
