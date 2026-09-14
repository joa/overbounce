/**
 * Opening the timeline panel must not pin the free camera.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * @vitest-environment happy-dom
 *
 * `seedInitialKeys` gives every track a key at 0:00 holding its current value,
 * so the first key a user places is the second of a pair and the shot moves
 * from the opening frame. That is right for a scalar and was quietly
 * catastrophic for CAMERA POS -- trap 23 in `.agent/docs/playback-screens.md`:
 *
 *  - the seed reads the LIVE pose, at whatever moment the panel was opened;
 *  - a track with one key holds it across the whole clip;
 *  - so on a clip that does not open in free cam, opening the panel wrote a
 *    camera key holding a pose nobody chose, and every later cut to FREE
 *    snapped the shot back to it.
 *
 * That is the "switching to free cam resets to spawn" report, and the reason
 * it survived a correct fix in `playback-session.ts`: the session seeded the
 * free camera from the live view and this track replaced it one frame later,
 * every frame.
 *
 * The rule the fix restores is not a special case. CAMERA POS is hatched
 * outside a FREE span because a key there has nothing to drive it, and the
 * lane's own double-press already refuses to place one. `seedInitialKeys` was
 * the one writer that did not -- it ran before the user was looking, which is
 * exactly why nobody saw it place the key.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTrackList } from '../../src/ui/playback-chrome/track-list.js';
import type { CameraPose } from '../../src/ui/playback-chrome/track-list.js';
import { createHistory } from '../../src/ui/playback-chrome/history.js';
import { emptyEaseState } from '../../src/ui/playback-chrome/ease-picker.js';
import { TRACK_ROWS } from '../../src/ui/playback-chrome/track-rows.js';
import { emptyTimeline, findTrack } from '../../src/playback/timeline.js';
import type { PlaybackCamera, Timeline } from '../../src/playback/timeline.js';

const DURATION = 20_000;

/** A pose that is obviously not the origin, so a stray seed is recognisable. */
const POSE: CameraPose = { x: 111, y: 222, z: 333, yaw: 44, pitch: 5, roll: 0 };

let timeline: Timeline;

beforeEach(() => {
  timeline = emptyTimeline(DURATION);
});

function seed(mode: PlaybackCamera): void {
  const host = document.createElement('div');
  const list = createTrackList(host, {
    timeline,
    duration: DURATION,
    history: createHistory(timeline, () => {}),
    selection: emptyEaseState(),
    playhead: () => 0,
    park: () => {},
    cameraPose: () => POSE,
    frac: (ms) => ms / DURATION,
    pct: (ms) => `${((ms / DURATION) * 100).toFixed(4)}%`,
    modeAt: () => mode,
    hatchSpans: () => (mode === 'free' ? [] : [{ from: 0, to: DURATION }]),
    renderEase: () => {},
  });
  list.seedInitialKeys();
}

/** Every row that is not CAMERA POS -- the scalars the seed is FOR. */
const SCALAR_ROWS = TRACK_ROWS.filter((row) => !row.hatchOutsideFree);
const CAMERA_POS = TRACK_ROWS.find((row) => row.hatchOutsideFree)!;

describe('seedInitialKeys', () => {
  it('does not key the camera when the clip does not open in free cam', () => {
    seed('side');
    for (const id of CAMERA_POS.ids) {
      expect(findTrack(timeline, id), `${id} was keyed in a hatched span`).toBeUndefined();
    }
  });

  it('still keys every scalar there', () => {
    // The seed's actual job. A camera row that is skipped must not take the
    // FOV, vignette, DOF and aberration keys down with it -- those are what
    // make the first key a user places the second of a pair.
    seed('side');
    for (const row of SCALAR_ROWS) {
      const track = findTrack(timeline, row.ids[0]);
      expect(track, `${row.label} lost its zero key`).toBeDefined();
      expect(track!.keys[0].time).toBe(0);
    }
  });

  it('keys the whole pose when the clip DOES open in free cam', () => {
    // The allowed case, and the one `npm run timeline-drag`'s fixture runs in.
    // All six, from the same pose -- one mark over six tracks, named in full.
    seed('free');
    for (const id of CAMERA_POS.ids) {
      const track = findTrack(timeline, id);
      expect(track, `${id} was not keyed`).toBeDefined();
      expect(track!.keys).toHaveLength(1);
      expect(track!.keys[0].time).toBe(0);
    }
    expect(findTrack(timeline, 'camX')!.keys[0].value).toBe(POSE.x);
    expect(findTrack(timeline, 'camYaw')!.keys[0].value).toBe(POSE.yaw);
  });

  it('leaves a camera key that already exists alone', () => {
    // Seeded once and only for a track with no keys: a later open must not
    // overwrite a zero key the user moved or retimed. Free at 0 both times,
    // so the skip is not what is doing the work here.
    seed('free');
    findTrack(timeline, 'camX')!.keys[0].value = -999;
    seed('free');
    expect(findTrack(timeline, 'camX')!.keys[0].value).toBe(-999);
  });
});
