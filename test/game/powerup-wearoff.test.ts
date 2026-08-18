/**
 * The powerup countdown.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `CG_PowerupTimerSounds`, cg_view.c:702. It is how a player knows to spend the
 * last of a Quad rather than be surprised by losing it, so the timing has to be
 * right rather than approximately right.
 *
 * The logic under test is a BOUNDARY CROSSING, not a threshold. Firing on
 * "less than five seconds left" would play the sound every frame for five
 * seconds — three hundred times instead of five.
 */

import { describe, it, expect } from 'vitest';

const POWERUP_BLINKS = 5;
const POWERUP_BLINK_TIME = 1000;

/** The predicate as ported, extracted so it can be driven tick by tick. */
function fires(expiry: number, now: number, previous: number): boolean {
  if (expiry <= now) {
    return false;
  }
  if (expiry - now >= POWERUP_BLINKS * POWERUP_BLINK_TIME) {
    return false;
  }
  return (
    Math.floor((expiry - now) / POWERUP_BLINK_TIME) !==
    Math.floor((expiry - previous) / POWERUP_BLINK_TIME)
  );
}

describe('powerup wear-off countdown', () => {
  it('covers the last five seconds, not three', () => {
    // POWERUP_BLINKS (5) * POWERUP_BLINK_TIME (1000), cg_local.h:38 and :40.
    expect(POWERUP_BLINKS * POWERUP_BLINK_TIME).toBe(5000);
  });

  /** Run a powerup from pickup to expiry at the real 8ms tick and count sounds. */
  function countOverLifetime(durationMs: number): number {
    const expiry = durationMs;
    let count = 0;
    let previous = 0;
    for (let t = 8; t <= durationMs + 2000; t += 8) {
      if (fires(expiry, t, previous)) {
        count++;
      }
      previous = t;
    }
    return count;
  }

  it('plays exactly five times over a Quad, once per second', () => {
    // Not once per frame for five seconds, which is what a naive threshold
    // gives: 5000ms / 8ms = 625 sounds.
    expect(countOverLifetime(30_000)).toBe(5);
  });

  it('says nothing until the last five seconds', () => {
    const expiry = 30_000;
    // Four seconds in, with 26 remaining, there is nothing to warn about.
    expect(fires(expiry, 4000, 3992)).toBe(false);
    // Six seconds left: still silent.
    expect(fires(expiry, 24_000, 23_992)).toBe(false);
  });

  it('says nothing once the powerup has gone', () => {
    // `if ( t <= cg.time ) continue;` -- an expired slot is skipped, and every
    // unused slot holds 0, so this is also what keeps a player with no
    // powerups silent.
    expect(fires(30_000, 30_000, 29_992)).toBe(false);
    expect(fires(30_000, 31_000, 30_992)).toBe(false);
    expect(fires(0, 5000, 4992)).toBe(false);
  });

  it('fires on the crossing even when a frame is long', () => {
    // A hitch that skips a whole second must still produce its sound, because
    // the test compares the two sides of the boundary rather than sampling.
    expect(fires(30_000, 27_500, 26_400)).toBe(true);
  });
});
