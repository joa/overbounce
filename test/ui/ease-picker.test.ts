/**
 * The easing picker writes to every track the selected diamond stands for.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * @vitest-environment happy-dom
 *
 * `track-list.ts`'s `retimeKey` states the rule: **whenever one mark stands
 * for several tracks, every operation on it has to name all of them.** The
 * picker was the last writer that did not. A selection carries one `TrackId`
 * because that is what a diamond is drawn from (`row.ids[0]`), and for FOV,
 * VIGNETTE, DOF and CHROMATIC AB. that is the whole row -- so the bug was
 * invisible on four rows out of five and total on the fifth.
 *
 * CAMERA POS is one mark over six tracks. Easing only `camX` gives a camera
 * that eases its travel in X and runs linear in Y, Z, yaw, pitch and roll:
 * the move arrives, but along a path nobody authored. The report it produced
 * was "easing functions are not properly implemented", and on the one row a
 * camera move is actually composed on, that was exactly true.
 *
 * These assertions are on the MODEL rather than on the button's classes,
 * because the defect was never visible in the picker -- it lit up EASE OUT
 * CUBIC correctly while writing it to a sixth of the shot.
 */

import { describe, it, expect } from 'vitest';
import { createEasePicker, emptyEaseState } from '../../src/ui/playback-chrome/ease-picker.js';
import { TRACK_ROWS } from '../../src/ui/playback-chrome/track-rows.js';
import { emptyTimeline, findTrack, setKeyframe } from '../../src/playback/timeline.js';
import type { Timeline, TrackId } from '../../src/playback/timeline.js';
import { DEFAULT_EASE, easeLabel } from '../../src/playback/easing.js';

const CAMERA_POS = TRACK_ROWS[0];

/** A timeline with one CAMERA POS key -- all six tracks, at one time. */
function cameraPosAt(time: number): Timeline {
  const timeline = emptyTimeline(10_000);
  for (const id of CAMERA_POS.ids) {
    setKeyframe(timeline, id, time, 0, { ...DEFAULT_EASE });
  }
  return timeline;
}

/** The picker, built into a detached host, plus the buttons by their label. */
function picker(timeline: Timeline) {
  const host = document.createElement('div');
  const state = emptyEaseState();
  createEasePicker(host, state, timeline, () => undoCount++);
  const press = (label: string): void => {
    const btn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.includes(label),
    );
    if (!btn) {
      throw new Error(`no ${label} button`);
    }
    btn.click();
  };
  return { state, press };
}

let undoCount = 0;

function easeOf(timeline: Timeline, id: TrackId, time: number) {
  return findTrack(timeline, id)?.keys.find((k) => k.time === time)?.ease;
}

describe('the easing picker and a multi-track row', () => {
  it('eases all six CAMERA POS tracks, not just camX', () => {
    const timeline = cameraPosAt(4000);
    const { state, press } = picker(timeline);

    // What clicking the diamond does: `track-list.ts` selects `row.ids[0]`.
    state.selection = { track: 'camX', time: 4000 };
    state.ease = { ...DEFAULT_EASE };

    press('OUT');
    press('CUBIC');

    for (const id of CAMERA_POS.ids) {
      const ease = easeOf(timeline, id, 4000);
      expect(easeLabel(ease!), `${id} did not get the curve`).toBe('Ease Out Cubic');
    }
  });

  it('gives each key its own Ease object', () => {
    // `Ease` is mutable and the picker hands one out six times. Sharing it
    // would make a later edit to any one key silently rewrite the other five,
    // which is the same class of bug wearing the opposite sign.
    const timeline = cameraPosAt(4000);
    const { state, press } = picker(timeline);
    state.selection = { track: 'camX', time: 4000 };
    press('IN');

    const first = easeOf(timeline, 'camX', 4000);
    const second = easeOf(timeline, 'camYaw', 4000);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('still writes a single-track row', () => {
    const timeline = emptyTimeline(10_000);
    setKeyframe(timeline, 'fov', 2000, 100, { ...DEFAULT_EASE });
    const { state, press } = picker(timeline);
    state.selection = { track: 'fov', time: 2000 };

    press('EASE');
    press('BOUNCE');

    expect(easeLabel(easeOf(timeline, 'fov', 2000)!)).toBe('Ease In Out Bounce');
  });

  it('costs one undo entry per press, and none with nothing selected', () => {
    const timeline = cameraPosAt(4000);
    undoCount = 0;
    const { state, press } = picker(timeline);

    // Disabled buttons raise no click, so drive the no-selection case by
    // selecting a time no key sits at -- the picker has to find nothing and
    // push nothing rather than push a snapshot for an edit it did not make.
    state.selection = { track: 'camX', time: 9000 };
    press('OUT');
    expect(undoCount).toBe(0);

    state.selection = { track: 'camX', time: 4000 };
    press('OUT');
    expect(undoCount).toBe(1);
  });
});
