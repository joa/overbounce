/**
 * The post-processing layer's off switches.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Nothing in `post.ts` is Quake, so none of it can be tested for correctness
 * against a C source the way the physics is. What CAN be pinned — and is the
 * only part that has to keep working for the project's sake — is that every
 * effect can be turned off, that the whole layer can be turned off, and that
 * turning it off yields a chain the renderer refuses to build at all.
 *
 * `.agent/plans/VISUALS.md`: "Every Track B feature needs an off switch, and
 * the suite must pass with the whole layer disabled — that is what keeps it
 * from becoming load-bearing."
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_POST_OPTIONS,
  applyPostColorMapping,
  parsePostOptions,
  postIsNoop,
} from '../../src/render/post.js';
import {
  getColorMapping,
  lightingShift,
  resetColorMapping,
} from '../../src/render/color-mapping.js';
import { OVERBRIGHT_SHIFT, colorShiftLightingBytes } from '../../src/render/bsp-mesh.js';

afterEach(() => {
  resetColorMapping();
});

describe('defaults', () => {
  const o = parsePostOptions('');

  it('turns the layer on with tone mapping and FXAA', () => {
    expect(o.enabled).toBe(true);
    expect(o.fxaa).toBe(true);
  });

  it('applies AgX, at an exposure that is not 1', () => {
    // The project owner asked for the filmic curve as the default. Quake has no
    // tone curve, so this is an aesthetic choice and not a fidelity one, and
    // `?tonemap=off` below is the setting that takes it back.
    //
    // The exposure is pinned as "not 1" rather than as a number because it is
    // the load-bearing half: AgX is scene-referred and Quake's content is
    // display-referred, so at exposure 1 the whole picture sits in the curve's
    // toe. See the measurements in post.ts's header.
    expect(o.tone).toBe('agx');
    expect(o.exposure).toBeGreaterThan(1);
    expect(o.exposure).toBeLessThanOrEqual(2);
  });

  it('enables SSAO on the world only, with a darkening cap, at reduced resolution', () => {
    expect(o.ssao).toBe('world');
    expect(o.ssaoStrength).toBeGreaterThan(0);
    expect(o.ssaoStrength).toBeLessThanOrEqual(1);
    // Legibility: a ledge edge has to stay readable.
    expect(o.ssaoMaxDarkening).toBeGreaterThan(0);
    expect(o.ssaoMaxDarkening).toBeLessThanOrEqual(0.5);
    // World scale is ~1 unit per inch; 32 units is already a large radius, and
    // radius is one of the two things that made this pass cost 72% of the frame.
    expect(o.ssaoRadius).toBeGreaterThan(0);
    expect(o.ssaoRadius).toBeLessThanOrEqual(32);
    // The other one. Full resolution measured 2.7x the cost of half for a
    // picture that is the same to within the noise, so the default must not
    // drift back to 1 without someone re-measuring.
    expect(o.ssaoResolution).toBeLessThanOrEqual(0.5);
    expect(o.ssaoResolution).toBeGreaterThan(0);
    expect(o.ssaoSamples).toBe(16);
  });

  it('turns chromatic aberration on, but small', () => {
    // Not 0: at 0 the stage is not constructed at all, and a feature nobody can
    // see is indistinguishable from one that was never built — which is exactly
    // how the previous default was reported. Small enough that the displacement
    // at the crosshair is zero by construction (it is proportional to distance
    // from the centre) and about a pixel at the edge of the frame.
    expect(o.aberration).toBeGreaterThan(0);
    expect(o.aberration).toBeLessThanOrEqual(0.25);
  });

  it('leaves the colour mapping at Quake-in-a-window', () => {
    expect(o.colorMapping).toEqual({ gamma: 1, overbrightBits: 0, mapOverBrightBits: 2 });
  });

  it('agrees with the exported default record', () => {
    expect(o).toEqual({ ...DEFAULT_POST_OPTIONS });
  });
});

describe('?post=off', () => {
  it('is a no-op chain, so the renderer never builds one', () => {
    const o = parsePostOptions('?post=off');
    expect(o.enabled).toBe(false);
    expect(postIsNoop(o)).toBe(true);
  });

  it('stays a no-op no matter what else is asked for', () => {
    const o = parsePostOptions('?post=off&ssao=all&tonemap=agx&aberration=2&gamma=2');
    expect(postIsNoop(o)).toBe(true);
  });

  it('does NOT consider the default chain a no-op', () => {
    // FXAA alone changes pixels, so the default must build.
    expect(postIsNoop(parsePostOptions(''))).toBe(false);
  });

  it('recognises an all-off chain even without ?post=off', () => {
    // Every effect has to be named now that three of them are on by default,
    // which is the point: turning one thing off is no longer enough to make the
    // chain a pass-through, and the check has to notice.
    // Built per case rather than by appending, because URLSearchParams.get
    // returns the FIRST occurrence — `...&tonemap=off&tonemap=agx` is still off.
    const allOff = (extra = ''): string =>
      `?fxaa=off&ssao=off&tonemap=off&aberration=0${extra}`;
    expect(postIsNoop(parsePostOptions(allOff()))).toBe(true);
    // ...but not once one effect comes back.
    expect(postIsNoop(parsePostOptions('?fxaa=off&ssao=off&tonemap=agx&aberration=0'))).toBe(false);
    expect(postIsNoop(parsePostOptions('?fxaa=off&ssao=off&tonemap=off&aberration=0.3'))).toBe(
      false,
    );
    expect(postIsNoop(parsePostOptions(allOff('&gamma=1.5')))).toBe(false);
    expect(postIsNoop(parsePostOptions('?fxaa=on&ssao=off&tonemap=off&aberration=0'))).toBe(false);
    expect(postIsNoop(parsePostOptions('?fxaa=off&ssao=world&tonemap=off&aberration=0'))).toBe(
      false,
    );
    // The shipped defaults are emphatically not a pass-through.
    expect(postIsNoop(parsePostOptions('?fxaa=off&ssao=off'))).toBe(false);
  });
});

describe('individual switches', () => {
  it('?ssao=off', () => {
    expect(parsePostOptions('?ssao=off').ssao).toBe('off');
    expect(parsePostOptions('?ssao=0').ssao).toBe('off');
  });

  it('?ssao=all ignores the world mask', () => {
    expect(parsePostOptions('?ssao=all').ssao).toBe('all');
  });

  it('?ssao=<number> is a strength, and stays world-masked', () => {
    const o = parsePostOptions('?ssao=0.25');
    expect(o.ssao).toBe('world');
    expect(o.ssaoStrength).toBeCloseTo(0.25);
  });

  it('clamps a strength outside 0..1 rather than letting it invert the image', () => {
    expect(parsePostOptions('?ssao=5').ssaoStrength).toBe(1);
    expect(parsePostOptions('?ssaostrength=-2').ssaoStrength).toBe(0);
    expect(parsePostOptions('?ssaomax=3').ssaoMaxDarkening).toBe(1);
  });

  it('?fxaa=off', () => {
    expect(parsePostOptions('?fxaa=off').fxaa).toBe(false);
  });

  it('?tonemap= picks a curve, and off means none', () => {
    expect(parsePostOptions('?tonemap=agx').tone).toBe('agx');
    expect(parsePostOptions('?tonemap=aces').tone).toBe('aces');
    expect(parsePostOptions('?tonemap=neutral').tone).toBe('neutral');
    expect(parsePostOptions('?tonemap=off').tone).toBe('none');
    expect(parsePostOptions('?tonemap=none').tone).toBe('none');
  });

  it('?aberration= sets the strength, and 0 removes the stage', () => {
    expect(parsePostOptions('?aberration=0.4').aberration).toBeCloseTo(0.4);
    expect(parsePostOptions('?aberration=0').aberration).toBe(0);
  });

  it('?exposure= only ever feeds the tone curve, and is clamped', () => {
    expect(parsePostOptions('?exposure=2.5').exposure).toBeCloseTo(2.5);
    // `createPostChain` skips the multiply when there is no curve, so this is
    // carried but inert.
    expect(parsePostOptions('?tonemap=off&exposure=2.5').tone).toBe('none');
    expect(parsePostOptions('?exposure=0').exposure).toBe(0.1);
    expect(parsePostOptions('?exposure=99').exposure).toBe(8);
  });

  it('?ssaoresolution= and ?ssaosamples= are the cost dials', () => {
    expect(parsePostOptions('?ssaoresolution=0.25').ssaoResolution).toBeCloseTo(0.25);
    // Above 1 would render the AO larger than the frame, which is only ever a
    // typo; below 0.1 it is a handful of texels.
    expect(parsePostOptions('?ssaoresolution=4').ssaoResolution).toBe(1);
    expect(parsePostOptions('?ssaoresolution=0').ssaoResolution).toBe(0.1);
    expect(parsePostOptions('?ssaosamples=8').ssaoSamples).toBe(8);
    expect(parsePostOptions('?ssaosamples=1').ssaoSamples).toBe(3);
    expect(parsePostOptions('?ssaosamples=1000').ssaoSamples).toBe(64);
  });

  it('carries the faithful colour cvars through', () => {
    const o = parsePostOptions('?gamma=1.4&overbright=1&mapoverbright=3');
    expect(o.colorMapping).toEqual({
      gamma: 1.4,
      overbrightBits: 1,
      mapOverBrightBits: 3,
    });
  });
});

describe('the layer disabled changes nothing outside itself', () => {
  it('leaves the lightmap shift where the renderer hardcoded it', () => {
    applyPostColorMapping(parsePostOptions('?post=off'));
    expect(lightingShift()).toBe(OVERBRIGHT_SHIFT);
    expect(colorShiftLightingBytes(10, 20, 30)).toEqual([40, 80, 120]);
  });

  it('leaves it there with the layer fully ON at defaults, too', () => {
    // The chain being built must not move a single lightmap byte. If this ever
    // fails, `?post=off` and `?post=on` stopped being the same picture minus
    // the effects, and every before/after screenshot in the repo is invalid.
    applyPostColorMapping(parsePostOptions(''));
    expect(lightingShift()).toBe(OVERBRIGHT_SHIFT);
    expect(colorShiftLightingBytes(10, 20, 30)).toEqual([40, 80, 120]);
  });

  it('still applies ?mapoverbright with the layer off, because that is baked at load', () => {
    applyPostColorMapping(parsePostOptions('?post=off&mapoverbright=3'));
    expect(lightingShift()).toBe(3);
  });

  it('clamps what it installs the way R_SetColorMappings does', () => {
    applyPostColorMapping(parsePostOptions('?gamma=99&overbright=99'));
    expect(getColorMapping()).toEqual({
      gamma: 3,
      overbrightBits: 2,
      mapOverBrightBits: 2,
    });
  });
});

describe('bad input', () => {
  it('falls back to the default rather than to NaN', () => {
    expect(parsePostOptions('?ssaoradius=banana').ssaoRadius).toBe(
      DEFAULT_POST_OPTIONS.ssaoRadius,
    );
    expect(parsePostOptions('?fxaa=maybe').fxaa).toBe(DEFAULT_POST_OPTIONS.fxaa);
    expect(parsePostOptions('?tonemap=lomo').tone).toBe(DEFAULT_POST_OPTIONS.tone);
    expect(parsePostOptions('?ssao=sometimes').ssao).toBe(DEFAULT_POST_OPTIONS.ssao);
    expect(parsePostOptions('?exposure=bright').exposure).toBe(DEFAULT_POST_OPTIONS.exposure);
    expect(parsePostOptions('?ssaoresolution=half').ssaoResolution).toBe(
      DEFAULT_POST_OPTIONS.ssaoResolution,
    );
  });

  it('treats a bare flag as on', () => {
    expect(parsePostOptions('?fxaa').fxaa).toBe(true);
    expect(parsePostOptions('?ssao').ssao).toBe('world');
  });
});
