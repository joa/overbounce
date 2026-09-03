/**
 * The rocket trail's timing and curves.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `CG_RocketTrail` (cg_weapons.c:325) and `CG_AddScaleFade` (cg_localents.c)
 * are two lines of arithmetic each, and both are the kind of line that is easy
 * to write plausibly and wrongly: the emission time uses C INTEGER division,
 * and the radius is written in terms of a value that counts DOWN, so a puff
 * grows where a first reading says it should shrink. Neither mistake produces
 * anything but a slightly different-looking trail, which is exactly the sort
 * of thing that survives review.
 *
 * Every assertion here was checked by mutation -- the code was broken on
 * purpose and the test seen to fail. Two tests written earlier today passed
 * against deliberately broken code, and the rule that came out of that is
 * that a test is not finished until it has been watched to fail.
 */

import { describe, it, expect } from 'vitest';
import {
  TRAIL_ALPHA,
  TRAIL_RADIUS,
  TRAIL_STEP_MS,
  TRAIL_TIME_MS,
  firstPuffTime,
  parseTrailMode,
  puffAt,
} from '../../src/render/smoke-trail.js';

describe('trail constants', () => {
  it('are the ones cg_weapons.c sets for the rocket', () => {
    // step = 50 (:340), wiTrailTime = 2000 (:746), trailRadius = 64 (:747),
    // and CG_SmokePuff is called with a = 0.33 (:374).
    expect(TRAIL_STEP_MS).toBe(50);
    expect(TRAIL_TIME_MS).toBe(2000);
    expect(TRAIL_RADIUS).toBe(64);
    expect(TRAIL_ALPHA).toBeCloseTo(0.33, 6);
  });
});

describe('firstPuffTime', () => {
  it('snaps to the absolute 50ms grid, not to 50ms after the caller', () => {
    // `t = step * ( (startTime + step) / step )` with C integer division.
    // The whole point of the line: a trail's spacing must not depend on when
    // a frame happened to land. 1234 -> 1250, not 1284.
    expect(firstPuffTime(1234)).toBe(1250);
    expect(firstPuffTime(1249)).toBe(1250);
    expect(firstPuffTime(0)).toBe(50);
  });

  it('advances past a time already on the grid', () => {
    // 1200 is a boundary; the next puff is the NEXT one, or a puff already
    // emitted would be emitted again every frame.
    expect(firstPuffTime(1200)).toBe(1250);
  });

  it('walks a whole flight in exact 50ms steps', () => {
    const times: number[] = [];
    for (let t = firstPuffTime(0); t <= 320; t += TRAIL_STEP_MS) {
      times.push(t);
    }
    expect(times).toEqual([50, 100, 150, 200, 250, 300]);
  });
});

describe('puffAt', () => {
  it('GROWS from 8 to 72 units over its life', () => {
    // `re->radius = le->radius * ( 1.0 - c ) + 8` with c counting 1 -> 0, so
    // the radius runs 8 at birth to 64 + 8 at death. Reading `c` as counting
    // up gives a puff that shrinks, which looks like smoke being sucked in.
    expect(puffAt(1000, 1000)!.radius).toBeCloseTo(8, 6);
    expect(puffAt(1000, 1000 + TRAIL_TIME_MS / 2)!.radius).toBeCloseTo(40, 6);
    expect(puffAt(1000, 1000 + TRAIL_TIME_MS - 1)!.radius).toBeCloseTo(71.968, 3);
  });

  it('fades from 0.33 to nothing', () => {
    expect(puffAt(0, 0)!.alpha).toBeCloseTo(0.33, 6);
    expect(puffAt(0, TRAIL_TIME_MS / 2)!.alpha).toBeCloseTo(0.165, 6);
    expect(puffAt(0, TRAIL_TIME_MS - 1)!.alpha).toBeLessThan(0.001);
  });

  it('is over at exactly its end time', () => {
    expect(puffAt(0, TRAIL_TIME_MS)).toBeNull();
    expect(puffAt(0, TRAIL_TIME_MS + 1)).toBeNull();
    // And a puff emitted for a moment that has not arrived yet is not alive:
    // `CG_RocketTrail` walks up to `ent->trailTime`, never past it.
    expect(puffAt(100, 99)).toBeNull();
  });

  it('never grows and fades in step with each other', () => {
    // A single misread of `c` would make both curves run the same way. They
    // are opposites: as the puff gets bigger it gets fainter.
    const early = puffAt(0, 100)!;
    const late = puffAt(0, 1900)!;
    expect(late.radius).toBeGreaterThan(early.radius);
    expect(late.alpha).toBeLessThan(early.alpha);
  });
});

describe('parseTrailMode', () => {
  it('defaults to modern and understands cg_noProjectileTrail', () => {
    expect(parseTrailMode('')).toBe('modern');
    expect(parseTrailMode('trail=faithful')).toBe('faithful');
    expect(parseTrailMode('trail=off')).toBe('off');
    expect(parseTrailMode('trail=0')).toBe('off');
  });

  it('keeps the default on a typo rather than throwing', () => {
    // Same rule as every other option parser here: a bad URL should not be a
    // blank screen.
    expect(parseTrailMode('trail=voluminous')).toBe('modern');
  });
});
