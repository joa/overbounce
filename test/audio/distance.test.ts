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
  SOUND_ATTENUATE,
  SOUND_FULLVOLUME,
  distanceVolume,
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
