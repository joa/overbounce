/**
 * The playback screen's chrome: transport, timeline, pause menu, export.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Frames `Pb`, `Pc`, `Pd`, `Pe` and `Pf` of `design/Overbounce Playback.dc.html`.
 * Measurements come from those frames' inline styles, not from
 * `design/HANDOFF.md`'s prose -- the same rule `shell.ts` records, and it
 * matters more here because this screen has four bespoke controls (the
 * ruler, the track rows, the easing picker, the scrubber) that no other
 * screen shares.
 *
 * ## This is DOM over the canvas, and it mounts on `document.body`
 *
 * Not `#overlay`, which `main.ts` sets `pointer-events: none` on so gameplay
 * clicks reach the canvas for pointer lock. Every control here is
 * interactive, so it follows the rule `pak-ui.ts` and `shell.ts` already
 * state: anything you click mounts on the body.
 *
 * ## The default experience is `Pb`, and that is a design constraint
 *
 * The timeline is OPT-IN (`T`). A player who opens a demo sees the run in its
 * proper camera with a play button and a scrubber, and nothing else -- per
 * the owner's brief ("the default experience is to just see it in the proper
 * camera mode"). Everything below `showTimeline()` is the other mode, and it
 * is deliberately the one you have to ask for.
 *
 * ## What this file does NOT decide
 *
 * It edits a `Timeline` and reports transport intent. It never advances the
 * clock, never touches a camera object and never renders: `playback-session.ts`
 * owns all three and calls `update()` once a frame with what actually
 * happened. That split is what lets the timeline model stay headless and
 * tested (`test/playback/timeline.test.ts`) while this file stays untested
 * DOM -- the same division `hud.ts` has with the simulation.
 *
 * ## Where the rest of it lives
 *
 * What remains here is the SHELL: the markup, the transport, the ruler, and
 * the wiring that lets the pieces below talk to each other. The pieces are in
 * `playback-chrome/`, and `.agent/plans/PLAYBACK-CHROME-SPLIT.md` records the
 * seams they were cut along.
 *
 * | file | what |
 * | --- | --- |
 * | `styles.ts` | the whole stylesheet. Read its header before editing it |
 * | `format.ts` | `formatClock`, re-exported below, and `formatSpan` |
 * | `track-rows.ts` | what the five rows are, and their units |
 * | `gestures.ts` | `createDraggable` and `onDoublePress` |
 * | `history.ts` | the snapshot undo stack |
 * | `ease-picker.ts` | the easing picker and the selection it edits |
 * | `camera-modes.ts` | the CAMERA MODE row and the segment maths |
 * | `track-list.ts` | the five property rows and every gesture on them |
 * | `modals.ts`, `export-dialog.ts` | `Pd`, `Pe`, `Pf` |
 */

import './tokens.css';
import type { Timeline, PlaybackCamera } from '../playback/timeline.js';
import { setCameraAt, findTrack } from '../playback/timeline.js';
import { DEFAULT_EASE } from '../playback/easing.js';
import type { ClipMeta, ExportConfig } from '../playback/clip.js';
import { installStyle } from './playback-chrome/styles.js';
import { formatClock, formatSpan } from './playback-chrome/format.js';
import { createDraggable } from './playback-chrome/gestures.js';
import { createHistory } from './playback-chrome/history.js';
import { createEasePicker, emptyEaseState } from './playback-chrome/ease-picker.js';
import { createModeRow } from './playback-chrome/camera-modes.js';
import { createTrackList } from './playback-chrome/track-list.js';
import { createModalStack } from './playback-chrome/modals.js';

export { formatClock };

export interface PlaybackChromeHooks {
  /** Transport. The session owns the clock; this only asks. */
  setPlaying(playing: boolean): void;
  seek(timeMs: number): void;
  /** A manual camera pick from the timeline bar. */
  setCamera(camera: PlaybackCamera): void;
  /** The free camera's pose right now, for a CAMERA POS keyframe. */
  cameraPose(): { x: number; y: number; z: number; yaw: number; pitch: number; roll: number };
  restart(): void;
  openSettings(): void;
  backToTitle(): void;
  /** The ✕, and Escape's "leave" answer: back to the library. */
  exit(): void;
  startExport(config: ExportConfig): void;
  cancelExport(): void;
}

export interface PlaybackChrome {
  /** The timeline being edited. Mutated in place by this file's controls. */
  readonly timeline: Timeline;
  readonly timelineOpen: boolean;
  readonly pauseOpen: boolean;
  /** True while any modal owns the keyboard -- pause, export or progress. */
  modalOpen(): boolean;
  /**
   * Close the topmost dismissable modal, and say whether there was one.
   *
   * Escape's answer depends on what is on screen, so the decision lives in
   * `modals.ts` rather than in the session's key handler: only it knows which
   * dialogs exist and which of them Escape may close. A render in progress
   * (`Pf`) is deliberately NOT dismissable -- stopping it is Cancel, which
   * has to abort the encoder rather than just hide the dialog.
   */
  dismissModal(): boolean;
  /**
   * Keyframe the free camera at the playhead: position and angles.
   *
   * A key already within `KEY_MIN_GAP` of the playhead is re-posed in place
   * and keeps its ease. Either way the key is then selected and the playhead
   * sought onto it (without pausing) -- so after a click on a diamond, `K` is
   * how its pose is changed.
   *
   * NOT fov -- `Pc` gives FOV a row and a value readout of its own, so
   * keying it with the pose would put a key on a track the user did not
   * touch. The doc said "and fov" for a while and no code ever did it.
   *
   * Exposed because the session owns the `K` key. It does NOT own the rule
   * about when a camera key is allowed: this refuses outside a FREE span, the
   * same way a double-press on the CAMERA POS lane does, so the hatch rule is
   * stated once. See the implementation for why refusing beats cutting.
   */
  keyCamera(timeMs: number): void;
  /**
   * Snapshot the timeline for undo, for an edit made OUTSIDE this file.
   *
   * There is exactly one: `playback-session.ts` writes a camera segment when
   * the viewer takes hold of the camera by hand (`beginFlying`). A cut is a
   * cut however it was made, and one that could not be undone would be the
   * only edit on this screen that could not.
   */
  pushUndo(): void;
  toggleTimeline(): void;
  openPause(): void;
  closePause(): void;
  /** Once a frame: repaint the transport against what actually happened. */
  update(timeMs: number, playing: boolean, camera: PlaybackCamera): void;
  /**
   * `Pf`. `total` of 0 closes it.
   *
   * `label` is the settings line under the title ("1080P · 60 FPS · 16 Mbps")
   * and is only read when the dialog is first opened -- the settings cannot
   * change mid-render, so repeating it every frame would be noise.
   */
  setExportProgress(done: number, total: number, etaMs: number, label?: string): void;
  exportFinished(message: string): void;
  dispose(): void;
}

export interface PlaybackChromeOptions {
  meta: ClipMeta;
  duration: number;
  timeline: Timeline;
  hooks: PlaybackChromeHooks;
}

/** The four camera pills in the timeline bar, in `Pc`'s order. */
const CAMERAS: readonly { id: PlaybackCamera; label: string }[] = [
  { id: 'free', label: 'FREE' },
  { id: 'fpv', label: 'FPV' },
  { id: 'chase', label: 'CHASE' },
  { id: 'side', label: 'SIDE' },
];

/**
 * The closest the in and out markers may be pushed together.
 *
 * They are dragged independently of the playhead, and clamped past each other
 * so an inverted range cannot be expressed -- `frameTimes` returns nothing for
 * one, which would be an export that silently produced no video.
 */
const MIN_RANGE = 100;

export function createPlaybackChrome(
  parent: HTMLElement,
  options: PlaybackChromeOptions,
): PlaybackChrome {
  installStyle();
  const { meta, duration, timeline, hooks } = options;

  const root = document.createElement('div');
  root.className = 'ob-pb';
  root.innerHTML = `
    <div class="ob-pb-view">
      <div class="ob-pb-top">
        <div class="ob-pb-ident">
          <div class="ob-pb-name" data-name></div>
          <span class="ob-pb-badge" data-map></span>
          <span class="ob-pb-badge" data-phys></span>
          <span class="ob-pb-badge cam" data-cam></span>
        </div>
        <div class="ob-pb-top-actions">
          <div class="ob-pb-history" data-history hidden>
            <button type="button" data-undo title="Undo (Ctrl+Z)" aria-label="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-1"/></svg></button>
            <button type="button" data-redo title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h1"/></svg></button>
          </div>
          <button type="button" class="ob-pb-chip" data-toggle>Show timeline</button>
          <button type="button" class="ob-pb-chip accent" data-export hidden>Export video</button>
          <button type="button" class="ob-pb-x" data-close aria-label="Close playback">✕</button>
        </div>
      </div>
      <div class="ob-pb-float" data-float>
        <div class="ob-pb-row">
          <button type="button" class="ob-pb-play" data-play aria-label="Play or pause"><span></span><span></span></button>
          <div class="ob-pb-scrub" data-scrub><div class="fill"></div><div class="knob"></div></div>
          <div class="ob-pb-time" data-time></div>
        </div>
        <div class="ob-pb-hint">SPACE PLAY/PAUSE · T TIMELINE · K KEYFRAME · ESC MENU · MOVE KEYS + E/Q FREE CAM</div>
      </div>
    </div>
    <div class="ob-pb-panel" data-panel hidden>
      <div class="ob-pb-bar">
        <button type="button" class="ob-pb-play" data-play2 aria-label="Play or pause"><span></span><span></span></button>
        <div class="ob-pb-time" data-time2></div>
        <div class="ob-pb-sep"></div>
        <div class="ob-pb-label">CAMERA</div>
        <div class="ob-pb-seg tight" data-cams></div>
        <div class="ob-pb-spacer"></div>
        <div class="ob-pb-label">EASING</div>
        <div class="ob-pb-ease" data-ease></div>
      </div>
      <div class="ob-pb-scroll ob-pb-ruler-wrap" data-ruler-scroll>
        <div class="ob-pb-ruler-grid">
          <div class="ob-pb-ruler-zero">00:00.0</div>
          <div class="ob-pb-ruler" data-ruler>
            <div class="ob-pb-range" data-range></div>
            <div class="ob-pb-marker" data-in><div class="grip"></div><div class="stem"></div></div>
            <div class="ob-pb-marker" data-out><div class="grip"></div><div class="stem"></div></div>
            <div class="ob-pb-head" data-head></div>
          </div>
          <div class="ob-pb-ruler-end" data-duration></div>
        </div>
        <div class="ob-pb-ruler-legend">
          <span>IN <b data-in-label></b></span>
          <span data-range-label></span>
          <span>OUT <b data-out-label></b></span>
        </div>
      </div>
      <div class="ob-pb-tracks ob-pb-scroll" data-tracks></div>
    </div>`;
  parent.appendChild(root);

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const elName = q('[data-name]');
  const elMap = q('[data-map]');
  const elPhys = q('[data-phys]');
  const elCam = q('[data-cam]');
  const elToggle = q<HTMLButtonElement>('[data-toggle]');
  const elHistory = q('[data-history]');
  const elUndo = q<HTMLButtonElement>('[data-undo]');
  const elRedo = q<HTMLButtonElement>('[data-redo]');
  const elExport = q<HTMLButtonElement>('[data-export]');
  const elClose = q<HTMLButtonElement>('[data-close]');
  const elFloat = q('[data-float]');
  const elPlay = q<HTMLButtonElement>('[data-play]');
  const elPlay2 = q<HTMLButtonElement>('[data-play2]');
  const elScrub = q('[data-scrub]');
  const elScrubFill = q('.ob-pb-scrub .fill');
  const elScrubKnob = q('.ob-pb-scrub .knob');
  const elTime = q('[data-time]');
  const elTime2 = q('[data-time2]');
  const elPanel = q('[data-panel]');
  const elCams = q('[data-cams]');
  const elEase = q('[data-ease]');
  const elRulerScroll = q('[data-ruler-scroll]');
  const elRuler = q('[data-ruler]');
  const elDuration = q('[data-duration]');
  const elRange = q('[data-range]');
  const elIn = q('[data-in]');
  const elOut = q('[data-out]');
  const elHead = q('[data-head]');
  const elInLabel = q('[data-in-label]');
  const elOutLabel = q('[data-out-label]');
  const elRangeLabel = q('[data-range-label]');
  const elTracks = q('[data-tracks]');

  elName.textContent = meta.name;
  elMap.textContent = meta.map || '—';
  elPhys.textContent = meta.physics.toUpperCase();
  elDuration.textContent = formatClock(duration);

  /*
   * One scroll position for two scrollers.
   *
   * The ruler and the track list are separate `overflow-x` boxes because they
   * are separate stacking contexts with their own padding, but they are two
   * halves of ONE grid: a ruler scrolled away from the lanes it measures is
   * worse than a ruler that does not scroll at all. Mirrored rather than
   * driven from a single container because the assignment is cheap and the
   * alternative -- one scroller wrapping both -- would take the ruler out of
   * the panel's flow and let it scroll vertically with the rows.
   *
   * The equality test is what stops the echo: assigning an equal scrollLeft
   * fires no scroll event, so the two never bounce a rounding error back and
   * forth at each other.
   */
  const mirrorScroll = (from: HTMLElement, to: HTMLElement): void => {
    from.addEventListener('scroll', () => {
      if (to.scrollLeft !== from.scrollLeft) {
        to.scrollLeft = from.scrollLeft;
      }
    });
  };
  mirrorScroll(elRulerScroll, elTracks);
  mirrorScroll(elTracks, elRulerScroll);

  let timelineOpen = false;
  let playing = false;
  /**
   * -1, not 0, so the FIRST `update` always paints.
   *
   * The readout is only rewritten when the time changes, which is right --
   * it runs every rendered frame. But a clip opens at 0, so a sentinel of 0
   * means the transport shows an EMPTY time until something advances it:
   * open a clip, press Escape immediately, and there is no clock at all.
   */
  let lastTime = -1;
  let lastCamera: PlaybackCamera = meta.defaultCamera;
  /** The camera segments as they were last drawn -- see `update`. */
  let lastSegments = '';
  /**
   * The playhead, unconditionally. `lastTime` is a repaint sentinel and
   * starts at -1; this is the time a new keyframe is placed at, and a key at
   * -1 would be a key the ruler cannot draw.
   */
  let playhead = 0;
  /** Which keyframe is selected, and its curve -- shared with the picker. */
  const easeState = emptyEaseState();

  /**
   * Ask the session to seek, and move the playhead HERE rather than waiting
   * for the answer to come back through `update`.
   *
   * `update` runs once a rendered frame, so between a click on the ruler and
   * the next frame this file's idea of the playhead is the OLD time -- and a
   * keyframe placed in between would land at wherever the playhead used to
   * be. One frame of staleness is invisible until the frame is slow, and
   * then it silently keys the wrong moment.
   */
  const seekTo = (t: number): void => {
    playhead = Math.min(duration, Math.max(0, t));
    hooks.seek(playhead);
  };
  /** Positions on the ruler and the scrubber are a fraction of the duration. */
  const frac = (ms: number): number => (duration > 0 ? Math.min(1, Math.max(0, ms / duration)) : 0);
  const pct = (ms: number): string => `${(frac(ms) * 100).toFixed(4)}%`;

  // ---- undo / redo --------------------------------------------------------

  function renderHistory(): void {
    elUndo.disabled = !history.canUndo();
    elRedo.disabled = !history.canRedo();
  }

  /**
   * Repaint everything, and re-validate the selection.
   *
   * An undo can take away the very keyframe the easing picker is pointed at
   * -- undoing "place a keyframe" is exactly that -- and a `Selection`
   * naming a key that no longer exists would leave the picker lit, writing
   * every click into nothing.
   */
  function afterHistoryMove(): void {
    const selected = easeState.selection;
    if (selected) {
      const track = findTrack(timeline, selected.track);
      const key = track?.keys.find((k) => k.time === selected.time);
      if (key) {
        easeState.ease = key.ease;
      } else {
        easeState.selection = null;
        easeState.ease = { ...DEFAULT_EASE };
      }
    }
    modeRow.render();
    trackList.render();
    renderRuler();
    easePicker.render();
  }

  const history = createHistory(timeline, (restored) => {
    if (restored) {
      afterHistoryMove();
    }
    renderHistory();
  });

  elUndo.addEventListener('click', () => history.undo());
  elRedo.addEventListener('click', () => history.redo());

  // ---- transport ----------------------------------------------------------

  elPlay.addEventListener('click', () => hooks.setPlaying(!playing));
  elPlay2.addEventListener('click', () => hooks.setPlaying(!playing));
  elClose.addEventListener('click', () => hooks.exit());

  const draggable = createDraggable(duration);
  draggable(elScrub, (t) => seekTo(t));

  // ---- the timeline panel -------------------------------------------------

  const camButtons = new Map<PlaybackCamera, HTMLButtonElement>();
  for (const cam of CAMERAS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = cam.label;
    btn.title = `Cut to ${cam.label} at the playhead`;
    /*
     * A pill CUTS: it writes a camera segment at the playhead as well as
     * setting the live camera.
     *
     * It used to only do the second, which made "the camera should be
     * switchable in the timeline" mean a global switch applying to the whole
     * clip -- an export could not go from chase to free at four seconds, and
     * `timeline.cameras` was a model the UI never wrote to. The live camera
     * is still set because the session's own picture follows it whenever the
     * timeline has no segments at all, and because entering free cam is what
     * seeds the flown camera's pose from wherever the shot already was.
     */
    btn.addEventListener('click', () => {
      cutCameraAt(playhead, cam.id);
      hooks.setCamera(cam.id);
    });
    camButtons.set(cam.id, btn);
    elCams.appendChild(btn);
  }

  /**
   * Cut to `camera` at `time`, keeping everything before it looking the way
   * it already does.
   *
   * The head segment is the whole of the second half. With an empty list the
   * shot is whatever camera is live, from 0 to the end; write one segment at
   * four seconds and everything BEFORE it silently falls back to the clip's
   * own default instead -- so picking CHASE at 0:04 would also, invisibly,
   * change the first four seconds from free cam to FPV. Seeding the head with
   * the camera that was in effect makes the cut a cut rather than two.
   *
   * Same shape as `seedInitialKeys`: a first edit has to write the state that
   * was already implied, or it reads as having changed something it did not
   * touch.
   */
  function cutCameraAt(time: number, camera: PlaybackCamera): void {
    history.pushUndo();
    if (timeline.cameras.length === 0 && time > 0) {
      setCameraAt(timeline, 0, lastCamera);
    }
    setCameraAt(timeline, time, camera);
    modeRow.render();
    trackList.render();
  }

  const easePicker = createEasePicker(elEase, easeState, timeline, () => history.pushUndo());

  /*
   * The grip is 12px wide and the marker it stands for is a single time, so
   * a press lands up to six pixels off the value it grabbed. Remembering
   * that offset and carrying it through the drag is what makes the handle
   * move WITH the pointer instead of jumping under it on contact -- and it
   * is why the press itself is `onDown` (which does nothing but measure)
   * rather than a move.
   */
  let grabOffset = 0;
  /*
   * The grips get the same one-entry-per-gesture treatment as the lanes, and
   * it costs nothing extra here: `draggable`'s `onDown` already exists to
   * MEASURE without moving, so the press arms and the first real `onMove`
   * commits. A grip pressed and released without travelling writes no entry,
   * which is right -- it changed nothing.
   */
  draggable(
    elIn,
    (t) => {
      history.commitArmedUndo();
      timeline.inPoint = Math.max(0, Math.min(t + grabOffset, timeline.outPoint - MIN_RANGE));
      renderRuler();
    },
    elRuler,
    (t) => {
      grabOffset = timeline.inPoint - t;
      history.armUndo();
    },
  );
  draggable(
    elOut,
    (t) => {
      history.commitArmedUndo();
      timeline.outPoint = Math.min(
        duration,
        Math.max(t + grabOffset, timeline.inPoint + MIN_RANGE),
      );
      renderRuler();
    },
    elRuler,
    (t) => {
      grabOffset = timeline.outPoint - t;
      history.armUndo();
    },
  );

  /*
   * The ruler scrubs, and does nothing else.
   *
   * It used to carry a diamond per keyframe -- a summary of every track,
   * drawn once where the shape of the shot reads without scanning five rows
   * -- with press-to-seek, drag-to-retime and double-press-to-remove-across-
   * all-tracks hung off hit-testing them. They are gone: with per-property
   * keyframes on the lanes directly below, a second row of marks standing
   * for an unnamed mixture of tracks was redundant with the lanes and
   * confusing next to them, and one of the two rows had to be the one a
   * keyframe lives in.
   *
   * What the ruler keeps is what only it can say: where the export range is,
   * where the playhead is, and a press or a drag anywhere on it to move the
   * playhead there.
   *
   * Which is why `renderRuler` is not called after a keyframe edit any more,
   * and why `track-list.ts` does not take it: it draws the in/out band, the
   * grips and their labels, and a key edit cannot move any of those. Those
   * calls were left over from when a new key had to show up on this row too.
   */
  draggable(elRuler, (t) => seekTo(t));

  // The CAMERA MODE row is appended FIRST and the property rows after it:
  // `tools/browser/timeline-drag.ts` addresses FOV as `:nth-child(3)` of the
  // track list and CAMERA POS as the first bare `.ob-pb-lane` on the page.
  const modeRow = createModeRow({
    timeline,
    duration,
    defaultCamera: meta.defaultCamera,
    liveCamera: () => lastCamera,
    frac,
    pct,
  });
  elTracks.appendChild(modeRow.element);

  const trackList = createTrackList(elTracks, {
    timeline,
    duration,
    history,
    selection: easeState,
    playhead: () => playhead,
    /*
     * Paused as well as sought when a diamond is CLICKED: a selection is a key
     * being edited, and every edit writes at the playhead, so a clip left
     * playing would carry the playhead off the key before the hand reached
     * the fader or `K`. A key being PLACED only seeks -- see `addKey`.
     */
    park: (t, pause) => {
      if (pause) {
        hooks.setPlaying(false);
      }
      seekTo(t);
    },
    cameraPose: () => hooks.cameraPose(),
    frac,
    pct,
    modeAt: modeRow.modeAt,
    hatchSpans: modeRow.hatchSpans,
    renderEase: () => easePicker.render(),
  });

  function renderRuler(): void {
    elRange.style.left = pct(timeline.inPoint);
    elRange.style.right = `${(100 - frac(timeline.outPoint) * 100).toFixed(4)}%`;
    elIn.style.left = pct(timeline.inPoint);
    elOut.style.left = pct(timeline.outPoint);
    elInLabel.textContent = formatClock(timeline.inPoint);
    elOutLabel.textContent = formatClock(timeline.outPoint);
    const span = timeline.outPoint - timeline.inPoint;
    elRangeLabel.textContent =
      `Export range ${formatClock(timeline.inPoint)} – ${formatClock(timeline.outPoint)} ` +
      `(${formatSpan(span)} of ${formatClock(duration)})`;
  }

  function renderCameras(camera: PlaybackCamera): void {
    for (const [id, btn] of camButtons) {
      btn.classList.toggle('active', id === camera);
    }
    elCam.textContent = camera === 'free' ? 'FREE CAM' : `${camera.toUpperCase()} — FIXED`;
    elCam.className = camera === 'free' ? 'ob-pb-badge free' : 'ob-pb-badge cam';
  }

  renderRuler();
  modeRow.render();
  trackList.render();
  easePicker.render();
  renderHistory();
  renderCameras(meta.defaultCamera);

  // ---- modals -------------------------------------------------------------

  const modals = createModalStack({
    parent,
    clipName: meta.name,
    duration,
    range: () => ({ inPoint: timeline.inPoint, outPoint: timeline.outPoint }),
    hooks,
  });

  elExport.addEventListener('click', modals.openExport);

  // ---- the two views ------------------------------------------------------

  function setTimelineOpen(open: boolean): void {
    timelineOpen = open;
    elPanel.hidden = !open;
    // The floating transport IS the timeline's transport when the panel is
    // open -- `Pc` has one play button, not two.
    elFloat.hidden = open;
    elExport.hidden = !open;
    // Undo and redo go with the panel, because there is nothing to undo
    // without it: `Pb` has no edit in it at all, and the frame draws the pair
    // only in `Pc`.
    elHistory.hidden = !open;
    elToggle.textContent = open ? 'Hide timeline' : 'Show timeline';
    /*
     * Opening the panel does NOT change the camera, and closing it does not
     * either.
     *
     * It used to force free cam on open, on the reasoning that the panel is
     * for shot composition and the tracks are meaningless from a camera the
     * clip is driving. That is wrong twice over. A side-locked map plays in
     * SIDE, and throwing the viewer into a free camera the moment they ask to
     * see the timeline loses the shot they were looking at -- they opened a
     * panel, they did not ask to take the camera. And the CAMERA MODE row
     * exists precisely so the camera is a thing on the timeline: opening the
     * panel and immediately writing FREE over the clip's own camera makes
     * that row describe an edit nobody made.
     *
     * Taking the camera by hand -- the CAMERA pills, WASD, a look drag --
     * still cuts to free, which is where that decision belongs.
     *
     * Closing forced `meta.defaultCamera` for symmetry, and that is worse
     * now: once camera SEGMENTS exist they outrank the picker, so the forced
     * set was either ignored or it discarded a camera the viewer chose.
     */
    if (open) {
      trackList.seedInitialKeys();
    }
  }

  elToggle.addEventListener('click', () => setTimelineOpen(!timelineOpen));

  /**
   * Ctrl+Z and Ctrl+Shift+Z, and the three conditions on them.
   *
   * - **Only with the panel open.** `Pb` has no editing surface at all, so an
   *   undo there would silently rewrite a timeline the viewer cannot see.
   *   This is what "while the timeline panel has focus" means on a panel
   *   whose controls are divs: the panel being the mode that is up.
   * - **Never under a modal.** `modals.anyOpen()` already answers it, and a
   *   render in progress is the case that matters -- undoing the timeline the
   *   encoder is halfway through reading would change the shot mid-file.
   * - **Never while a value cell is being typed into.** Ctrl+Z inside a text
   *   field means undo the TYPING, which the browser does itself; the field
   *   also stops the event on its own, and this is the belt to that's braces.
   *
   * `metaKey` as well as `ctrlKey`, because this is Cmd+Z on a Mac and a
   * playback screen is a thing people will open on a laptop.
   */
  const onHistoryKey = (e: KeyboardEvent): void => {
    if (!timelineOpen || trackList.isEditing()) {
      return;
    }
    if (modals.anyOpen()) {
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'z') {
      return;
    }
    e.preventDefault();
    if (e.shiftKey) {
      history.redo();
    } else {
      history.undo();
    }
  };
  window.addEventListener('keydown', onHistoryKey);

  return {
    timeline,
    get timelineOpen(): boolean {
      return timelineOpen;
    },
    get pauseOpen(): boolean {
      return modals.pauseOpen();
    },
    modalOpen: modals.anyOpen,
    dismissModal: modals.dismiss,
    keyCamera(timeMs: number): void {
      playhead = timeMs;
      /*
       * REFUSED outside a FREE span, and this is the fix for the one place
       * the hatch rule was not enforced.
       *
       * `K` used to be gated on the LIVE camera in `playback-session.ts`, so
       * it could key a pose at a playhead whose CAMERA MODE segment is not
       * FREE -- cut to chase at four seconds, scrub to five, press K, and a
       * camera keyframe lands in a hatched span where nothing will ever drive
       * it. The lane refuses that add for exactly this reason.
       *
       * Refuse rather than cut to FREE, which was the other option. Two
       * arguments, and the first is decisive: `keyCameraAt`'s own comment
       * says there is ONE way to make a camera keyframe and `K` is a shortcut
       * TO it, not a second mechanism beside it -- and the one way refuses
       * here. Making `K` cut instead would re-create exactly the divergence
       * that comment records, with the shortcut doing more than the gesture
       * it stands for. The second is that cutting would not even be a clean
       * cut: `freeStarted` in the session means re-entering free cam does NOT
       * re-seed the flown pose from the camera being left, so `K` in chase
       * would jump the shot to wherever free cam was last parked and then key
       * THAT -- a keyframe of a pose the viewer never chose.
       *
       * Silent, like the lane. Cutting to FREE with the CAMERA pills is one
       * click, and it is an edit to the shot that should be made on purpose.
       */
      if (modeRow.modeAt(timeMs) !== 'free') {
        return;
      }
      trackList.keyCameraAt(timeMs);
    },
    pushUndo: history.pushUndo,
    toggleTimeline(): void {
      setTimelineOpen(!timelineOpen);
    },
    openPause: modals.openPause,
    closePause: modals.closePause,
    update(timeMs: number, isPlaying: boolean, camera: PlaybackCamera): void {
      playing = isPlaying;
      elPlay.classList.toggle('paused', !isPlaying);
      elPlay2.classList.toggle('paused', !isPlaying);
      playhead = timeMs;
      if (timeMs !== lastTime) {
        lastTime = timeMs;
        const label = `${formatClock(timeMs)} / ${formatClock(duration)}`;
        elTime.textContent = label;
        elTime2.textContent = label;
        elScrubFill.style.width = pct(timeMs);
        elScrubKnob.style.left = pct(timeMs);
        elHead.style.left = pct(timeMs);
      }
      /*
       * Outside the time gate, deliberately.
       *
       * The readouts are a function of the timeline AS WELL AS the playhead,
       * and an edit made while the clip is paused changes the first without
       * touching the second -- so gating this on "the time moved" would leave
       * a stale number on screen until something else nudged the clock. It is
       * four short scans and no DOM write when nothing changed; see
       * `renderValues`.
       */
      trackList.renderValues();
      /*
       * The mode row repaints when the camera changes OR when the segment
       * list does, and the second half is not redundant.
       *
       * Flying the free camera writes a segment from inside the session (see
       * `beginFlying` there), so the list can change without this file having
       * touched it and without the active camera differing from the frame
       * before -- a cut to free while already looking through the free camera
       * is exactly that case. Comparing a signature rather than exposing a
       * "the segments changed" hook keeps every writer, present and future,
       * from having to remember to call one.
       */
      const signature = timeline.cameras.map((s) => `${s.time}:${s.camera}`).join();
      if (camera !== lastCamera || signature !== lastSegments) {
        lastCamera = camera;
        lastSegments = signature;
        renderCameras(camera);
        modeRow.render();
        // The CAMERA POS hatching is drawn from the same segments.
        trackList.render();
      }
    },
    setExportProgress: modals.setExportProgress,
    exportFinished: modals.exportFinished,
    dispose(): void {
      modals.dispose();
      // The one listener this file puts on `window`. Everything else is on an
      // element under `root` and goes with it.
      window.removeEventListener('keydown', onHistoryKey);
      root.remove();
    },
  };
}
