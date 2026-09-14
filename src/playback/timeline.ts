/**
 * The playback timeline: camera segments, keyframed properties, cue points.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `design/Overbounce Playback.dc.html`'s `Pc`. Headless on purpose -- this is
 * a pure function of time and nothing in it knows about a THREE camera, a
 * post-processing pass or a DOM element. `evaluateTimeline` returns a
 * DESCRIPTION of the shot; applying it is the render layer's job, and keeping
 * that seam is what lets the whole thing be tested in Node the way physics is.
 *
 * ## Everything here is optional
 *
 * The default experience is watching a demo play in its proper camera. A clip
 * with an empty timeline evaluates to "use the clip's own default camera, no
 * overrides", which is exactly that. Cue points, tracks and trimming are
 * things a user reaches for when making a recording, and nothing about the
 * plain viewing path goes through them.
 *
 * ## The playhead and the export range are different things
 *
 * `Pc` puts in/out markers on the ruler and says they "trim the exported
 * range independent of playhead position". So `inPoint`/`outPoint` live on
 * the timeline and `evaluateTimeline` accepts times outside them without
 * complaint -- scrubbing past the out marker to check what comes next is a
 * normal thing to do while setting the marker. Only the export reads them
 * (`frameTimes` in `clip.ts`).
 */

import { applyEase, DEFAULT_EASE } from './easing.js';
import type { Ease } from './easing.js';
import { lerpAngle } from '../math/angles.js';
import type { CameraKey } from '../game/records.js';

/**
 * Which camera a segment of the timeline uses.
 *
 * `CameraKey`'s three (`fpv`/`chase`/`side`) plus `free`, which only exists
 * in playback: it is the flown camera the timeline keyframes, and it has no
 * meaning during a run because nobody is flying it then.
 */
export type PlaybackCamera = CameraKey | 'free';

/** Every scalar the timeline can animate. */
export type TrackId =
  | 'fov'
  | 'vignette'
  | 'exposure'
  | 'aberration'
  | 'dof'
  | 'focusDistance'
  | 'timeScale'
  | 'camX'
  | 'camY'
  | 'camZ'
  | 'camYaw'
  | 'camPitch'
  | 'camRoll';

/**
 * Tracks that are evaluated but that nothing consumes yet.
 *
 * `dof` and `focusDistance` are drawn in `Pc`'s track list, and
 * `src/ui/photo-mode.ts` explains why photo mode leaves them out: there is no
 * depth-of-field pass in `src/render/post.ts` at all. They are kept here
 * anyway because a headless track costs nothing to evaluate and the
 * alternative is renegotiating the track list with the UI the day the pass
 * lands. A consumer that finds a value here and has nowhere to put it should
 * ignore it, not warn.
 */
export const UNCONSUMED_TRACKS: readonly TrackId[] = ['dof', 'focusDistance'];

/**
 * The tracks that are DEGREES ON A CIRCLE, and therefore take the short way
 * round between two keys.
 *
 * An explicit set rather than a name test, because "looks angular" is not a
 * property a track has: `fov` is also degrees and is emphatically not
 * circular -- interpolating 350 to 10 degrees of field of view through 0 is
 * not a shorter path, it is a different lens.
 *
 * Why it matters, and why it got worse before it got better. Keys used to
 * arrive from `PhotoCamera.look`, which accumulates yaw UNBOUNDED: fly past
 * a full turn and the numbers keep climbing, so successive keys stayed
 * numerically continuous and a plain lerp between them was right by
 * accident. `poseFromCamera` -- the seed that hands the free camera the
 * shot -- returns `atan2`, which is `(-180, 180]`. So fly to yaw 370, key
 * it, cut away, cut back (the seed now says 10), fly a little and key again:
 * the two keys are 360 apart in the model with nothing on screen to say so,
 * and the camera spins through a full turn between them.
 *
 * `lerpAngle` is `q_math.c`'s `LerpAngle` and is what the rest of this
 * project already interpolates angles with -- `demo-clip.ts` for view angles
 * and entity angles, `ghost-clip.ts` for the same. This is the one place
 * that was doing it by hand.
 */
export const ANGLE_TRACKS: readonly TrackId[] = ['camYaw', 'camPitch', 'camRoll'];

export interface Keyframe {
  /** Clip time in ms. */
  time: number;
  value: number;
  /**
   * How the value LEAVES this keyframe, toward the next one.
   *
   * Per-keyframe rather than per-track because that is what a handle in an
   * editor means: you ease out of this key into that one, and the next
   * segment can be shaped differently. The last keyframe's ease is unused.
   */
  ease: Ease;
}

export interface Track {
  id: TrackId;
  /** Sorted ascending by time. `sortTimeline` guarantees it. */
  keys: Keyframe[];
  /** Off tracks evaluate to nothing, so a user can audition one without
   *  deleting its keys. */
  enabled: boolean;
}

/** A stretch of the timeline shot from one camera. */
export interface CameraSegment {
  /** Clip time in ms this segment starts at. Runs until the next one. */
  time: number;
  camera: PlaybackCamera;
}

/** A named mark on the ruler. */
export interface CuePoint {
  time: number;
  label: string;
}

export interface Timeline {
  /**
   * Camera segments, sorted. An EMPTY list means "the clip's own default
   * camera throughout", which is the no-timeline viewing path.
   */
  cameras: CameraSegment[];
  tracks: Track[];
  cues: CuePoint[];
  /** The export range. Not a playback restriction -- see the file header. */
  inPoint: number;
  outPoint: number;
}

/** A timeline with nothing on it: the default viewing experience. */
export function emptyTimeline(duration: number): Timeline {
  return { cameras: [], tracks: [], cues: [], inPoint: 0, outPoint: duration };
}

/**
 * Put everything in time order.
 *
 * Called after any edit rather than maintained by insertion, because an edit
 * can move a keyframe past its neighbours and every evaluator here assumes
 * sorted input. Sorting is stable, so two keys at the same time keep the
 * order they were added in -- which is the only sane answer to a genuinely
 * ambiguous case.
 */
export function sortTimeline(timeline: Timeline): void {
  timeline.cameras.sort((a, b) => a.time - b.time);
  timeline.cues.sort((a, b) => a.time - b.time);
  for (const track of timeline.tracks) {
    track.keys.sort((a, b) => a.time - b.time);
  }
}

/**
 * Remove the keyframe at `time` on `id`. Returns whether there was one.
 *
 * `KEY_EPSILON` of slop, because a keyframe is placed and removed by
 * pointing at a diamond a few pixels wide on a ruler that may be minutes
 * long -- an exact time match is not something a hand can express. A track
 * left with no keys is dropped rather than kept empty, so that "does this
 * track have an opinion" stays the single question `evaluateTrack` asks.
 */
export function removeKeyframe(timeline: Timeline, id: TrackId, time: number): boolean {
  const track = findTrack(timeline, id);
  if (!track) {
    return false;
  }
  const i = nearestKeyIndex(track, time);
  if (i < 0) {
    return false;
  }
  track.keys.splice(i, 1);
  if (track.keys.length === 0) {
    timeline.tracks.splice(timeline.tracks.indexOf(track), 1);
  }
  return true;
}

/** How close a time has to be to a keyframe to mean that keyframe, in ms. */
export const KEY_EPSILON = 1;

/**
 * The gap a dragged keyframe keeps from its neighbours, in milliseconds.
 *
 * Two keys at the SAME time is the state to avoid: the ruler would draw two
 * diamonds in one place, `removeKeyframe` could not say which of them a
 * click meant, and `evaluateTrack` would interpolate across a zero-length
 * span. So a drag stops just short of the next key rather than passing it.
 */
export const KEY_MIN_GAP = 8;

/**
 * Move the keyframe at `from` to `to`, clamped so it stays between its
 * neighbours. Returns the time it actually ended up at, or null if there was
 * no key to move.
 *
 * Clamped rather than allowed to pass, which is a real choice and not
 * timidity: a key that crosses its neighbour has to either swap values with
 * it or merge, and both are edits the user did not ask for while dragging.
 * Stopping at the neighbour is the one outcome that is always what it looks
 * like -- and the key is still removable and re-placeable if the order was
 * the mistake.
 */
export function moveKeyframe(
  timeline: Timeline,
  id: TrackId,
  from: number,
  to: number,
  duration: number,
): number | null {
  const track = findTrack(timeline, id);
  if (!track) {
    return null;
  }
  const i = nearestKeyIndex(track, from);
  if (i < 0) {
    return null;
  }
  const before = track.keys[i - 1];
  const after = track.keys[i + 1];
  const lo = before ? before.time + KEY_MIN_GAP : 0;
  const hi = after ? after.time - KEY_MIN_GAP : duration;
  // A track so crowded that there is no room left leaves the key where it is
  // rather than pushing it past a neighbour.
  const at = hi < lo ? track.keys[i]!.time : Math.min(hi, Math.max(lo, to));
  track.keys[i]!.time = at;
  track.keys.sort((a, b) => a.time - b.time);
  return at;
}

function nearestKeyIndex(track: Track, time: number): number {
  let best = -1;
  let bestGap = KEY_EPSILON;
  track.keys.forEach((k, i) => {
    const gap = Math.abs(k.time - time);
    if (gap <= bestGap) {
      bestGap = gap;
      best = i;
    }
  });
  return best;
}

/**
 * Every distinct time any track has a keyframe at, in order.
 *
 * This is what the RULER draws. A keyframe is one concept shown in two
 * places -- a diamond on the ruler saying "something is keyed here", and a
 * diamond on a lane saying which track -- rather than two separate kinds of
 * mark that a reader has to tell apart.
 */
export function keyTimes(timeline: Timeline): number[] {
  const seen = new Set<number>();
  for (const track of timeline.tracks) {
    for (const key of track.keys) {
      seen.add(key.time);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/** The track with this id, or undefined. */
export function findTrack(timeline: Timeline, id: TrackId): Track | undefined {
  return timeline.tracks.find((t) => t.id === id);
}

/** Add or replace a keyframe at `time` on `id`, creating the track if needed. */
export function setKeyframe(
  timeline: Timeline,
  id: TrackId,
  time: number,
  value: number,
  ease: Ease = DEFAULT_EASE,
): void {
  let track = findTrack(timeline, id);
  if (!track) {
    track = { id, keys: [], enabled: true };
    timeline.tracks.push(track);
  }
  const existing = track.keys.find((k) => k.time === time);
  if (existing) {
    existing.value = value;
    existing.ease = ease;
    return;
  }
  track.keys.push({ time, value, ease });
  track.keys.sort((a, b) => a.time - b.time);
}

/**
 * Set `id`'s value AT THE PLAYHEAD, updating the keyframe already there rather
 * than crowding a second one beside it. Returns the time actually written.
 *
 * This is what the value cell's typed entry and the lane's vertical drag both
 * go through, and it is deliberately not `setKeyframe`. Two things make that
 * one wrong for this job:
 *
 *  - **`setKeyframe` matches a time EXACTLY.** The playhead is a float that
 *    accumulates out of frame deltas, so a key placed at 4000 and a playhead
 *    sitting at 4000.3 are the same moment to everything a user can see and
 *    two different keys to `===`. The result is a pair 0.3ms apart, which is
 *    precisely the state `KEY_MIN_GAP` exists to prevent -- two diamonds in
 *    one place, a removal that cannot say which was meant, and an
 *    interpolation across a zero-length span.
 *  - **`setKeyframe` overwrites the ease.** Adjusting a value is not
 *    re-choosing its curve, and passing `DEFAULT_EASE` through here would
 *    silently flatten a key the user had deliberately made BOUNCE.
 *
 * `KEY_MIN_GAP` rather than `KEY_EPSILON` is the window, and the difference
 * is what the two numbers are about: `KEY_EPSILON` is how precisely a HAND
 * can point at a diamond, and this is how precisely a CLOCK lands on one. Two
 * keys closer together than `KEY_MIN_GAP` is a state no other operation here
 * will produce, so treating anything inside it as "the key at the playhead"
 * cannot pick the wrong one.
 */
export function setValueAt(
  timeline: Timeline,
  id: TrackId,
  time: number,
  value: number,
): number {
  let track = findTrack(timeline, id);
  if (!track) {
    track = { id, keys: [], enabled: true };
    timeline.tracks.push(track);
  }
  let nearest: Keyframe | null = null;
  let bestGap = KEY_MIN_GAP;
  for (const key of track.keys) {
    const gap = Math.abs(key.time - time);
    if (gap <= bestGap) {
      bestGap = gap;
      nearest = key;
    }
  }
  if (nearest) {
    nearest.value = value;
    return nearest.time;
  }
  track.keys.push({ time, value, ease: { ...DEFAULT_EASE } });
  track.keys.sort((a, b) => a.time - b.time);
  return time;
}

/**
 * A track's value at `time`, or null when the track says nothing there.
 *
 * Null rather than a default, because "this track has no opinion" and "this
 * track wants 0" are different instructions to the renderer: the first means
 * leave the live value alone, the second means force it to zero. Collapsing
 * them would make an empty vignette track silently turn the vignette off.
 *
 * Before the first key and after the last, the value HOLDS at that key rather
 * than extrapolating. An extrapolated FOV runs to infinity, and there is no
 * reading of "the user keyframed 90 at 2s" that implies anything about 0s
 * except 90.
 */
export function evaluateTrack(track: Track, time: number): number | null {
  if (!track.enabled || track.keys.length === 0) {
    return null;
  }
  const keys = track.keys;
  if (time <= keys[0].time) {
    return keys[0].value;
  }
  const last = keys[keys.length - 1];
  if (time >= last.time) {
    return last.value;
  }
  // Linear scan: a track holds a handful of keys, not thousands, and a scan
  // over five is faster than a binary search over five.
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      if (span <= 0) {
        return b.value;
      }
      // The ease belongs to the key being LEFT -- see `Keyframe.ease`.
      const t = applyEase(a.ease, (time - a.time) / span);
      /*
       * The ease shapes the FRACTION and the wrap decides the PATH, in that
       * order. Easing the result instead would ease a number that had
       * already taken the long way round -- a smooth curve along the wrong
       * arc, which is a worse failure than the linear one because it looks
       * deliberate.
       *
       * The result is NOT normalized back into a range. `lerpAngle` from 350
       * to 10 passes through 360, and `angleVectors` neither knows nor cares;
       * folding it to 0 here would buy nothing and cost the one thing that
       * makes the arithmetic readable in a debugger.
       */
      if (ANGLE_TRACKS.includes(track.id)) {
        return lerpAngle(a.value, b.value, t);
      }
      return a.value + t * (b.value - a.value);
    }
  }
  return last.value;
}

/**
 * Cut to `camera` at `time`, and merge the cut away again if it changes
 * nothing.
 *
 * `Pc`'s CAMERA MODE row draws one segment per entry with a boundary line
 * where the mode changes, so two abutting segments of the SAME mode would
 * paint a boundary across a shot that does not cut -- a line saying "the
 * camera changes here" over a moment where it does not. That is the whole
 * reason this is a function rather than a `push`: every writer of a segment
 * has to leave the list in the state the row can be drawn from, and there is
 * more than one writer (the transport's camera pills, and flying the free
 * camera in `playback-session.ts`).
 *
 * The merge is a full sequential scan rather than a look at the neighbours,
 * because collapsing one segment can make the NEXT one redundant too:
 * `[0 fpv, 3000 free, 6000 fpv]` with fpv written at 3000 is one long fpv
 * shot, not `[0 fpv, 6000 fpv]`.
 *
 * `KEY_EPSILON` of slop on "a segment is already here", for the same reason
 * `removeKeyframe` has it: the time comes from a pointer on a ruler that may
 * be minutes long, and an exact match is not something a hand can express.
 */
export function setCameraAt(timeline: Timeline, time: number, camera: PlaybackCamera): void {
  const existing = timeline.cameras.find((s) => Math.abs(s.time - time) <= KEY_EPSILON);
  if (existing) {
    existing.camera = camera;
  } else {
    timeline.cameras.push({ time, camera });
    timeline.cameras.sort((a, b) => a.time - b.time);
  }
  const merged: CameraSegment[] = [];
  let previous: PlaybackCamera | null = null;
  for (const segment of timeline.cameras) {
    if (segment.camera === previous) {
      continue;
    }
    previous = segment.camera;
    merged.push(segment);
  }
  // In place, because callers hold the `Timeline` and not the array.
  timeline.cameras.splice(0, timeline.cameras.length, ...merged);
}

/** Which camera is active at `time`. */
export function evaluateCamera(
  timeline: Timeline,
  time: number,
  fallback: PlaybackCamera,
): PlaybackCamera {
  let current = fallback;
  for (const segment of timeline.cameras) {
    if (segment.time > time) {
      break;
    }
    current = segment.camera;
  }
  return current;
}

/** What the render layer should do at one instant. */
export interface TimelineState {
  camera: PlaybackCamera;
  /**
   * Every track that had an opinion, by id. A track with no keys, or a
   * disabled one, is absent rather than present-and-null -- see
   * `evaluateTrack`.
   */
  values: Partial<Record<TrackId, number>>;
  /** The cue point at or immediately before `time`, for a UI readout. */
  cue: CuePoint | null;
}

/**
 * The whole timeline at one instant.
 *
 * `fallback` is the clip's own `meta.defaultCamera`, which is what an empty
 * timeline resolves to: fixed FPV for a `.dm_68`, the ghost's own recorded
 * view for a ghost.
 */
export function evaluateTimeline(
  timeline: Timeline,
  time: number,
  fallback: PlaybackCamera,
): TimelineState {
  const values: Partial<Record<TrackId, number>> = {};
  for (const track of timeline.tracks) {
    const value = evaluateTrack(track, time);
    if (value !== null) {
      values[track.id] = value;
    }
  }

  let cue: CuePoint | null = null;
  for (const c of timeline.cues) {
    if (c.time > time) {
      break;
    }
    cue = c;
  }

  return { camera: evaluateCamera(timeline, time, fallback), values, cue };
}

/**
 * `timeScale` as a multiplier, defaulting to 1.
 *
 * Its own accessor because it is the one track that changes how the CLOCK
 * advances rather than how a frame looks, so the playback loop reads it
 * before advancing while everything else is read after. A slow-motion track
 * that were applied like a look setting would do nothing at all.
 *
 * Clamped positive: a zero or negative time scale is a paused or reversed
 * clip, both of which are states the transport owns rather than things a
 * track should be able to impose.
 */
export function timeScaleAt(timeline: Timeline, time: number): number {
  const track = findTrack(timeline, 'timeScale');
  if (!track) {
    return 1;
  }
  const value = evaluateTrack(track, time);
  return value === null ? 1 : Math.max(0.01, value);
}
