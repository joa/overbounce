/**
 * The timeline, the easing curves and the export frame schedule.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * All headless, all pure functions of time -- which is the point of keeping
 * the timeline out of `src/ui/`.
 */

import { describe, it, expect } from 'vitest';
import {
  applyEase,
  DEFAULT_EASE,
  easeLabel,
  PICKER_FAMILIES,
  withDirection,
  withFamily,
} from '../../src/playback/easing.js';
import type { EaseFamily } from '../../src/playback/easing.js';
import {
  emptyTimeline,
  evaluateCamera,
  evaluateTimeline,
  evaluateTrack,
  findTrack,
  keyTimes,
  KEY_MIN_GAP,
  moveKeyframe,
  removeKeyframe,
  setCameraAt,
  setKeyframe,
  setValueAt,
  sortTimeline,
  timeScaleAt,
  ANGLE_TRACKS,
  UNCONSUMED_TRACKS,
} from '../../src/playback/timeline.js';
import type { Timeline } from '../../src/playback/timeline.js';
import { defaultExportConfig, frameTimes } from '../../src/playback/clip.js';

const ALL_FAMILIES: EaseFamily[] = ['quad', 'cubic', 'bounce', 'sine', 'expo', 'back'];

describe('easing', () => {
  it('pins both endpoints for every family and direction', () => {
    // A curve that does not reach 1 at t=1 leaves a keyframe never quite
    // arriving at its own value, which reads as a bug in the keyframe rather
    // than in the curve.
    for (const family of ALL_FAMILIES) {
      for (const direction of ['linear', 'in', 'out', 'ease'] as const) {
        const ease = { direction, family };
        expect(applyEase(ease, 0), `${direction} ${family} at 0`).toBeCloseTo(0, 6);
        expect(applyEase(ease, 1), `${direction} ${family} at 1`).toBeCloseTo(1, 6);
      }
    }
  });

  it('makes `out` the exact mirror of `in`', () => {
    // Deriving one from the other is what keeps them reading as one curve
    // rather than two that happen to share a name.
    for (const family of ALL_FAMILIES) {
      for (let t = 0; t <= 1.0001; t += 0.1) {
        const easeIn = applyEase({ direction: 'in', family }, t);
        const easeOut = applyEase({ direction: 'out', family }, 1 - t);
        expect(easeOut).toBeCloseTo(1 - easeIn, 6);
      }
    }
  });

  it('starts slow for `in` and fast for `out`', () => {
    for (const family of ['quad', 'cubic'] as const) {
      expect(applyEase({ direction: 'in', family }, 0.25)).toBeLessThan(0.25);
      expect(applyEase({ direction: 'out', family }, 0.25)).toBeGreaterThan(0.25);
    }
  });

  it('leaves linear alone whatever the family', () => {
    for (const family of ALL_FAMILIES) {
      expect(applyEase({ direction: 'linear', family }, 0.37)).toBe(0.37);
    }
  });

  it('clamps outside 0..1 rather than letting `back` overshoot wildly', () => {
    // `toBeCloseTo`, not `toBe`: the clamp is on the INPUT, so t=3 evaluates
    // the curve at 1, where `back`'s `c3 - c1` arithmetic lands a float ulp
    // short of exactly 1. Clamping the OUTPUT instead would be wrong -- back
    // legitimately exceeds 1 in the middle, which is the overshoot that makes
    // it the curve it is.
    expect(applyEase({ direction: 'in', family: 'back' }, 3)).toBeCloseTo(1, 9);
    expect(applyEase({ direction: 'in', family: 'back' }, -2)).toBe(0);
  });

  it('auto-pairs a family when a direction is chosen', () => {
    // `Pc`: "direction alone is meaningless, so picking OUT auto-pairs a
    // family".
    const paired = withDirection({ direction: 'linear', family: 'cubic' }, 'out');
    expect(paired).toEqual({ direction: 'out', family: 'cubic' });
    expect(easeLabel(paired)).toBe('Ease Out Cubic');
  });

  it('promotes linear to ease when a family is picked', () => {
    // Choosing BOUNCE while LINEAR would otherwise do nothing at all.
    expect(withFamily({ direction: 'linear', family: 'cubic' }, 'bounce')).toEqual({
      direction: 'ease',
      family: 'bounce',
    });
  });

  it('defaults a new keyframe to linear', () => {
    // Easing is something you reach for, not something that happens to you.
    expect(DEFAULT_EASE.direction).toBe('linear');
    expect(applyEase(DEFAULT_EASE, 0.5)).toBe(0.5);
  });

  it('offers exactly the three families the design draws', () => {
    expect([...PICKER_FAMILIES]).toEqual(['quad', 'cubic', 'bounce']);
  });
});

describe('tracks', () => {
  function withKeys(): Timeline {
    const timeline = emptyTimeline(10000);
    setKeyframe(timeline, 'fov', 1000, 90);
    setKeyframe(timeline, 'fov', 3000, 60);
    return timeline;
  }

  it('interpolates between keys', () => {
    const track = findTrack(withKeys(), 'fov')!;
    expect(evaluateTrack(track, 2000)).toBeCloseTo(75);
  });

  it('holds rather than extrapolates outside the keys', () => {
    // An extrapolated FOV runs to infinity, and "90 at 1s" says nothing about
    // 0s except 90.
    const track = findTrack(withKeys(), 'fov')!;
    expect(evaluateTrack(track, 0)).toBe(90);
    expect(evaluateTrack(track, 99999)).toBe(60);
  });

  it('says nothing at all when it has no keys or is disabled', () => {
    // Null and 0 are different instructions: "leave the live value alone"
    // versus "force it to zero".
    const timeline = emptyTimeline(1000);
    setKeyframe(timeline, 'vignette', 0, 0.4);
    const track = findTrack(timeline, 'vignette')!;
    track.enabled = false;
    expect(evaluateTrack(track, 0)).toBeNull();
    expect(evaluateTimeline(timeline, 0, 'fpv').values.vignette).toBeUndefined();
  });

  it('applies the ease of the key being LEFT', () => {
    const timeline = emptyTimeline(10000);
    setKeyframe(timeline, 'fov', 0, 0, { direction: 'in', family: 'cubic' });
    setKeyframe(timeline, 'fov', 1000, 100, { direction: 'linear', family: 'cubic' });
    const track = findTrack(timeline, 'fov')!;
    // Ease-in-cubic at the halfway point is 0.125, not 0.5.
    expect(evaluateTrack(track, 500)).toBeCloseTo(12.5);
  });

  it('replaces a keyframe at the same time rather than stacking one', () => {
    const timeline = emptyTimeline(1000);
    setKeyframe(timeline, 'fov', 500, 90);
    setKeyframe(timeline, 'fov', 500, 100);
    expect(findTrack(timeline, 'fov')!.keys).toHaveLength(1);
    expect(findTrack(timeline, 'fov')!.keys[0].value).toBe(100);
  });

  it('sorts keys after an edit moves one past its neighbour', () => {
    const timeline = emptyTimeline(10000);
    setKeyframe(timeline, 'fov', 1000, 90);
    setKeyframe(timeline, 'fov', 3000, 60);
    findTrack(timeline, 'fov')!.keys[0].time = 5000;
    sortTimeline(timeline);
    expect(findTrack(timeline, 'fov')!.keys.map((k) => k.time)).toEqual([3000, 5000]);
  });

  it('keeps DOF as a track even though nothing consumes it yet', () => {
    // Drawn in `Pc`; there is no depth-of-field pass in `render/post.ts`.
    // Evaluating it headlessly costs nothing and saves renegotiating the
    // track list the day the pass lands.
    expect([...UNCONSUMED_TRACKS]).toContain('dof');
    const timeline = emptyTimeline(1000);
    setKeyframe(timeline, 'dof', 0, 0.5);
    expect(evaluateTimeline(timeline, 0, 'fpv').values.dof).toBe(0.5);
  });
});

describe('angle tracks take the short way round', () => {
  /*
   * `PhotoCamera.look` accumulates yaw unbounded, so keys used to stay
   * numerically continuous and a plain lerp was right by accident.
   * `poseFromCamera` returns `atan2` in (-180, 180], which makes 350 and 10
   * two keys 20 degrees apart that a plain lerp sweeps 340 degrees between.
   */
  function yawKeys(from: number, to: number): Timeline {
    const timeline = emptyTimeline(10000);
    setKeyframe(timeline, 'camYaw', 0, from);
    setKeyframe(timeline, 'camYaw', 1000, to);
    return timeline;
  }

  it('crosses 0/360 the short way', () => {
    const track = findTrack(yawKeys(350, 10), 'camYaw')!;
    // The short path is 350 -> 360; the long one would pass through 180.
    expect(evaluateTrack(track, 500)).toBeCloseTo(360);
    expect(evaluateTrack(track, 250)).toBeCloseTo(355);
  });

  it('does not normalize the result', () => {
    // 360 rather than 0. `angleVectors` neither knows nor cares, and folding
    // it would only make the arithmetic harder to read in a debugger.
    const track = findTrack(yawKeys(350, 10), 'camYaw')!;
    expect(evaluateTrack(track, 500)).toBeGreaterThan(180);
  });

  it('is unchanged where the keys do not wrap', () => {
    const track = findTrack(yawKeys(10, 50), 'camYaw')!;
    expect(evaluateTrack(track, 500)).toBeCloseTo(30);
  });

  it('handles the 360-apart pair the free-cam seed can now produce', () => {
    // Fly to 370, key, cut away, cut back (the seed says 10), key again.
    // Those two keys describe no rotation at all, and used to spin the camera
    // through a full turn between them.
    const track = findTrack(yawKeys(370, 10), 'camYaw')!;
    expect(evaluateTrack(track, 500)).toBeCloseTo(370);
    expect(evaluateTrack(track, 999)).toBeCloseTo(370);
  });

  it('eases the FRACTION, not the wrapped result', () => {
    // Easing the result would ease a number that had already taken the long
    // way round: a smooth curve along the wrong arc, which reads as
    // deliberate and is worse than the linear failure.
    const timeline = emptyTimeline(10000);
    setKeyframe(timeline, 'camYaw', 0, 350, { direction: 'in', family: 'quad' });
    setKeyframe(timeline, 'camYaw', 1000, 10);
    const track = findTrack(timeline, 'camYaw')!;
    // ease-in quad at t=0.5 is 0.25 of the way: 350 + 0.25 * 20 = 355.
    expect(evaluateTrack(track, 500)).toBeCloseTo(355);
  });

  it('is an exact set, not a guess at what looks angular', () => {
    // `fov` is degrees too, and 350 -> 10 degrees of field of view is not a
    // short path -- it is a different lens. It must still lerp straight.
    const timeline = emptyTimeline(10000);
    setKeyframe(timeline, 'fov', 0, 350);
    setKeyframe(timeline, 'fov', 1000, 10);
    expect(evaluateTrack(findTrack(timeline, 'fov')!, 500)).toBeCloseTo(180);
    expect([...ANGLE_TRACKS].sort()).toEqual(['camPitch', 'camRoll', 'camYaw']);
  });
});

describe('setValueAt', () => {
  // What the value cell's typed entry and the lane's vertical drag both go
  // through. Everything here is a thing `setKeyframe` gets WRONG for that job
  // -- see the function's own header for why it is a separate entry point.

  it('creates a keyframe at the playhead when the track is empty', () => {
    const timeline = emptyTimeline(10000);
    expect(setValueAt(timeline, 'vignette', 4000, 0.35)).toBe(4000);
    expect(findTrack(timeline, 'vignette')!.keys).toEqual([
      { time: 4000, value: 0.35, ease: DEFAULT_EASE },
    ]);
  });

  it('updates the key already at the playhead rather than crowding it', () => {
    // The playhead is a float accumulated out of frame deltas, so "the key at
    // 4000" and "the playhead at 4000.3" are one moment to the user and two
    // times to `===`. `setKeyframe` would leave a pair 0.3ms apart, which is
    // exactly the state KEY_MIN_GAP exists to prevent.
    const timeline = emptyTimeline(10000);
    setKeyframe(timeline, 'fov', 4000, 100);
    expect(setValueAt(timeline, 'fov', 4000.3, 92)).toBe(4000);
    const keys = findTrack(timeline, 'fov')!.keys;
    expect(keys).toHaveLength(1);
    expect(keys[0].value).toBe(92);
  });

  it('leaves the easing of the key it updates alone', () => {
    // Adjusting a value is not re-choosing its curve. `setKeyframe` takes an
    // ease and assigns it, so routing a value edit through it would silently
    // flatten a key the user had deliberately made BOUNCE.
    const timeline = emptyTimeline(10000);
    const bounce = { direction: 'out', family: 'bounce' } as const;
    setKeyframe(timeline, 'fov', 1000, 100, bounce);
    setValueAt(timeline, 'fov', 1000, 70);
    expect(findTrack(timeline, 'fov')!.keys[0].ease).toEqual(bounce);
  });

  it('writes a second key once the playhead is further off than KEY_MIN_GAP', () => {
    const timeline = emptyTimeline(10000);
    setKeyframe(timeline, 'fov', 1000, 100);
    setValueAt(timeline, 'fov', 1000 + KEY_MIN_GAP + 1, 70);
    expect(findTrack(timeline, 'fov')!.keys.map((k) => k.time)).toEqual([
      1000,
      1000 + KEY_MIN_GAP + 1,
    ]);
  });

  it('keeps the keys sorted when the playhead is behind them all', () => {
    const timeline = emptyTimeline(10000);
    setKeyframe(timeline, 'fov', 5000, 100);
    setValueAt(timeline, 'fov', 1000, 70);
    expect(findTrack(timeline, 'fov')!.keys.map((k) => k.time)).toEqual([1000, 5000]);
  });
});

describe('camera segments', () => {
  it('falls back to the clip default when the timeline is empty', () => {
    // The no-timeline viewing path: a demo opens in FPV, a ghost in its own
    // recorded camera.
    const timeline = emptyTimeline(5000);
    expect(evaluateTimeline(timeline, 2500, 'fpv').camera).toBe('fpv');
    expect(evaluateTimeline(timeline, 2500, 'side').camera).toBe('side');
  });

  it('switches at each segment boundary and holds until the next', () => {
    const timeline = emptyTimeline(10000);
    timeline.cameras.push({ time: 2000, camera: 'free' }, { time: 6000, camera: 'chase' });
    expect(evaluateTimeline(timeline, 0, 'fpv').camera).toBe('fpv');
    expect(evaluateTimeline(timeline, 1999, 'fpv').camera).toBe('fpv');
    expect(evaluateTimeline(timeline, 2000, 'fpv').camera).toBe('free');
    expect(evaluateTimeline(timeline, 5999, 'fpv').camera).toBe('free');
    expect(evaluateTimeline(timeline, 9999, 'fpv').camera).toBe('chase');
  });
});

describe('setCameraAt', () => {
  it('writes a segment and keeps the list sorted', () => {
    const t = emptyTimeline(10_000);
    setCameraAt(t, 6000, 'chase');
    setCameraAt(t, 2000, 'free');
    expect(t.cameras.map((s) => [s.time, s.camera])).toEqual([
      [2000, 'free'],
      [6000, 'chase'],
    ]);
  });

  it('replaces the segment already at that time rather than stacking one', () => {
    const t = emptyTimeline(10_000);
    setCameraAt(t, 0, 'fpv');
    setCameraAt(t, 4000, 'chase');
    setCameraAt(t, 4000, 'side');
    expect(t.cameras).toHaveLength(2);
    expect(evaluateCamera(t, 5000, 'fpv')).toBe('side');
  });

  it('treats a time within KEY_EPSILON as the same segment', () => {
    // The time comes from a pointer on a ruler that may be minutes long; an
    // exact match is not something a hand can express.
    const t = emptyTimeline(10_000);
    setCameraAt(t, 4000, 'chase');
    setCameraAt(t, 4000.4, 'side');
    expect(t.cameras).toHaveLength(1);
    expect(t.cameras[0].camera).toBe('side');
  });

  it('merges a cut that changes nothing rather than drawing a boundary', () => {
    // Two abutting segments of the same mode would paint a boundary line in
    // `Pc`'s CAMERA MODE row across a moment where the camera does not cut.
    const t = emptyTimeline(10_000);
    setCameraAt(t, 0, 'free');
    setCameraAt(t, 5000, 'free');
    expect(t.cameras.map((s) => s.time)).toEqual([0]);
  });

  it('cascades the merge when collapsing one segment redundates the next', () => {
    // `[0 fpv, 3000 free, 6000 fpv]` with fpv written at 3000 is ONE long fpv
    // shot -- not `[0 fpv, 6000 fpv]`, which would still draw a boundary at
    // six seconds. This is why the merge is a scan and not a look at the
    // neighbours.
    const t = emptyTimeline(10_000);
    setCameraAt(t, 0, 'fpv');
    setCameraAt(t, 3000, 'free');
    setCameraAt(t, 6000, 'fpv');
    setCameraAt(t, 3000, 'fpv');
    expect(t.cameras.map((s) => [s.time, s.camera])).toEqual([[0, 'fpv']]);
  });

  it('keeps the same mode when it comes back after another one', () => {
    // Only ADJACENT duplicates merge: fpv, free, fpv is three real shots.
    const t = emptyTimeline(10_000);
    setCameraAt(t, 0, 'fpv');
    setCameraAt(t, 3000, 'free');
    setCameraAt(t, 6000, 'fpv');
    expect(t.cameras).toHaveLength(3);
    expect(evaluateCamera(t, 7000, 'side')).toBe('fpv');
  });
});

describe('time scale', () => {
  it('defaults to 1 with no track', () => {
    expect(timeScaleAt(emptyTimeline(1000), 0)).toBe(1);
  });

  it('never goes to zero or negative', () => {
    // Paused and reversed are transport states, not something a track imposes.
    const timeline = emptyTimeline(1000);
    setKeyframe(timeline, 'timeScale', 0, -3);
    expect(timeScaleAt(timeline, 0)).toBeGreaterThan(0);
  });
});

describe('export range', () => {
  it('scrubbing is not clamped to the in/out markers', () => {
    // `Pc`: in/out trim the EXPORT, "independent of playhead position".
    // Checking what comes after the out marker is a normal thing to do while
    // setting it.
    const timeline = emptyTimeline(10000);
    timeline.inPoint = 2000;
    timeline.outPoint = 4000;
    timeline.cameras.push({ time: 8000, camera: 'chase' });
    expect(evaluateTimeline(timeline, 9000, 'fpv').camera).toBe('chase');
  });

  it('schedules frames from fps alone, with no wall clock', () => {
    const config = { ...defaultExportConfig(1000), fps: 60, inPoint: 0, outPoint: 1000 };
    const times = frameTimes(config);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeCloseTo(1000 / 60);
    // 60, not 61. The range is half-open -- `[inPoint, outPoint)` -- so a
    // one-second clip at 60fps is sixty frames and the last one is at
    // 983.33ms, not a sixty-first sitting exactly on the out point. A closed
    // range would double the boundary frame of any two clips cut together.
    expect(times).toHaveLength(60);
    expect(times[times.length - 1]).toBeLessThan(1000);
  });

  it('honours the in and out markers', () => {
    const times = frameTimes({ ...defaultExportConfig(10000), fps: 30, inPoint: 2000, outPoint: 3000 });
    expect(times[0]).toBe(2000);
    expect(times[times.length - 1]).toBeLessThanOrEqual(3000);
    expect(times[times.length - 1]).toBeGreaterThan(2960);
  });

  it('truncates rather than stretching a range that does not divide evenly', () => {
    // A final short frame would play back at the wrong speed.
    const times = frameTimes({ ...defaultExportConfig(100), fps: 30, inPoint: 0, outPoint: 100 });
    for (const t of times) {
      expect(t).toBeLessThanOrEqual(100);
    }
  });

  it('produces nothing for an empty or inverted range', () => {
    expect(frameTimes({ ...defaultExportConfig(0), inPoint: 500, outPoint: 500 })).toEqual([]);
    expect(frameTimes({ ...defaultExportConfig(0), inPoint: 900, outPoint: 100 })).toEqual([]);
  });

  it('defaults to 1080p60 at 16 Mbps', () => {
    const config = defaultExportConfig(5000);
    expect([config.width, config.height, config.fps, config.bitrateMbps]).toEqual([
      1920, 1080, 60, 16,
    ]);
    expect(config.outPoint).toBe(5000);
  });
});

describe('a timeScale track stretches the export', () => {
  /*
   * A time scale is slow motion, so the OUTPUT gets longer. The playback loop
   * advances its clock by `dt * timeScaleAt`; an export that stepped
   * uniformly would render the same span at normal speed, and the shot on
   * screen and the shot in the file would be different shots.
   */
  function scaled(value: number): Timeline {
    const timeline = emptyTimeline(1000);
    setKeyframe(timeline, 'timeScale', 0, value);
    return timeline;
  }

  const config = { ...defaultExportConfig(1000), fps: 10, inPoint: 0, outPoint: 1000 };

  it('is unchanged when no track exists', () => {
    // The exact uniform form still runs for every clip nobody has keyframed,
    // including when a timeline is passed with other tracks on it.
    const plain = emptyTimeline(1000);
    setKeyframe(plain, 'fov', 0, 100);
    expect(frameTimes(config, plain)).toEqual(frameTimes(config));
  });

  it('doubles the frame count at half speed', () => {
    const times = frameTimes(config, scaled(0.5));
    expect(times).toHaveLength(20);
    // 50ms of clip per 100ms output frame.
    expect(times[1]).toBeCloseTo(50);
    expect(times[19]).toBeCloseTo(950);
  });

  it('halves it at double speed', () => {
    const times = frameTimes(config, scaled(2));
    expect(times).toHaveLength(5);
    expect(times[1]).toBeCloseTo(200);
  });

  it('follows a ramp between two keys', () => {
    // The step depends on where the walk currently IS, which is why there is
    // no closed form and the scaled path accumulates.
    const timeline = emptyTimeline(1000);
    setKeyframe(timeline, 'timeScale', 0, 1);
    setKeyframe(timeline, 'timeScale', 1000, 0.25);
    const times = frameTimes(config, timeline);
    // Early frames advance nearly a full interval, late ones a quarter of it.
    expect(times[1] - times[0]).toBeGreaterThan(90);
    expect(times.at(-1)! - times.at(-2)!).toBeLessThan(50);
    expect(times.length).toBeGreaterThan(10);
  });

  it('still yields a frame for a range shorter than one', () => {
    const short = { ...config, inPoint: 500, outPoint: 510 };
    expect(frameTimes(short, scaled(1))).toEqual([500]);
  });

  it('terminates on the smallest scale the model allows', () => {
    // `timeScaleAt` clamps positive at 0.01, so progress is guaranteed. The
    // cap is what that clamp implies and nothing a user can currently reach.
    const times = frameTimes(config, scaled(0.001));
    expect(times.length).toBeLessThanOrEqual(1000);
    expect(times.length).toBeGreaterThan(0);
  });
});

describe('removeKeyframe', () => {
  it('removes the key at a time and says whether there was one', () => {
    const t = emptyTimeline(10_000);
    setKeyframe(t, 'camX', 2000, 5);
    expect(removeKeyframe(t, 'camX', 2000)).toBe(true);
    expect(removeKeyframe(t, 'camX', 2000)).toBe(false);
  });

  it('drops a track once its last key is gone', () => {
    // "Does this track have an opinion" is the single question
    // `evaluateTrack` asks, and an empty track answers it wrongly: it would
    // still be found, still be enabled, and still return nothing.
    const t = emptyTimeline(10_000);
    setKeyframe(t, 'fov', 0, 90);
    removeKeyframe(t, 'fov', 0);
    expect(findTrack(t, 'fov')).toBeUndefined();
    expect(t.tracks).toHaveLength(0);
  });

  it('leaves the other keys on the track alone', () => {
    const t = emptyTimeline(10_000);
    setKeyframe(t, 'camX', 0, 1);
    setKeyframe(t, 'camX', 1000, 2);
    setKeyframe(t, 'camX', 2000, 3);
    removeKeyframe(t, 'camX', 1000);
    expect(findTrack(t, 'camX')?.keys.map((k) => k.value)).toEqual([1, 3]);
  });

  it('does not remove a key that is merely nearby', () => {
    // The UI hit-tests in PIXELS before it gets here, so this tolerance only
    // absorbs float noise -- it must not swallow a neighbouring key.
    const t = emptyTimeline(10_000);
    setKeyframe(t, 'camX', 1000, 1);
    expect(removeKeyframe(t, 'camX', 1200)).toBe(false);
    expect(findTrack(t, 'camX')?.keys).toHaveLength(1);
  });

  it('is a no-op on a track that was never created', () => {
    expect(removeKeyframe(emptyTimeline(10_000), 'vignette', 0)).toBe(false);
  });
});

describe('keyTimes', () => {
  it('is every distinct time any track is keyed at, in order', () => {
    // The ruler draws one diamond per entry, so a time keyed on three camera
    // tracks at once must appear ONCE -- three stacked diamonds would be
    // three things to click where the user sees one keyframe.
    const t = emptyTimeline(10_000);
    setKeyframe(t, 'camX', 2000, 1);
    setKeyframe(t, 'camY', 2000, 2);
    setKeyframe(t, 'camZ', 2000, 3);
    setKeyframe(t, 'fov', 500, 90);
    expect(keyTimes(t)).toEqual([500, 2000]);
  });

  it('is empty for a timeline with nothing on it', () => {
    expect(keyTimes(emptyTimeline(1000))).toEqual([]);
  });
});

describe('moveKeyframe', () => {
  it('retimes a key and reports where it landed', () => {
    const t = emptyTimeline(10_000);
    setKeyframe(t, 'camX', 2000, 5);
    expect(moveKeyframe(t, 'camX', 2000, 6000, 10_000)).toBe(6000);
    expect(findTrack(t, 'camX')?.keys[0]?.time).toBe(6000);
  });

  it('carries the value and the easing with it', () => {
    // Retiming is a move, not a re-key: dragging a BOUNCE key must not
    // quietly relinearise it or resample the camera pose.
    const t = emptyTimeline(10_000);
    setKeyframe(t, 'camX', 1000, 42, { direction: 'ease', family: 'bounce' });
    moveKeyframe(t, 'camX', 1000, 7000, 10_000);
    const key = findTrack(t, 'camX')?.keys[0];
    expect(key?.value).toBe(42);
    expect(key?.ease).toEqual({ direction: 'ease', family: 'bounce' });
  });

  it('stops short of the next key rather than passing it', () => {
    const t = emptyTimeline(10_000);
    setKeyframe(t, 'camX', 1000, 1);
    setKeyframe(t, 'camX', 5000, 2);
    expect(moveKeyframe(t, 'camX', 1000, 9000, 10_000)).toBe(5000 - KEY_MIN_GAP);
    // ...and the order is still the order, with the values still attached to
    // the keys they belong to.
    expect(findTrack(t, 'camX')?.keys.map((k) => k.value)).toEqual([1, 2]);
  });

  it('stops short of the previous key too', () => {
    const t = emptyTimeline(10_000);
    setKeyframe(t, 'camX', 1000, 1);
    setKeyframe(t, 'camX', 5000, 2);
    expect(moveKeyframe(t, 'camX', 5000, 0, 10_000)).toBe(1000 + KEY_MIN_GAP);
  });

  it('clamps to the clip rather than off either end', () => {
    const t = emptyTimeline(10_000);
    setKeyframe(t, 'camX', 5000, 1);
    expect(moveKeyframe(t, 'camX', 5000, -4000, 10_000)).toBe(0);
    expect(moveKeyframe(t, 'camX', 0, 99_000, 10_000)).toBe(10_000);
  });

  it('never leaves two keys at one time', () => {
    // The state everything downstream breaks on: two diamonds in one place,
    // an ambiguous click target, and a zero-length span to interpolate over.
    const t = emptyTimeline(10_000);
    setKeyframe(t, 'camX', 1000, 1);
    setKeyframe(t, 'camX', 2000, 2);
    setKeyframe(t, 'camX', 3000, 3);
    moveKeyframe(t, 'camX', 2000, 3000, 10_000);
    const times = findTrack(t, 'camX')?.keys.map((k) => k.time) ?? [];
    expect(new Set(times).size).toBe(times.length);
  });

  it('answers null for a key or a track that is not there', () => {
    const t = emptyTimeline(10_000);
    expect(moveKeyframe(t, 'camX', 0, 100, 10_000)).toBeNull();
    setKeyframe(t, 'camX', 1000, 1);
    expect(moveKeyframe(t, 'camX', 8000, 100, 10_000)).toBeNull();
  });
});
