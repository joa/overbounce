/**
 * The weighted attempt lines: the filename convention, and the pick.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { describe, it, expect } from 'vitest';
import {
  APP_SFX,
  ATTEMPT_SFX,
  ATTEMPT_SFX_PATHS,
  ATTEMPT_SFX_TOTAL_WEIGHT,
  FIGHT_SOUND,
  OB_SOUND_COOLDOWN_MS,
  SoundCooldown,
  isAppSfx,
  isFightSound,
  pickWeightedSfx,
  sfxWeight,
} from '../../src/audio/app-sfx.js';
import type { WeightedSfx } from '../../src/audio/app-sfx.js';

describe('sfxWeight', () => {
  it('reads the weight off the front of the filename', () => {
    expect(sfxWeight('sfx/attempt/100_cute.webm')).toBe(100);
    expect(sfxWeight('sfx/attempt/1_kah.webm')).toBe(1);
    expect(sfxWeight('sfx/attempt/25_moms-spaghetti.webm')).toBe(25);
  });

  it('is not confused by digits elsewhere in the path or the name', () => {
    expect(sfxWeight('sfx/99/5_x.webm')).toBe(5);
    expect(sfxWeight('sfx/attempt/10_i-hate-ai-2.webm')).toBe(10);
  });

  it('gives 0 to anything that does not follow the convention', () => {
    // 0 means "never plays", which is the right answer for a typo: it
    // silences one line instead of handing it a share of every other one.
    expect(sfxWeight('sfx/attempt/cute.webm')).toBe(0);
    expect(sfxWeight('sfx/attempt/_cute.webm')).toBe(0);
    expect(sfxWeight('sfx/attempt/0_never.webm')).toBe(0);
  });
});

describe('ATTEMPT_SFX', () => {
  it('carries every attempt line with its weight', () => {
    expect(ATTEMPT_SFX.length).toBe(10);
    expect(ATTEMPT_SFX_TOTAL_WEIGHT).toBe(100 + 100 + 100 + 25 + 25 + 10 + 10 + 5 + 5 + 1);
  });

  it('is made of app sfx paths, so `SoundSystem.load` fetches them', () => {
    for (const path of ATTEMPT_SFX_PATHS) {
      expect(isAppSfx(path)).toBe(true);
    }
    expect(isAppSfx(APP_SFX.overbounce)).toBe(true);
  });

  it('holds no zero-weight entry', () => {
    expect(ATTEMPT_SFX.every((e) => e.weight > 0)).toBe(true);
  });
});

describe('pickWeightedSfx', () => {
  const set: WeightedSfx[] = [
    { path: 'a', weight: 1 },
    { path: 'b', weight: 3 },
    { path: 'c', weight: 6 },
  ];

  it('cuts the roll space into intervals sized by weight', () => {
    // Total 10: a owns [0, .1), b owns [.1, .4), c owns [.4, 1).
    expect(pickWeightedSfx(set, 0)).toBe('a');
    expect(pickWeightedSfx(set, 0.0999)).toBe('a');
    expect(pickWeightedSfx(set, 0.1)).toBe('b');
    expect(pickWeightedSfx(set, 0.3999)).toBe('b');
    expect(pickWeightedSfx(set, 0.4)).toBe('c');
    expect(pickWeightedSfx(set, 0.9999)).toBe('c');
  });

  it('does not fall off the end at a roll of exactly 1', () => {
    // `Math.random()` never returns 1, but the boundary is one off-by-one
    // away from returning undefined and being played as a path.
    expect(pickWeightedSfx(set, 1)).toBe('c');
    expect(pickWeightedSfx(set, 2)).toBe('c');
    expect(pickWeightedSfx(set, -1)).toBe('a');
  });

  it('never picks a zero-weight entry, including at a roll of 0', () => {
    // The reason zero-weight entries are dropped rather than kept at zero
    // width: a zero-width interval still has a left edge, and roll 0 sits on
    // it.
    const withZero: WeightedSfx[] = [
      { path: 'never', weight: 0 },
      { path: 'always', weight: 5 },
    ];
    expect(pickWeightedSfx(withZero, 0)).toBe('always');
    for (let i = 0; i <= 100; i++) {
      expect(pickWeightedSfx(withZero, i / 100)).toBe('always');
    }
  });

  it('returns null when there is nothing pickable', () => {
    expect(pickWeightedSfx([], 0.5)).toBe(null);
    expect(pickWeightedSfx([{ path: 'x', weight: 0 }], 0.5)).toBe(null);
  });

  it('actually follows the weights over many rolls', () => {
    // The assertion that makes this a WEIGHTED pick rather than a random one:
    // swept evenly across the roll space, each line's share of the draws is
    // its share of the total weight.
    const draws = new Map<string, number>();
    const N = 100000;
    for (let i = 0; i < N; i++) {
      const path = pickWeightedSfx(ATTEMPT_SFX, i / N);
      draws.set(path!, (draws.get(path!) ?? 0) + 1);
    }
    for (const entry of ATTEMPT_SFX) {
      const share = (draws.get(entry.path) ?? 0) / N;
      const expected = entry.weight / ATTEMPT_SFX_TOTAL_WEIGHT;
      expect(share).toBeCloseTo(expected, 3);
    }
  });

  it('gives the heaviest line a hundred times the lightest line', () => {
    const heavy = ATTEMPT_SFX.find((e) => e.path.includes('100_cute'))!;
    const light = ATTEMPT_SFX.find((e) => e.path.includes('1_kah'))!;
    expect(heavy.weight / light.weight).toBe(100);
  });
});

describe('isFightSound', () => {
  it('recognises the fight sound Quake ships', () => {
    expect(isFightSound(FIGHT_SOUND)).toBe(true);
    expect(isFightSound('sound/feedback/fight.wav')).toBe(true);
  });

  it('is case-insensitive, the way a pak resolves paths', () => {
    expect(isFightSound('sound/feedback/FIGHT.WAV')).toBe(true);
    expect(isFightSound('Sound/Feedback/Fight.Wav')).toBe(true);
  });

  it('catches it wherever a pak puts it', () => {
    // Matched on the basename: a pak shipping it under another directory is
    // still shipping it, and the promise is about the player's ears.
    expect(isFightSound('sound/misc/fight.wav')).toBe(true);
    expect(isFightSound('fight.wav')).toBe(true);
  });

  it('does not swallow anything else', () => {
    expect(isFightSound('sound/feedback/prepare.wav')).toBe(false);
    expect(isFightSound('sound/feedback/fight1.wav')).toBe(false);
    expect(isFightSound('sound/feedback/dogfight.wav')).toBe(false);
    expect(isFightSound(APP_SFX.overbounce)).toBe(false);
  });

  it('has a replacement set to stand in for it', () => {
    expect(APP_SFX.start.length).toBeGreaterThan(1);
    for (const path of APP_SFX.start) {
      expect(isAppSfx(path)).toBe(true);
    }
  });
});

describe('SoundCooldown', () => {
  it('lets the first one through', () => {
    const cd = new SoundCooldown(3000);
    expect(cd.ready(0)).toBe(true);
    expect(cd.ready(1000)).toBe(false);
  });

  it('holds for the whole interval and opens exactly at its end', () => {
    const cd = new SoundCooldown(3000);
    cd.ready(10000);
    expect(cd.ready(12999)).toBe(false);
    expect(cd.ready(13000)).toBe(true);
  });

  it('re-arms from the play that got through, not from the ones it blocked', () => {
    // The chattering case: an elastic overbounce bouncing on the same spot.
    // A blocked attempt must not push the window out, or a fast enough
    // repeat would silence the sound forever.
    const cd = new SoundCooldown(3000);
    expect(cd.ready(0)).toBe(true);
    for (let t = 100; t < 3000; t += 100) {
      expect(cd.ready(t)).toBe(false);
    }
    expect(cd.ready(3000)).toBe(true);
  });

  it('treats time running backwards as ready', () => {
    // A backward scrub in playback: the overbounce the playhead now reaches
    // is one it is crossing again, not one it just played.
    const cd = new SoundCooldown(3000);
    cd.ready(10000);
    expect(cd.ready(4000)).toBe(true);
  });

  it('forgets on reset, which is what a new attempt is', () => {
    const cd = new SoundCooldown(3000);
    cd.ready(0);
    expect(cd.ready(500)).toBe(false);
    cd.reset();
    expect(cd.ready(500)).toBe(true);
  });

  it('holds the overbounce sound for three seconds', () => {
    expect(OB_SOUND_COOLDOWN_MS).toBe(3000);
  });
});
