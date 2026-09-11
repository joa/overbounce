/**
 * The two pointer gestures the playback chrome builds everything else out of.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Both are here rather than in `playback-chrome.ts` because both are about
 * the POINTER and nothing about the timeline: what a press means, and who
 * owns it. Their comments are the record of four separate bugs -- a marker
 * that could not be grabbed, a marker that could be grabbed and would not
 * move, a double-click that deleted what a second nudge had just moved, and a
 * `dblclick` that never arrived -- so they are long, and they stay long.
 *
 * `tools/browser/timeline-drag.ts` is what actually proves this file works:
 * a synthesised `PointerEvent` cannot test `setPointerCapture`, which is the
 * line both of these exist to get right. Read that file's header before
 * changing anything below.
 */

/**
 * A double press, recognised on `pointerdown` rather than through `dblclick`.
 *
 * Everything on this row already owns `pointerdown` and interferes with
 * it: the scrubber and the markers `preventDefault` so a drag does not
 * start a text selection, and the markers `stopPropagation` so the ruler
 * underneath cannot steal the pointer capture. `dblclick` is a synthesised
 * event riding on the `click` chain those handlers are disturbing, so
 * building the gesture on the event this component actually controls
 * removes a dependency rather than working around a specific browser
 * behaviour. It also means a lane's "press to select" and "double-press to
 * add or remove" are decided by the same event, in order, instead of
 * racing two.
 *
 * 400ms is the platform's own double-click window; 6px of slop keeps a hand
 * that drifts between the two presses from being read as one press twice.
 */
export function onDoublePress(
  el: HTMLElement,
  handler: (e: PointerEvent) => void,
): { forget(): void } {
  let lastAt = 0;
  let lastX = 0;
  el.addEventListener('pointerdown', (e) => {
    const now = performance.now();
    if (now - lastAt < 400 && Math.abs(e.clientX - lastX) < 6) {
      lastAt = 0;
      handler(e);
      return;
    }
    lastAt = now;
    lastX = e.clientX;
  });
  return {
    /**
     * Drop the press being remembered, so the next one starts a new pair.
     *
     * A press that turned into a DRAG was not half of a double-click, and
     * without this a user who nudged a keyframe twice in quick succession
     * would have deleted it on the second nudge.
     */
    forget(): void {
      lastAt = 0;
    },
  };
}

/**
 * Drag on a horizontal strip -> a clip time.
 *
 * Pointer CAPTURE, not a window-level mousemove: a scrub that leaves the
 * 4px-tall bar (which is every scrub) has to keep tracking, and capture is
 * what makes the element keep receiving moves without a global listener to
 * tear down. The same helper drives the scrubber, the ruler and both
 * in/out grips, which is the whole reason the scrubber is not an
 * `<input type=range>`.
 */
export type Draggable = (
  el: HTMLElement,
  /**
   * The pointer moved while held. Gets the raw event as well as the time,
   * because "has this press travelled far enough to be a drag" is a
   * question in PIXELS -- see `DRAG_SLOP` in `track-list.ts`.
   */
  onMove: (timeMs: number, e: PointerEvent) => void,
  /**
   * What the pointer's X is measured AGAINST, when that is not `el` itself.
   *
   * The in/out markers are `width: 0` elements -- they are a position on
   * the ruler, and their grip is an absolutely-positioned child hanging off
   * that position. So measuring against `el` gave a zero-width rect and
   * every drag resolved to time 0: the markers could be grabbed and would
   * not move. They have to be measured against the RULER, which is the
   * thing whose width means something.
   */
  measure?: HTMLElement,
  /**
   * The first press, when it means something different from a drag.
   *
   * The in/out grips use it to MEASURE rather than to move: a 12px grip
   * standing for a single time is pressed up to six pixels off the value it
   * grabbed, and remembering that offset is what makes the handle travel
   * with the pointer instead of jumping under it on contact. Moving on the
   * press would defeat that by definition.
   */
  onDown?: (timeMs: number, e: PointerEvent) => void,
) => void;

/**
 * `draggable`, bound to the clip length every strip is measured in.
 *
 * A factory because `duration` is the one thing the helper needs from the
 * screen around it: every strip it drives spans the whole clip, so a pointer
 * X within the measured element IS a fraction of the duration. Binding it
 * once keeps all four call sites reading as they did when this was a closure
 * inside `createPlaybackChrome`.
 */
export function createDraggable(duration: number): Draggable {
  return (el, onMove, measure = el, onDown) => {
    const at = (e: PointerEvent): number => {
      const rect = measure.getBoundingClientRect();
      if (rect.width <= 0) {
        return 0;
      }
      return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * duration;
    };
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      el.setPointerCapture(e.pointerId);
      const t = at(e);
      if (onDown) {
        onDown(t, e);
      } else {
        onMove(t, e);
      }
      e.preventDefault();
      /*
       * This press belongs to THIS element, and no ancestor gets to start a
       * drag of its own with it.
       *
       * Load-bearing, and the reason the in/out markers could not be moved:
       * they are children of the ruler, and the ruler is `draggable` too. A
       * press on a grip ran the marker's handler and then the ruler's, and
       * the second `setPointerCapture` of a dispatch is the one that sticks
       * -- so capture landed on the RULER. Every following move and the
       * release were then delivered to the ruler, which scrubbed; the marker
       * kept `dragging === true` forever, having never seen its own
       * `pointerup`. Two nested draggables cannot share a press, so the
       * inner one takes it.
       */
      e.stopPropagation();
    });
    el.addEventListener('pointermove', (e) => {
      if (dragging) {
        onMove(at(e), e);
      }
    });
    const stop = (e: PointerEvent): void => {
      if (dragging) {
        dragging = false;
        el.releasePointerCapture(e.pointerId);
      }
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  };
}
