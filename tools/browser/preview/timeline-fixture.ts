/**
 * Mount the playback timeline on its own, with nothing behind it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * WHY THIS EXISTS: the timeline is only reachable by opening a recording,
 * which needs a clip file, a mounted pak, a compiled BSP and a WebGPU
 * adapter. None of that has anything to do with whether a marker can be
 * dragged, and all of it stands between a pointer test and the thing being
 * tested. `createPlaybackChrome` takes a parent and a hooks object, so it
 * mounts against a stub in a blank page.
 *
 * Everything the driver needs to read is mirrored onto `data-*` attributes on
 * `<body>` rather than a `window` global, because a page global is not
 * visible from every kind of automation this repo drives browsers with --
 * `.agent/docs/playback-screens.md` records one that runs in an isolated
 * world and sees `window.__anything` as undefined. The DOM is the one surface
 * they all agree on.
 */

import { createPlaybackChrome } from '../../../src/ui/playback-chrome.js';
import type { PlaybackChromeHooks } from '../../../src/ui/playback-chrome.js';
import { emptyTimeline, keyTimes } from '../../../src/playback/timeline.js';
import type { ClipMeta } from '../../../src/playback/clip.js';

const DURATION = 20_000;

const meta: ClipMeta = {
  kind: 'ghost',
  name: 'drag fixture',
  map: 'ob_rockets',
  physics: 'vq3',
  durationMs: DURATION,
  defaultCamera: 'fpv',
  playerName: 'fixture',
  playerModel: 'sarge/default',
  runTimeMs: null,
};

const timeline = emptyTimeline(DURATION);

/**
 * A camera pose that MOVES with the playhead.
 *
 * A fixture that always answers the same numbers cannot tell a keyframe that
 * was written from one that was not, so the pose is a function of time.
 */
let playhead = 0;
const cameraPose = (): {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
} => ({
  x: playhead,
  y: playhead * 2,
  z: 64,
  yaw: playhead / 100,
  pitch: 0,
  roll: 0,
});

/** How many times each hook fired, so a driver can assert a click did nothing. */
const counts = new Map<string, number>();
const bump = (name: string): void => {
  counts.set(name, (counts.get(name) ?? 0) + 1);
};

const hooks: PlaybackChromeHooks = {
  setPlaying: () => bump('setPlaying'),
  seek: (timeMs: number) => {
    bump('seek');
    playhead = timeMs;
    // The session seeks and then repaints the transport; without that second
    // half the playhead would never move and `markHereKey` would never run,
    // so the fixture would be exercising half the loop.
    chrome.update(timeMs, false, 'free');
    publish();
  },
  setCamera: () => bump('setCamera'),
  cameraPose,
  restart: () => bump('restart'),
  openSettings: () => bump('openSettings'),
  backToTitle: () => bump('backToTitle'),
  exit: () => bump('exit'),
  startExport: () => bump('startExport'),
  cancelExport: () => bump('cancelExport'),
};

const chrome = createPlaybackChrome(document.body, {
  meta,
  duration: DURATION,
  timeline,
  hooks,
});

function publish(): void {
  const body = document.body.dataset;
  body.playhead = String(Math.round(playhead));
  body.in = String(Math.round(timeline.inPoint));
  body.out = String(Math.round(timeline.outPoint));
  body.keys = keyTimes(timeline)
    .map((t) => Math.round(t))
    .join(',');
  body.counts = [...counts].map(([k, n]) => `${k}=${n}`).join(',');
}

/*
 * Republish after every pointer event, in the BUBBLE phase.
 *
 * The real session repaints the transport once a frame, so its screen is
 * never more than a frame behind the timeline. A fixture that only published
 * from `seek` is behind by a whole GESTURE -- dragging the in marker mutates
 * `timeline.inPoint` and re-renders the ruler without ever seeking, so the
 * attributes still described the state before the drag and every assertion
 * read one gesture late. That produced four "failures" on a build where all
 * four gestures had in fact worked.
 *
 * `requestAnimationFrame` is not the answer here even though it is what the
 * session uses: an automated tab is `document.hidden`, so rAF may never tick
 * at all (`results-preview.ts` says the same thing about the results screen).
 * Pointer events always fire. Bubble phase, not capture, because the state
 * has to be read AFTER the chrome's own handler has updated it.
 *
 * `pointerdown` is deliberately NOT one of them. A bubble-phase listener on
 * `window` is starved by `stopPropagation`, and every handle in this panel
 * calls it on the press -- that is the whole of trap 16. `pointermove` and
 * `pointerup` are not stopped, and between them they carry every state this
 * fixture publishes.
 */
window.addEventListener('pointermove', publish);
window.addEventListener('pointerup', publish);
/*
 * ...and after a key too, for the same reason.
 *
 * Undo and redo are Ctrl+Z and Ctrl+Shift+Z, and a keyboard gesture produces
 * no pointer event at all -- so without this the attributes would describe
 * the timeline as it was BEFORE the undo, which is trap 17's "numbers that
 * are right but late" in its other clothes. `keyup`, not `keydown`: the panel
 * handles the press, so the state is only settled once it has.
 */
window.addEventListener('keyup', publish);

chrome.toggleTimeline();
/*
 * The camera has to be FREE at the playhead BEFORE the key is placed.
 *
 * `keyCamera` refuses outside a FREE span, by the same rule the CAMERA POS
 * lane's add uses, and with no segments on the timeline that span is whatever
 * camera the chrome last had reported to it. `toggleTimeline` asks for free
 * through `hooks.setCamera`, which is a stub here -- the chrome learns the
 * answer from `update`, so `update` has to come first. Keying before it left
 * the row unkeyed and the driver reporting "no lane keyframe to drag",
 * which is a fixture that is a gesture behind rather than a build that is
 * wrong.
 */
chrome.update(0, false, 'free');
// A second keyframe, four seconds in. `seedInitialKeys` gives every track one
// at zero when the panel opens, and a single pair is the smallest timeline on
// which retiming means anything.
chrome.keyCamera(4000);
// Back to the head, so the chrome's playhead and this file's agree again --
// `keyCamera` moves the chrome's to 4000 and nothing here would put it back.
chrome.update(0, false, 'free');
publish();
document.body.dataset.ready = '1';
