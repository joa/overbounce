/**
 * The playback timeline's property rows, and the units they print in.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Pure data and pure functions: what the five rows of `Pc` are, which tracks
 * each one writes, and how a track's number is turned into a string and back.
 * `track-list.ts` is the DOM that draws them.
 */

import type { TrackId } from '../../playback/timeline.js';

/**
 * How a row's number is PRINTED and how far a fader drag travels.
 *
 * `min`/`max` are a DISPLAY range, not a clamp the model imposes: they decide
 * where the fader line sits in its 20px lane and how many units a pixel of
 * drag is worth. Both halves have to come from somewhere defensible, and the
 * one defensible source in this repo is `src/ui/photo-mode.ts`, whose LOOK
 * and CAMERA panels already put sliders on exactly these four numbers. Using
 * its ranges means the same value reads the same in both screens, and it
 * means nothing here was invented to make a mockup's number appear.
 *
 * The units, and what was actually found in the code they come from:
 *
 * | row | unit | range | source |
 * | --- | --- | --- | --- |
 * | FOV | degrees | 50..140 | photo mode's `fovSlider` |
 * | VIGNETTE | 0..1, printed as a percent | 0..1 | `post.ts`, "corner darkening, 0..1" |
 * | DOF | 0..1, printed as a percent | 0..1 | nothing consumes it -- see UNCONSUMED_TRACKS |
 * | CHROMATIC AB. | dimensionless strength | 0..1 | photo mode's aberration slider |
 *
 * **The frame's `4px` for chromatic aberration is aspirational and is not
 * reproduced here.** `aberration` is a multiplier on a hardcoded 0.022 of the
 * distance from the centre of the frame, so its displacement in PIXELS
 * depends on how wide the frame is: `post.ts` measures the default 0.1 at 1.4
 * pixels on a 1280-wide picture, which makes the frame's 4px a strength of
 * about 0.28 there and about 0.14 at 2560. A readout that changed when the
 * window was resized, without the shot having changed at all, would be a
 * worse readout than the raw strength. So the raw strength is what is
 * printed, and the mockup's unit is recorded here as the thing it is.
 */
export interface ValueScale {
  /** `deg` prints 92 degrees, `percent` prints 35 percent, `scalar` prints 0.10. */
  unit: 'deg' | 'percent' | 'scalar';
  min: number;
  max: number;
  /**
   * True when a value of 0 means the stage is not built at all, so the cell
   * prints `off` rather than a number.
   *
   * `post.ts` says it in as many words for two of these -- "0 = off" for
   * aberration, "0 removes the stage" for vignette -- and it is literally
   * true: `createPostChain` does not construct the pass at 0. FOV has no such
   * reading; a field of view of zero is not a disabled field of view, so FOV
   * never prints `off`.
   */
  zeroIsOff: boolean;
}

export interface TrackRow {
  label: string;
  /** Every track this row writes. The first is the one its diamonds read. */
  ids: readonly TrackId[];
  /** What a fresh keyframe on this row is worth when nothing supplies one. */
  fallback: number;
  /**
   * The 64px value cell's fixed contents, for a row that has no number.
   *
   * CAMERA POS is the only one: a camera pose is six tracks and cannot be
   * printed as a scalar, let alone typed into a 64px cell, so the frame gives
   * it the word `drag` instead of a readout and this row keeps it.
   */
  staticValue?: string;
  valueTitle: string;
  /** Present exactly when the row has a live number -- see `ValueScale`. */
  scale?: ValueScale;
  /**
   * Hatch this row over every span the camera is not FREE in.
   *
   * `Pc` marks CAMERA POS this way and says why in its own tooltip: a
   * keyframed pose has nothing to drive while the shot is on a camera that
   * follows the player, so keying one there would be an edit with no visible
   * effect until some later, unrelated cut happened to reach it.
   */
  hatchOutsideFree?: boolean;
}

/** What a value cell says when its track has nothing to say -- see `zeroIsOff`. */
export const VALUE_OFF = 'off';

/** The tooltip on every cell that IS a live readout. */
const VALUE_TITLE = 'Value at the playhead — click to type one';

/**
 * The tracks `Pc` draws, in its order.
 *
 * `CAMERA POS` is one row in the frame and SIX tracks in the model: x/y/z and
 * yaw/pitch/roll -- a cinematographer keyframes "the camera is HERE, looking
 * THERE", not six numbers -- so the row writes all six at once and shows a
 * diamond where any of them has a key.
 *
 * It owned three for a while, and that split is what phase H removed: a
 * button wrote six ids while the row owned three, so two gestures drew the
 * same diamond, one of which made the camera travel and turn while the other
 * only made it travel -- and removing "the row" left three angle tracks
 * keyed, invisible and unreachable, still bending the shot.
 *
 * `dof` is drawn even though `UNCONSUMED_TRACKS` says nothing reads it yet;
 * the frame lists it, and a row that silently vanished would read as a bug
 * rather than as an unbuilt pass.
 */
export const TRACK_ROWS: readonly TrackRow[] = [
  /*
   * The whole POSE, not just the position: x/y/z AND yaw/pitch/roll.
   *
   * They were split, with the lane owning three and a separate button
   * writing six, and the split had no meaning to anyone looking at it -- one
   * of them made the camera travel and the other made it travel while also
   * turning, and both drew the same diamond. Worse, removing "the row" left
   * the three angle tracks keyed, invisible and unreachable. A
   * cinematographer keyframes "the camera is HERE, looking THERE"; that is
   * one thing, so it is one row.
   */
  {
    label: 'CAMERA POS',
    ids: ['camX', 'camY', 'camZ', 'camYaw', 'camPitch', 'camRoll'],
    fallback: 0,
    staticValue: 'drag',
    valueTitle: 'Disabled outside FREE',
    hatchOutsideFree: true,
  },
  {
    label: 'FOV',
    ids: ['fov'],
    fallback: 100,
    valueTitle: VALUE_TITLE,
    scale: { unit: 'deg', min: 50, max: 140, zeroIsOff: false },
  },
  {
    label: 'VIGNETTE',
    ids: ['vignette'],
    fallback: 0,
    valueTitle: VALUE_TITLE,
    scale: { unit: 'percent', min: 0, max: 1, zeroIsOff: true },
  },
  {
    label: 'DOF',
    ids: ['dof'],
    fallback: 0,
    valueTitle: VALUE_TITLE,
    scale: { unit: 'percent', min: 0, max: 1, zeroIsOff: true },
  },
  {
    label: 'CHROMATIC AB.',
    ids: ['aberration'],
    fallback: 0.1,
    valueTitle: VALUE_TITLE,
    scale: { unit: 'scalar', min: 0, max: 1, zeroIsOff: true },
  },
];

/** The 64px cell's text for a value the track actually has. */
export function formatValue(scale: ValueScale, value: number): string {
  switch (scale.unit) {
    case 'deg':
      return `${Math.round(value)}°`;
    case 'percent':
      return `${Math.round(value * 100)}%`;
    default:
      return value.toFixed(2);
  }
}

/**
 * The same number without its unit, for the field a click opens.
 *
 * A user editing `35%` types `35`, not `0.35`: the cell said percent, so the
 * field has to mean percent or the two disagree about what the number is.
 * `parseValue` is the exact inverse.
 */
export function toInputText(scale: ValueScale, value: number): string {
  switch (scale.unit) {
    case 'deg':
      return String(Math.round(value));
    case 'percent':
      return String(Math.round(value * 100));
    default:
      return value.toFixed(2);
  }
}

/**
 * A typed string back to a track value, or null when it is not a number.
 *
 * Null rather than NaN, and the callers REVERT on it. A NaN written into a
 * track is not a bad value that shows up as a bad value: it propagates
 * through `evaluateTrack`'s interpolation, so one fat-fingered entry turns a
 * whole span of the shot into nothing, with the readout printing NaN in a
 * 64px cell as the only clue.
 *
 * The unit suffix is stripped rather than rejected, because a cell that
 * printed `92°` invites typing `95°` back into it.
 */
export function parseValue(scale: ValueScale, text: string): number | null {
  const cleaned = text.trim().replace(/[°%]|px/gi, '').trim();
  if (cleaned === '') {
    return null;
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    return null;
  }
  return scale.unit === 'percent' ? n / 100 : n;
}
