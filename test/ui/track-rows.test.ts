/**
 * The timeline rows' units, and the round trip through the value cell.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `formatValue` prints into a 64px cell, `toInputText` fills the field a click
 * on that cell opens, and `parseValue` reads it back. The two directions have
 * to agree about what the number MEANS or the cell and the field are talking
 * about different values -- a user editing `35%` types `35`, not `0.35`.
 *
 * `parseValue` returning null rather than NaN is the other half, and it is
 * load-bearing rather than tidy: a NaN written into a track is not a bad value
 * that shows up as a bad value, it propagates through `evaluateTrack`'s
 * interpolation and turns a whole span of the shot into nothing, with `NaN` in
 * a 64px cell as the only clue.
 */

import { describe, it, expect } from 'vitest';
import {
  TRACK_ROWS,
  formatValue,
  parseValue,
  toInputText,
} from '../../src/ui/playback-chrome/track-rows.js';
import type { ValueScale } from '../../src/ui/playback-chrome/track-rows.js';

const SCALE = (unit: ValueScale['unit']): ValueScale => ({
  unit,
  min: 0,
  max: 1,
  zeroIsOff: false,
});

describe('value units', () => {
  it('prints each unit the way its row means it', () => {
    expect(formatValue(SCALE('deg'), 92.4)).toBe('92°');
    expect(formatValue(SCALE('percent'), 0.35)).toBe('35%');
    expect(formatValue(SCALE('scalar'), 0.1)).toBe('0.10');
    expect(formatValue(SCALE('multiplier'), 0.5)).toBe('0.50×');
  });

  it('round-trips through the field a click opens', () => {
    /*
     * Each unit over ITS OWN domain, because the round trip is only claimed
     * at the precision the cell prints. `deg` rounds to whole degrees on
     * purpose -- a field of view of 92.4 is 92 in a 64px cell and 0.25 is not
     * a field of view at all -- so feeding it a fraction tests nothing about
     * the conversion and only re-discovers the rounding.
     */
    const domains: Record<ValueScale['unit'], number[]> = {
      deg: [50, 92, 140],
      percent: [0, 0.25, 0.5, 1],
      scalar: [0, 0.1, 0.5, 1],
      multiplier: [0.1, 0.25, 1, 4],
    };
    for (const unit of ['deg', 'percent', 'scalar', 'multiplier'] as const) {
      const scale = SCALE(unit);
      for (const value of domains[unit]) {
        const back = parseValue(scale, toInputText(scale, value));
        expect(back, `${unit} lost ${value}`).toBeCloseTo(value, 2);
      }
    }
  });

  it('strips the unit a cell printed, so a user can retype it', () => {
    // The cell says `92°`, which invites typing `95°` straight back into it.
    expect(parseValue(SCALE('deg'), '95°')).toBe(95);
    expect(parseValue(SCALE('percent'), '40%')).toBeCloseTo(0.4);
    expect(parseValue(SCALE('multiplier'), '0.50×')).toBe(0.5);
    // `x` as well as `×`: the multiplication sign has no key on a keyboard,
    // and rejecting the letter would make TIME SCALE the one row whose own
    // printed value could not be typed back.
    expect(parseValue(SCALE('multiplier'), '2x')).toBe(2);
    expect(parseValue(SCALE('multiplier'), '2X')).toBe(2);
  });

  it('returns null rather than NaN for anything unparseable', () => {
    for (const text of ['', '   ', 'fast', '×', '--']) {
      expect(parseValue(SCALE('multiplier'), text)).toBeNull();
    }
  });
});

describe('TIME SCALE', () => {
  const row = TRACK_ROWS.find((r) => r.label === 'TIME SCALE')!;

  it('is the last row', () => {
    // Not cosmetic. `tools/browser/timeline-drag.ts` addresses FOV as
    // `:nth-child(3)` of the track list, so a row inserted above it silently
    // moves every assertion in that harness onto a different lane -- and the
    // harness would still pass, because the rows it would then be dragging
    // are also faders.
    expect(TRACK_ROWS.at(-1)).toBe(row);
  });

  it('cannot reach a time scale of zero', () => {
    // `timeScaleAt` clamps positive at 0.01 because a zero or negative scale
    // is a paused or reversed clip, and the transport owns those. A fader
    // that could reach 0 would offer a freeze the model refuses to give it,
    // so the readout and the picture would disagree about what just happened.
    // Every write goes through `setRowValue`, which clamps to this range.
    expect(row.scale!.min).toBeGreaterThan(0.01);
    expect(row.scale!.zeroIsOff).toBe(false);
    expect(row.fallback).toBe(1);
  });
});
