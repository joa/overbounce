/**
 * The five property rows of `Pc`, and every gesture on them.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * One row per track group: a name that toggles the track off, a 20px lane
 * that is both a keyframe strip and a fader, and a 64px cell that prints the
 * value at the playhead and can be typed into. `track-rows.ts` says what the
 * rows ARE; this is the DOM and the pointer handling.
 *
 * ## Two gestures share one lane, and the rule that keeps them apart
 *
 * A press ON a diamond retimes it, horizontally. A press on BARE lane sets
 * the row's value, vertically. Which one a press means is decided AT THE
 * PRESS, from what is under the pointer, and held for the whole drag -- the
 * long comments on `pointerdown` below are the argument for that and for why
 * the obvious alternative (decide from the direction the hand travels) is
 * unusable. Read them before touching either handler.
 *
 * ## A press on a diamond that does not travel SELECTS, on the lane's `pointerup`
 *
 * Not on the diamond's `click`. The lane takes pointer capture on the press so
 * a retime can leave the diamond, and capture retargets the release -- and
 * therefore the `click` -- to the lane. A `click` listener on the diamond was
 * dead code from the day the lane learned to retime, which is how "diamonds
 * are no longer selectable" happened with every drag check still green. Trap
 * 24 in `.agent/docs/playback-screens.md`.
 *
 * Selecting also PARKS the playhead on the key (paused, sought to its time).
 * Every edit on this screen writes at the playhead -- the fader, a typed value,
 * `K` -- so a selection the playhead is not on gives none of them a way to
 * reach the key that is lit.
 *
 * ## Listener order here is behaviour
 *
 * `onDoublePress` registers its `pointerdown` BEFORE the retime/fader one, so
 * on the second press of a double-click the key is added or removed first and
 * the drag handler then hit-tests against the modified track. Keep that
 * order; it is not the order the code happens to be written in, it is what
 * makes a double-click on a diamond remove it instead of starting a drag of
 * something that is about to disappear.
 *
 * `tools/browser/timeline-drag.ts` drives all of this through a real browser
 * and is the only thing that proves it.
 */

import type { PlaybackCamera, Timeline, TrackId } from '../../playback/timeline.js';
import {
  evaluateTrack,
  findTrack,
  moveKeyframe,
  removeKeyframe,
  setValueAt,
  sortTimeline,
  UNCONSUMED_TRACKS,
} from '../../playback/timeline.js';
import type { EaseState } from './ease-picker.js';
import type { TimelineHistory } from './history.js';
import { formatClock } from './format.js';
import { onDoublePress } from './gestures.js';
import type { TrackRow } from './track-rows.js';
import {
  formatValue,
  parseValue,
  toInputText,
  TRACK_ROWS,
  VALUE_OFF,
} from './track-rows.js';

/**
 * How close, IN PIXELS, a press has to be to a keyframe to mean it.
 *
 * Pixels rather than milliseconds, which is the trap a time-based
 * tolerance walks into: 120ms is most of the ruler on a four-second clip
 * and a third of a pixel on a ten-minute one, so the target would be
 * either enormous or unhittable depending on the recording. What the hand
 * is aiming at is a diamond on screen, so the tolerance belongs in the
 * unit the diamond is drawn in.
 */
const KEY_GRAB_PX = 9;

/**
 * How far a press has to travel before it is a DRAG rather than a click.
 *
 * Below this a press still means what a press means -- select the key for
 * the easing picker -- so a hand that shifts a pixel while clicking a diamond
 * does not silently retime the shot.
 *
 * The lanes are the only caller. The ruler once carried diamonds of its own
 * with the same press-versus-drag question on them, and they are gone -- see
 * the comment on the ruler's `draggable` in `playback-chrome.ts` for why.
 */
const DRAG_SLOP = 3;

/**
 * How many pixels of vertical drag cover a track's whole display range.
 *
 * Not the lane's own height, which is 20px -- see the drag handler. 160 is
 * a comfortable forearm movement and gives FOV (50..140) a little over half
 * a degree per pixel, which is fine enough to land on a round number and
 * coarse enough to cross the range without letting go.
 */
const FADER_TRAVEL_PX = 160;

/** The free camera's pose, as `PlaybackChromeHooks.cameraPose` reports it. */
export interface CameraPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export interface TrackListOptions {
  timeline: Timeline;
  duration: number;
  history: TimelineHistory;
  /** Shared with the easing picker: clicking a diamond is what selects. */
  selection: EaseState;
  playhead(): number;
  /**
   * Park the playhead at `ms`: seek, and pause first when `pause` is set.
   * Selecting a key calls it so the edits that write at the playhead land on
   * the selected key.
   */
  park(ms: number, pause: boolean): void;
  cameraPose(): CameraPose;
  frac(ms: number): number;
  pct(ms: number): string;
  /** From the CAMERA MODE row, so the hatch rule is stated once. */
  modeAt(time: number): PlaybackCamera;
  hatchSpans(): { from: number; to: number }[];
  renderEase(): void;
}

export interface TrackList {
  /** Repaint every lane: hatching, fader lines, diamonds. */
  render(): void;
  /** Every value cell and every fader line, against the playhead. */
  renderValues(): void;
  keyCameraAt(time: number): void;
  seedInitialKeys(): void;
  /** True while a value cell is a text field -- Ctrl+Z belongs to it then. */
  isEditing(): boolean;
}

/**
 * Build the rows into `parent`, in `TRACK_ROWS` order.
 *
 * The chrome appends the CAMERA MODE row first and calls this second, and
 * that order matters beyond looking right: `timeline-drag.ts`
 * addresses FOV as `:nth-child(3)` of the track list and CAMERA POS as the
 * first bare `.ob-pb-lane` on the page.
 */
export function createTrackList(parent: HTMLElement, options: TrackListOptions): TrackList {
  const {
    timeline,
    duration,
    history,
    selection: state,
    playhead,
    park,
    cameraPose,
    frac,
    pct,
    modeAt,
    hatchSpans,
    renderEase,
  } = options;

  const laneFor = new Map<TrackRow, HTMLElement>();
  const valueCellFor = new Map<TrackRow, HTMLElement>();
  /**
   * The fader hairline per lane, re-made on every `render`.
   *
   * It cannot be a permanent child: `render` empties each lane with
   * `innerHTML = ''`, so anything created once is gone the first time a
   * keyframe is added. Created there and MOVED here, by `renderValues`, which
   * runs every frame -- the line follows the playhead, so it has to be
   * cheaper than a full lane repaint.
   */
  const levelFor = new Map<TrackRow, HTMLElement>();

  /**
   * The row whose value cell is currently a text field, if any.
   *
   * Read by `renderValues`, which runs every frame: without it the next
   * repaint would overwrite the field the user is typing into with the value
   * they are in the middle of replacing.
   */
  let editing: TrackRow | null = null;

  /**
   * The keyframe time under the pointer on this row's lane, or null.
   *
   * In PIXELS, like the ruler's, and shared by the two gestures that need it
   * so they can never disagree about what is being pointed at.
   */
  const keyUnderLane = (lane: HTMLElement, row: TrackRow, clientX: number): number | null => {
    const rect = lane.getBoundingClientRect();
    if (rect.width <= 0) {
      return null;
    }
    const track = findTrack(timeline, row.ids[0]);
    let hit: number | null = null;
    let bestGap = KEY_GRAB_PX;
    for (const key of track?.keys ?? []) {
      const gap = Math.abs(rect.left + frac(key.time) * rect.width - clientX);
      if (gap <= bestGap) {
        bestGap = gap;
        hit = key.time;
      }
    }
    return hit;
  };

  /**
   * Retime one visible diamond, which may stand for several tracks, and
   * report where it landed.
   *
   * `from` stays the ORIGINAL time for every id. They all still have a key
   * there, and asking the later ones to move a key at the time the first one
   * just landed on finds nothing -- silently leaving all but one behind.
   * That has now failed that exact way four times (the CAMERA POS row that
   * owned three ids while the button wrote six; the first lane drag; the
   * easing picker, which wrote the curve to `camX` alone and left the other
   * five linear; and it would have been this). **Whenever one mark stands for
   * several tracks, every operation on it has to name all of them, from the
   * same starting point.**
   *
   * The picker is the one that could not be caught by looking: an ease
   * changes no time and no value, so every diamond stays where it was. See
   * trap 14 in `.agent/docs/playback-screens.md`.
   *
   * The first id's clamped result becomes the target for the rest, so a key
   * that stopped short of a neighbour stops the whole group there rather
   * than splitting it.
   */
  const retimeKey = (ids: readonly TrackId[], from: number, to: number): number | null => {
    let landed: number | null = null;
    for (const id of ids) {
      const at = moveKeyframe(timeline, id, from, landed ?? to, duration);
      if (landed === null && at !== null) {
        landed = at;
      }
    }
    const selected = state.selection;
    if (landed !== null && selected && selected.time === from && ids.includes(selected.track)) {
      state.selection = { track: selected.track, time: landed };
    }
    return landed;
  };

  /** A row's value at the playhead, or null when its track says nothing. */
  const valueAt = (row: TrackRow): number | null => {
    const track = findTrack(timeline, row.ids[0]);
    return track ? evaluateTrack(track, playhead()) : null;
  };

  /**
   * Every value cell and every fader line, against the playhead.
   *
   * Runs once a frame out of `update`, unconditionally, which is why each
   * cell remembers the string it last printed: the work is four
   * `evaluateTrack` scans over a handful of keys each, and the DOM is touched
   * only when a number actually changed. Gating the whole call on "the time
   * moved" was the first version and it is subtly wrong -- an edit made while
   * the clip is paused changes the value at a playhead that did not move, so
   * the readout would sit there stale until something else nudged the clock.
   */
  function renderValues(): void {
    for (const [row, cell] of valueCellFor) {
      const scale = row.scale;
      if (!scale || editing === row) {
        continue;
      }
      const value = valueAt(row);
      const off = value === null || (scale.zeroIsOff && value === 0);
      const text = off ? VALUE_OFF : formatValue(scale, value);
      if (cell.textContent !== text) {
        cell.textContent = text;
      }
      cell.classList.toggle('live', !off);
      cell.classList.toggle('off', off);

      const level = levelFor.get(row);
      if (level) {
        level.hidden = value === null;
        if (value !== null) {
          const t = (value - scale.min) / (scale.max - scale.min);
          level.style.top = `${((1 - Math.min(1, Math.max(0, t))) * 100).toFixed(2)}%`;
        }
      }
    }
  }

  function render(): void {
    for (const [row, lane] of laneFor) {
      lane.innerHTML = '';
      levelFor.delete(row);
      if (row.scale) {
        /*
         * The fader line, FIRST, so every diamond draws over it.
         *
         * Re-made here rather than kept as a permanent child because the line
         * above empties the lane -- and positioned by `renderValues` rather
         * than here, because the value it shows is the value at the playhead
         * and that changes every frame, while this function rebuilds a whole
         * row of buttons and must not.
         */
        const level = document.createElement('div');
        level.className = 'ob-pb-level';
        level.hidden = true;
        lane.appendChild(level);
        levelFor.set(row, level);
      }
      if (row.hatchOutsideFree) {
        // Painted before the diamonds, so a key stranded in a hatched span is
        // still visible on top of it -- it is still the thing you have to be
        // able to grab to get rid of it.
        for (const span of hatchSpans()) {
          const hatch = document.createElement('div');
          hatch.className = 'ob-pb-hatch';
          hatch.style.left = pct(span.from);
          hatch.style.right = `${(100 - frac(span.to) * 100).toFixed(4)}%`;
          lane.appendChild(hatch);
        }
      }
      const track = findTrack(timeline, row.ids[0]);
      lane.parentElement?.querySelector('.ob-pb-track-name')?.classList.toggle(
        'off',
        track !== undefined && !track.enabled,
      );
      if (!track) {
        continue;
      }
      for (const key of track.keys) {
        const diamond = document.createElement('button');
        diamond.type = 'button';
        diamond.className = 'ob-pb-key';
        diamond.style.left = pct(key.time);
        diamond.title = `${formatClock(key.time)} — ${key.value.toFixed(2)}`;
        diamond.classList.toggle(
          'sel',
          state.selection?.track === row.ids[0] && state.selection.time === key.time,
        );
        // No listener here. Selecting is the lane's `pointerup` -- see the
        // header for why a `click` on this element never arrives.
        lane.appendChild(diamond);
      }
    }
    // The fader lines were just re-made and are still hidden at the top of
    // their lanes; only `renderValues` knows where they go. Called from here
    // rather than left to every caller, because "repaint the lanes" and "the
    // lines in them are in the right place" are not two things a caller
    // should have to remember to ask for separately.
    renderValues();
  }

  /**
   * Write `value` to every track this row owns, at `time`.
   *
   * Clamped to the row's DISPLAY range, which is the one place that range is
   * more than presentation: a fader that runs off the end of its own scale
   * leaves a value the line cannot draw and the readout cannot be dragged
   * back from, and a negative vignette or a field of view of 4000 degrees is
   * not a shot anyone is composing.
   *
   * `setValueAt` rather than `setKeyframe`, and its header says why at
   * length: the playhead is a float, and an edit to a value is not an edit to
   * its easing.
   */
  function setRowValue(row: TrackRow, value: number, time: number): void {
    const scale = row.scale;
    if (!scale) {
      return;
    }
    const clamped = Math.min(scale.max, Math.max(scale.min, value));
    for (const id of row.ids) {
      setValueAt(timeline, id, time, clamped);
    }
    render();
  }

  /**
   * Place a keyframe on every track this row owns, at the CURRENT value.
   *
   * "Current" is the live camera pose for the position row and the row's
   * fallback for the look rows, which is the behaviour a keyframe button has
   * everywhere: you fly the camera somewhere, you press the key, the pose is
   * recorded. Reading it back out of the timeline instead would record the
   * value the timeline already had, which is a no-op key.
   *
   * No re-render, no selection -- the callers decide both, because seeding a
   * whole timeline wants one repaint rather than five.
   *
   * `setValueAt`, not `setKeyframe`, for the reasons its header gives: a key
   * already within `KEY_MIN_GAP` of `time` is UPDATED, keeping its ease, rather
   * than crowded or relinearised. That is what makes "select a camera key, fly,
   * press K" re-pose the selected key instead of flattening its BOUNCE. A new
   * key still starts linear -- `setValueAt` creates with `DEFAULT_EASE`, not
   * with the picker's current curve, and the reason is below.
   *
   * Returns the time actually written, which is the existing key's when one
   * was matched.
   */
  function writeRowKey(row: TrackRow, time: number): number {
    const pose = cameraPose();
    const valueFor = (id: TrackId): number => {
      switch (id) {
        case 'camX':
          return pose.x;
        case 'camY':
          return pose.y;
        case 'camZ':
          return pose.z;
        case 'camYaw':
          return pose.yaw;
        case 'camPitch':
          return pose.pitch;
        case 'camRoll':
          return pose.roll;
        default:
          return findTrack(timeline, id)?.keys.at(-1)?.value ?? row.fallback;
      }
    };
    // Every id from the same `time`, and the FIRST id's landing is the time
    // the rest are written at -- trap 14: one mark over six tracks has to name
    // all six from one starting point.
    //
    // A new key is DEFAULT_EASE, not the picker's current `ease`. The picker
    // edits the SELECTED key; it is disabled when nothing is selected, so
    // nothing on screen says it also seeds new ones. It did, and the result
    // was that choosing BOUNCE once to fix one key silently made every later
    // key bounce. A new key is linear, you select it, you pick its curve.
    let landed: number | null = null;
    for (const id of row.ids) {
      const at = setValueAt(timeline, id, landed ?? time, valueFor(id));
      landed ??= at;
    }
    return landed ?? time;
  }

  function addKey(row: TrackRow, time: number): void {
    history.pushUndo();
    const at = writeRowKey(row, time);
    sortTimeline(timeline);
    // Seek, but do not pause: `K` is also tapped while a clip plays, to drop
    // keys as it runs, and the first tap must not stop it.
    selectKey(row, at, false);
  }

  /**
   * Light the key at `time` on `row` for the easing picker, and park the
   * playhead on it -- paused as well when `pause` is set, which is the click.
   *
   * The ease is read from the key itself rather than reset: re-keying an
   * existing BOUNCE key must leave the picker saying BOUNCE.
   */
  function selectKey(row: TrackRow, time: number, pause: boolean): void {
    const key = findTrack(timeline, row.ids[0])?.keys.find((k) => k.time === time);
    if (!key) {
      return;
    }
    state.selection = { track: row.ids[0], time };
    state.ease = key.ease;
    // Park BEFORE the repaint: `render` ends in `renderValues`, which prints
    // every readout at the playhead, and the playhead is what this moves.
    park(time, pause);
    render();
    renderEase();
  }

  /**
   * The field a click on the readout opens.
   *
   * An `<input>` swapped into the same 64px cell rather than a `contenteditable`
   * or a prompt: it is the only one of the three that gives a real caret, a
   * real selection and real Escape/Enter semantics for free, and swapping it
   * into the cell keeps the row's grid from reflowing while it is open.
   */
  function beginValueEdit(row: TrackRow, cell: HTMLElement): void {
    const scale = row.scale;
    if (!scale || editing) {
      return;
    }
    const current = valueAt(row);
    const restore = cell.textContent ?? '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current === null ? '' : toInputText(scale, current);
    cell.textContent = '';
    cell.appendChild(input);
    editing = row;

    /*
     * Escape removes the field, removing a focused field fires `blur`, and
     * `blur` commits -- so without this flag, cancelling wrote the value it
     * had just been told to throw away. One flag rather than detaching the
     * listener, because the same race exists the other way round: Enter
     * commits and then blurs.
     */
    let settled = false;
    const finish = (commit: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      editing = null;
      const typed = input.value;
      input.remove();
      cell.textContent = restore;
      if (commit) {
        const parsed = parseValue(scale, typed);
        // Unparseable input REVERTS. The cell has already been put back, so
        // there is nothing else to do -- and writing NaN instead would
        // propagate through `evaluateTrack`'s interpolation and blank a whole
        // span of the shot, with a 64px cell reading NaN as the only clue.
        if (parsed !== null) {
          history.pushUndo();
          setRowValue(row, parsed, playhead());
        }
      }
      renderValues();
    };

    input.addEventListener('keydown', (e) => {
      /*
       * The field owns the keyboard while it is open.
       *
       * `playback-session.ts` listens for Space, K and T on `window`, so
       * typing a value into an unguarded field would pause the clip on the
       * space bar and toggle the whole panel on a `t`. Undo is stopped here
       * for the same reason: Ctrl+Z inside a text field means undo the
       * TYPING, which the browser already does.
       */
      e.stopPropagation();
      if (e.key === 'Enter') {
        finish(true);
      } else if (e.key === 'Escape') {
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
  }

  for (const row of TRACK_ROWS) {
    const el = document.createElement('div');
    el.className = 'ob-pb-track';

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'ob-pb-track-name';
    name.textContent = row.label;
    name.title = UNCONSUMED_TRACKS.includes(row.ids[0])
      ? `${row.label} — keyframeable, but no render pass reads it yet`
      : `Click to enable or disable ${row.label}`;
    name.addEventListener('click', () => {
      const track = findTrack(timeline, row.ids[0]);
      if (track) {
        history.pushUndo();
        for (const id of row.ids) {
          const t = findTrack(timeline, id);
          if (t) {
            t.enabled = !track.enabled;
          }
        }
        render();
      }
    });

    const lane = document.createElement('div');
    lane.className = row.scale ? 'ob-pb-lane fader' : 'ob-pb-lane';
    lane.title = row.hatchOutsideFree
      ? 'Only editable while CAMERA MODE is FREE at the playhead'
      : row.scale
        ? 'Click a keyframe to select it and jump to it · drag up or down to set the value at the playhead · double-click to place a keyframe · drag one to retime it'
        : 'Click a keyframe to select it and jump to it · double-click to place a keyframe · drag one to retime it · double-click one to remove it';
    /*
     * Double-press is the ONE gesture that creates and destroys, on the lane
     * as on the ruler: on a keyframe it removes, on bare lane it adds one
     * there.
     *
     * A single click used to add, which quietly made double-click useless:
     * a double-click IS two single clicks, so double-clicking bare lane
     * added a key, added it again over the top, and then removed it --
     * ending exactly where it started, with nothing on screen to say why.
     * That is the "I cannot just double-click on the camera position" report,
     * and it is why one gesture now owns both directions.
     *
     * The detector is on the LANE and not on the diamonds. The first click
     * selects the key, selecting re-renders the lane, and re-rendering
     * REPLACES every diamond in it -- so a detector living on a diamond sees
     * a first press and is then thrown away before the second arrives. The
     * lane survives its own repaint (`innerHTML = ''` empties it), so the
     * gesture is recognised somewhere stable and the key is found by
     * hit-testing, in pixels, exactly as the ruler does it.
     *
     * This registration comes BEFORE the retime/fader `pointerdown` below,
     * and the order matters: on the second press the key is added or removed
     * first, and the drag handler then hit-tests against the track as it now
     * is.
     */
    const laneDouble = onDoublePress(lane, (e) => {
      const rect = lane.getBoundingClientRect();
      if (rect.width <= 0) {
        return;
      }
      const hit = keyUnderLane(lane, row, e.clientX);
      if (hit === null) {
        // Bare lane: a keyframe here, at the camera's CURRENT pose. Fly the
        // camera, then place the key -- see `flying` in playback-session.ts
        // for why a seek hands the camera back to the track.
        const time = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * duration;
        /*
         * ...unless the hatching says this stretch is not free cam.
         *
         * Only the ADD is refused. A key already sitting in a span that was
         * later cut to chase still has to be removable and retimeable, or
         * the only way to reach it would be to cut back to free cam first --
         * which is an edit to the shot, made in order to undo an edit to the
         * shot.
         */
        if (row.hatchOutsideFree && modeAt(time) !== 'free') {
          return;
        }
        addKey(row, time);
        return;
      }
      history.pushUndo();
      for (const id of row.ids) {
        removeKeyframe(timeline, id, hit);
      }
      if (state.selection?.track === row.ids[0] && state.selection.time === hit) {
        state.selection = null;
      }
      render();
      renderEase();
    });

    /*
     * Drag a diamond along its lane to RETIME the keyframe.
     *
     * Tracked on the lane rather than on the diamond, for the same reason
     * the double-press is: each move re-renders the lane and replaces every
     * diamond in it, so a listener living on one would be thrown away
     * mid-gesture. The lane holds the pointer capture and the key is
     * followed by TIME, which is stable across those repaints in a way an
     * element reference is not.
     *
     * A press only becomes a drag after `DRAG_SLOP` pixels. Below that it is
     * a click -- which selects the key for the easing picker -- so a hand
     * that shifts a pixel while clicking does not silently retime the shot.
     */
    let dragging: { time: number; startX: number; moved: boolean } | null = null;
    /*
     * ...and drag BARE lane up or down to set the row's value at the playhead.
     *
     * ## Which gesture a press means is decided once, at the press
     *
     * Two drags share one lane and they cannot both arm, or the first move
     * would have to pick one after a `setPointerCapture` has already been
     * taken for both -- which is trap 16's failure with the two owners inside
     * one element instead of nested. The discriminator is WHAT IS UNDER THE
     * POINTER, not which way it later travels:
     *
     *   a press ON a diamond  -> retime, horizontal, exactly as before
     *   a press on BARE lane  -> set the value, vertical
     *
     * That is the same rule the ruler already uses for scrub-versus-retime
     * (phase L: "chosen once at the press and held for the whole drag"), and
     * it has to be: the pointer leaves the diamond immediately -- that is
     * what dragging it means -- so anything re-tested per move would flip
     * gesture one frame in.
     *
     * Deciding on direction instead was the tempting alternative and it is
     * unusable: a hand cannot promise the first three pixels of a drag are
     * vertical, so half of every retime would land as a value change on a
     * keyframe the user was trying to move.
     *
     * ## And a press that does not travel creates nothing
     *
     * Trap 13. The lane's double-press already adds a keyframe on bare lane,
     * and a double click IS two single clicks -- so if the value drag wrote
     * on the press, double-clicking bare lane would set a value, set it
     * again, and then add a key, with two of those three being edits nobody
     * asked for. It writes only after `DRAG_SLOP` pixels of VERTICAL travel,
     * which a double-click does not have.
     */
    let fading: {
      startY: number;
      startValue: number;
      /**
       * The playhead as it was at the PRESS, held for the whole gesture.
       *
       * Re-reading it per move would spray a keyframe across every
       * millisecond the clip advanced through while the hand was moving, if
       * the drag happened during playback.
       */
      time: number;
      moved: boolean;
    } | null = null;

    lane.addEventListener('pointerdown', (e) => {
      const hit = keyUnderLane(lane, row, e.clientX);
      if (hit !== null) {
        dragging = { time: hit, startX: e.clientX, moved: false };
        history.armUndo();
        lane.setPointerCapture(e.pointerId);
        return;
      }
      if (!row.scale) {
        return;
      }
      fading = {
        startY: e.clientY,
        startValue: valueAt(row) ?? row.fallback,
        time: playhead(),
        moved: false,
      };
      history.armUndo();
      lane.setPointerCapture(e.pointerId);
      /*
       * No `preventDefault` here, and that is a decision rather than an
       * omission.
       *
       * It was here, to stop a vertical drag from painting a text selection
       * across the panel -- and a `preventDefault` on `pointerdown` also
       * suppresses the FOCUS change, so a value cell left open on another row
       * never blurred and never committed: the field sat there through the
       * whole drag and wrote its old number over the new one on the next
       * click. `user-select: none` on the lane solves the selection without
       * touching focus, which is what it is for.
       */
      /*
       * This press belongs to the lane. Nothing above it is draggable TODAY
       * -- the panel's ancestors are layout -- so this changes no behaviour,
       * and it is here because trap 16 is the bug that gets re-introduced by
       * adding an ancestor gesture later: capture cannot be shared, so the
       * inner owner has to claim the press before the outer one can see it.
       */
      e.stopPropagation();
    });

    lane.addEventListener('pointermove', (e) => {
      if (dragging) {
        if (!dragging.moved && Math.abs(e.clientX - dragging.startX) < DRAG_SLOP) {
          return;
        }
        if (!dragging.moved) {
          dragging.moved = true;
          // This press is a drag, not half of a double-click. Without this, two
          // quick nudges of the same keyframe would delete it on the second.
          laneDouble.forget();
          // One undo entry for the whole gesture -- see `armedUndo`.
          history.commitArmedUndo();
        }
        const rect = lane.getBoundingClientRect();
        if (rect.width <= 0) {
          return;
        }
        const wanted =
          Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * duration;
        // Every track the row owns moves TOGETHER -- a camera keyframe is one
        // pose, so its six tracks cannot end up at six different times. See
        // `retimeKey` for why they all start from `dragging.time`.
        const landed = retimeKey(row.ids, dragging.time, wanted);
        if (landed !== null) {
          dragging.time = landed;
        }
        render();
        return;
      }
      const scale = row.scale;
      if (!fading || !scale) {
        return;
      }
      if (!fading.moved && Math.abs(e.clientY - fading.startY) < DRAG_SLOP) {
        return;
      }
      if (!fading.moved) {
        fading.moved = true;
        laneDouble.forget();
        history.commitArmedUndo();
      }
      /*
       * RELATIVE to where the press started, not absolute within the lane.
       *
       * The lane is 20 pixels tall. Mapping its height onto the value range
       * would make the control a twenty-step fader that also JUMPS to
       * whatever the press happened to land on -- the value would change
       * before the hand had moved at all, which is the same contact jump the
       * in/out grips carry a `grabOffset` to avoid.
       */
      const next =
        fading.startValue + ((fading.startY - e.clientY) / FADER_TRAVEL_PX) * (scale.max - scale.min);
      setRowValue(row, next, fading.time);
    });

    const endDrag = (e: PointerEvent): void => {
      if (!dragging && !fading) {
        return;
      }
      lane.releasePointerCapture(e.pointerId);
      const clicked = e.type === 'pointerup' && dragging !== null && !dragging.moved
        ? dragging.time
        : null;
      dragging = null;
      fading = null;
      // A press that never travelled was a click, and a click costs no undo.
      history.dropArmedUndo();
      /*
       * ...and a click on a diamond selects it. HERE, and not in a `click`
       * listener on the diamond: the press above took pointer capture, so the
       * release and the `click` after it are retargeted to the lane and a
       * diamond's own listener never runs (trap 24).
       *
       * `pointerup` only. A cancelled press was not a click.
       *
       * After the double-press detector has had its chance: on the second
       * press of a double-click that detector removes the key, the press
       * above then finds nothing to arm, and this never sees a click.
       */
      if (clicked !== null) {
        // Paused: a key grabbed to edit must not have the clip carry the
        // playhead off it before the hand reaches the fader or `K`.
        selectKey(row, clicked, true);
      }
    };
    lane.addEventListener('pointerup', endDrag);
    lane.addEventListener('pointercancel', endDrag);

    /*
     * The 64px value cell: the row's value AT THE PLAYHEAD, and a text field.
     *
     * `renderValues` owns its contents from here on. CAMERA MODE and CAMERA
     * POS keep the fixed words the frame gives them -- neither is a scalar --
     * and every other row prints a number that is kept current every frame.
     */
    const value = document.createElement('div');
    value.className = 'ob-pb-track-value';
    value.textContent = row.staticValue ?? '';
    value.title = row.valueTitle;
    if (row.scale) {
      value.addEventListener('click', () => beginValueEdit(row, value));
    }

    el.append(name, lane, value);
    laneFor.set(row, lane);
    valueCellFor.set(row, value);
    parent.appendChild(el);
  }

  /** The row that owns the camera pose -- see `TRACK_ROWS`. */
  const cameraRow = TRACK_ROWS[0]!;

  return {
    render,
    renderValues,
    /**
     * Keyframe the whole camera -- position AND angles AND fov -- at `time`.
     *
     * This is the gesture that makes interpolation reachable. Keying position
     * alone through the CAMERA POS lane leaves the camera pointing wherever the
     * last free-flight left it, so a two-key move slid sideways without ever
     * looking at anything; and there was no way at all to key from the
     * playhead, only from wherever a lane happened to be clicked. Fly, press
     * K, scrub, fly, press K: two keys and the camera flies the shot between
     * them on the easing each key carries.
     *
     * **"AND fov" is not what this writes, and the wording is left alone.**
     * CAMERA POS owns six ids and they are the position and the angles; no
     * fov key is placed here, and `PlaybackChrome.keyCamera`'s own doc claims
     * the fov too. Whether the comments are stale or an fov key was lost in
     * some earlier edit cannot be told from here, and quietly correcting the
     * prose would bury the question instead of asking it.
     *
     * Keyframing the camera where it is now is exactly what a double-press on
     * the CAMERA POS lane does, and that is the point: there is one way to
     * make a camera keyframe and the `K` shortcut is a shortcut TO it, not a
     * second mechanism beside it. It used to be a button of its own writing a
     * different set of tracks, which is why keys made one way interpolated and
     * keys made the other way did not.
     */
    keyCameraAt(time: number): void {
      addKey(cameraRow, time);
    },
    /**
     * Give every track a keyframe at 0:00.0 holding the value it starts with.
     *
     * Interpolation needs somewhere to come FROM. Without this, keying the
     * camera at four seconds produced a track with exactly one key, which
     * holds that value across the whole clip -- so the camera did not travel,
     * it teleported into position at the start and sat there, and "the
     * interpolation does not work" is the correct reading of what that looks
     * like. With a key at zero, the first key the user places is the second
     * key of a pair, and the shot moves from the opening frame.
     *
     * Once only, and only for a track that has no keys yet: re-seeding on
     * every open would overwrite a zero key the user had deliberately moved or
     * retimed.
     *
     * **CAMERA POS is seeded only when the camera at 0:00 is already FREE**,
     * which is the same rule the lane's own double-press enforces: a key in a
     * hatched span has nothing to drive it. Without the test this was the one
     * writer that broke it, and it broke it in the way that hurt most.
     *
     * Opening the panel reads the LIVE pose (`cameraPose`), so a clip that
     * plays in SIDE got a camera key holding the side camera's eye at
     * whatever moment the panel happened to be opened -- and a single key
     * holds its value across the whole clip. From then on every cut to FREE
     * put the shot back at that pose. Open the panel at the start, as
     * everybody does, and free cam went to the spawn every single time, no
     * matter where the playhead was or what was on screen. That is the
     * "switching to free cam resets the camera" report, and the reason it
     * survived `playback-session.ts`'s own seeding: the track was overwriting
     * the seed a frame later, every frame.
     *
     * The camera does not need the zero key the scalars need. A scalar is
     * keyed to RAMP, so one key with nothing before it is a ramp with no
     * start. A camera pose is keyed to BE somewhere, and a free span with no
     * keys now starts from the eye the shot was already on
     * (`seedFreeFromView`) -- so the pair a move needs is the two keys the
     * user places, and neither of them is a pose nobody chose.
     */
    seedInitialKeys(): void {
      let added = false;
      for (const row of TRACK_ROWS) {
        if (findTrack(timeline, row.ids[0])) {
          continue;
        }
        if (row.hatchOutsideFree && modeAt(0) !== 'free') {
          continue;
        }
        writeRowKey(row, 0);
        added = true;
      }
      if (added) {
        sortTimeline(timeline);
        render();
      }
    },
    isEditing: (): boolean => editing !== null,
  };
}
