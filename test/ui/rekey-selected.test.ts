/**
 * Re-keying a selected keyframe edits it in place.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * @vitest-environment happy-dom
 *
 * The authoring loop for changing a camera key is: click its diamond (which
 * parks the playhead on it), fly, press K. `K` used to go through
 * `setKeyframe`, which matches a time EXACTLY and assigns `DEFAULT_EASE` -- so
 * re-posing a BOUNCE key silently made it linear, on all six tracks, and a
 * playhead a fraction of a millisecond off the key crowded a second key beside
 * it instead. Both are the failures `setValueAt`'s header lists; `writeRowKey`
 * now goes through it.
 *
 * Selection itself cannot be tested here: it is decided on the lane's
 * `pointerup` under pointer capture, which happy-dom does not implement.
 * `npm run timeline-drag` is where that is proved.
 */

import { describe, it, expect } from 'vitest';
import { createTrackList } from '../../src/ui/playback-chrome/track-list.js';
import type { CameraPose } from '../../src/ui/playback-chrome/track-list.js';
import { createHistory } from '../../src/ui/playback-chrome/history.js';
import { emptyEaseState } from '../../src/ui/playback-chrome/ease-picker.js';
import { TRACK_ROWS } from '../../src/ui/playback-chrome/track-rows.js';
import { emptyTimeline, findTrack, setKeyframe } from '../../src/playback/timeline.js';

const DURATION = 20_000;
const CAMERA_POS = TRACK_ROWS.find((row) => row.hatchOutsideFree)!;

function fixture(pose: CameraPose) {
  const timeline = emptyTimeline(DURATION);
  for (const id of CAMERA_POS.ids) {
    setKeyframe(timeline, id, 4000, 0, { direction: 'out', family: 'bounce' });
  }
  const state = emptyEaseState();
  const parked: [number, boolean][] = [];
  const list = createTrackList(document.createElement('div'), {
    timeline,
    duration: DURATION,
    history: createHistory(timeline, () => {}),
    selection: state,
    playhead: () => 0,
    park: (ms, pause) => parked.push([ms, pause]),
    cameraPose: () => pose,
    frac: (ms) => ms / DURATION,
    pct: (ms) => `${((ms / DURATION) * 100).toFixed(4)}%`,
    modeAt: () => 'free',
    hatchSpans: () => [],
    renderEase: () => {},
  });
  return { timeline, state, parked, list };
}

const FLOWN: CameraPose = { x: 111, y: 222, z: 333, yaw: 44, pitch: 5, roll: 6 };

describe('keyCameraAt on an existing camera key', () => {
  it('writes the new pose into the key and keeps its ease on all six tracks', () => {
    const { timeline, list } = fixture(FLOWN);
    list.keyCameraAt(4000);
    for (const id of CAMERA_POS.ids) {
      const keys = findTrack(timeline, id)!.keys;
      expect(keys, `${id} grew a second key`).toHaveLength(1);
      expect(keys[0].ease, `${id} was relinearised`).toEqual({
        direction: 'out',
        family: 'bounce',
      });
    }
    expect(findTrack(timeline, 'camX')!.keys[0].value).toBe(FLOWN.x);
    expect(findTrack(timeline, 'camRoll')!.keys[0].value).toBe(FLOWN.roll);
  });

  it('matches a playhead a fraction of a millisecond off the key', () => {
    // The playhead is a float accumulated from frame deltas.
    const { timeline, list } = fixture(FLOWN);
    list.keyCameraAt(4000.3);
    for (const id of CAMERA_POS.ids) {
      const keys = findTrack(timeline, id)!.keys;
      expect(keys).toHaveLength(1);
      expect(keys[0].time).toBe(4000);
    }
  });

  it('selects the key it touched with that key\'s ease, and seeks onto it without pausing', () => {
    // Not paused: `K` is tapped during playback to drop keys as the clip runs.
    const { state, parked, list } = fixture(FLOWN);
    list.keyCameraAt(4000.3);
    expect(state.selection).toEqual({ track: CAMERA_POS.ids[0], time: 4000 });
    expect(state.ease).toEqual({ direction: 'out', family: 'bounce' });
    expect(parked).toEqual([[4000, false]]);
  });

  it('still places a new, linear key where there is none', () => {
    const { timeline, list } = fixture(FLOWN);
    list.keyCameraAt(9000);
    for (const id of CAMERA_POS.ids) {
      const keys = findTrack(timeline, id)!.keys;
      expect(keys.map((k) => k.time)).toEqual([4000, 9000]);
      expect(keys[1].ease.direction).toBe('linear');
    }
  });
});
