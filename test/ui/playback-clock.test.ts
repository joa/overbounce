/**
 * The playback transport's clock format.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Small, but it is the one piece of `playback-chrome.ts` that is a pure
 * function rather than DOM, and it has a real trap in it: it is NOT
 * `hud.ts`'s `formatTime`. A run time is a record and prints three decimals;
 * a scrub position is a place in a video and prints one, because three would
 * jitter every rendered frame. Someone will eventually "unify" the two, and
 * this is what says why not to.
 */

import { describe, it, expect } from 'vitest';
import { formatClock } from '../../src/ui/playback-chrome.js';

describe('formatClock', () => {
  it('matches the frames: minutes, seconds, one decimal', () => {
    // `Pb` and `Pc` both print `0:23.6 / 1:02.4`.
    expect(formatClock(23600)).toBe('0:23.6');
    expect(formatClock(62400)).toBe('1:02.4');
  });

  it('zero-pads the seconds so the string never changes width', () => {
    // A transport readout that grows and shrinks by a character drags the
    // whole row around under a tabular-nums font that was chosen to stop
    // exactly that.
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(5000)).toBe('0:05.0');
    expect(formatClock(9900)).toBe('0:09.9');
  });

  it('rolls over into minutes rather than counting past 60 seconds', () => {
    expect(formatClock(60000)).toBe('1:00.0');
    expect(formatClock(59900)).toBe('0:59.9');
    expect(formatClock(3600000)).toBe('60:00.0');
  });

  it('clamps a negative time instead of printing a minus sign', () => {
    // A scrubber drag past the left edge produces one, and `-0:-0.-1` is
    // not a clock.
    expect(formatClock(-1)).toBe('0:00.0');
    expect(formatClock(-100000)).toBe('0:00.0');
  });

  it('never prints a bare "60" in the seconds field', () => {
    // 59.98s rounds to 60.0 at one decimal, and a clock that splits the
    // minutes off BEFORE rounding then prints `0:60.0` -- the ugly half of
    // every hand-rolled clock. It shipped that way and this is the pin.
    expect(formatClock(59_980)).toBe('1:00.0');
    expect(formatClock(59_950)).toBe('1:00.0');
    expect(formatClock(59_940)).toBe('0:59.9');
    expect(formatClock(119_990)).toBe('2:00.0');
  });

  it('always prints m:ss.d, whatever it is given', () => {
    for (const ms of [0, 1, 99, 100, 59_949, 59_950, 60_000, 599_999, 3_599_999]) {
      expect(formatClock(ms)).toMatch(/^\d+:[0-5]\d\.\d$/);
    }
  });
});
