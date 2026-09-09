/**
 * Distance attenuation: the distance half of `S_SpatializeOrigin`.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Expected values are worked from snd_dma.c's constants, not from what the
 * port returns: `SOUND_FULLVOLUME` 80 and `SOUND_ATTENUATE` 0.0008, so the
 * curve is flat to 80 and a straight line to silence 1250 units later.
 */

import { describe, it, expect } from 'vitest';
import {
  MISSILE_SOUNDS,
  SOUND_ATTENUATE,
  SOUND_FULLVOLUME,
  distanceVolume,
  dopplerScale,
  listenerPan,
  panScales,
} from '../../src/audio/sound.js';

describe('the constants', () => {
  it('are snd_dma.c:56 and :58', () => {
    expect(SOUND_FULLVOLUME).toBe(80);
    expect(SOUND_ATTENUATE).toBe(0.0008);
  });
});

describe('distanceVolume', () => {
  it('is full volume at and inside SOUND_FULLVOLUME', () => {
    expect(distanceVolume(0)).toBe(1);
    expect(distanceVolume(40)).toBe(1);
    expect(distanceVolume(80)).toBe(1);
  });

  it('falls linearly to silence 1250 units past that', () => {
    // dist = (d - 80) * 0.0008; scale = 1 - dist.
    expect(distanceVolume(80 + 625)).toBeCloseTo(0.5, 6);
    expect(distanceVolume(80 + 312.5)).toBeCloseTo(0.75, 6);
    expect(distanceVolume(1330)).toBeCloseTo(0, 6);
  });

  it('never goes negative, however far', () => {
    // `if (*right_vol < 0) *right_vol = 0;`
    expect(distanceVolume(5000)).toBe(0);
    expect(distanceVolume(Infinity)).toBe(0);
  });

  it('treats a missing or nonsense distance as at the ear', () => {
    expect(distanceVolume(NaN)).toBe(1);
    expect(distanceVolume(-10)).toBe(1);
  });
});

/**
 * The stereo half of `S_SpatializeOrigin`: `rscale = 0.5 * (1 + dot)`,
 * `lscale = 0.5 * (1 - dot)`, each clamped at 0. Linear, so a centred sound
 * is at HALF in each ear -- not equal-power's 0.707.
 */
describe('panScales', () => {
  it('is half and half at the centre', () => {
    expect(panScales(0)).toEqual([0.5, 0.5]);
  });

  it('is all one ear at the extremes', () => {
    expect(panScales(1)).toEqual([0, 1]);
    expect(panScales(-1)).toEqual([1, 0]);
  });

  it('is linear in between, not equal-power', () => {
    expect(panScales(0.5)).toEqual([0.25, 0.75]);
  });

  it('clamps a dot outside the unit range at zero, as the C does', () => {
    expect(panScales(1.5)).toEqual([0, 1.25]);
  });
});

describe('listenerPan', () => {
  // A listener at the origin whose right-hand axis is +Y. Which camera
  // orientation produces that is main.ts's business, not this function's.
  const ear = [0, 0, 0];
  const right = [0, 1, 0];

  it('is +1 for a sound straight to the right and -1 to the left', () => {
    expect(listenerPan(ear, right, [0, 300, 0])).toBe(1);
    expect(listenerPan(ear, right, [0, -300, 0])).toBe(-1);
  });

  it('is 0 straight ahead, behind, above', () => {
    expect(listenerPan(ear, right, [500, 0, 0])).toBe(0);
    expect(listenerPan(ear, right, [-500, 0, 0])).toBe(0);
    expect(listenerPan(ear, right, [0, 0, 64])).toBe(0);
  });

  it('is the cosine of the angle off the right axis, distance-free', () => {
    // 45 degrees right-and-ahead, at two distances: same dot.
    expect(listenerPan(ear, right, [100, 100, 0])).toBeCloseTo(Math.SQRT1_2, 9);
    expect(listenerPan(ear, right, [1000, 1000, 0])).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it('centres a sound at the ear, and everything with no axis', () => {
    // `VectorNormalize` of the zero vector leaves zero in Quake: dot 0.
    expect(listenerPan(ear, right, [0, 0, 0])).toBe(0);
    expect(listenerPan(ear, null, [0, 300, 0])).toBe(0);
  });
});

describe('missile sounds', () => {
  it('are the rocket’s and the plasma gun’s, and the grenade has none', () => {
    // cg_weapons.c:744 and :795. The grenade launcher's CG_RegisterWeapon
    // branch sets no missileSound.
    expect(MISSILE_SOUNDS['rocket']).toBe('sound/weapons/rocket/rockfly.wav');
    expect(MISSILE_SOUNDS['plasma']).toBe('sound/weapons/plasma/lasfly.wav');
    expect(MISSILE_SOUNDS['grenade']).toBeUndefined();
  });
});

/**
 * `dopplerScale = lenb / (lena * 100)`, doppler off at <= 1. Worked by hand
 * from snd_dma.c:776-787; the surprising cases are the point.
 */
describe('dopplerScale', () => {
  it('is 1 for a missile that is not moving', () => {
    expect(dopplerScale([0, 0, 0], [100, 0, 0], [0, 0, 0])).toBe(1);
  });

  it('is 1 for a missile approaching the ear, however fast', () => {
    // lena = 500^2, lenb = (500-2000)^2 = 1500^2; 2.25e6 / 2.5e7 = 0.09.
    expect(dopplerScale([0, 0, 0], [500, 0, 0], [-2000, 0, 0])).toBe(1);
  });

  it('is 1 for a missile receding from far away', () => {
    // lena = 1000^2, lenb = 3000^2; 9e6 / 1e8 = 0.09 -- "don't bother".
    expect(dopplerScale([0, 0, 0], [1000, 0, 0], [2000, 0, 0])).toBe(1);
  });

  it('speeds up a missile receding from close by -- Quake’s zip', () => {
    // lena = 100^2 = 1e4, lenb = 2100^2 = 4.41e6; 4.41e6 / 1e6 = 4.41.
    expect(dopplerScale([0, 0, 0], [100, 0, 0], [2000, 0, 0])).toBeCloseTo(4.41, 6);
    // Exactly at the threshold: lenb = 100 * lena is "<= 1.0", off.
    // lena = 100 (d = 10), lenb = 10000 (d = 100): v = 90.
    expect(dopplerScale([0, 0, 0], [10, 0, 0], [90, 0, 0])).toBe(1);
  });
});
