/**
 * Undo and redo for the playback timeline.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A SNAPSHOT stack, deliberately, and the proportion is the point.
 *
 * `Timeline` is plain data -- arrays of numbers, strings and two-field
 * objects -- so `structuredClone` of the whole thing is the complete state
 * of every edit the chrome can make, and restoring one is the complete undo
 * of any of them. The alternative, a command object per operation with its
 * own inverse, would be six classes that each have to be kept in step with
 * the edit they mirror, for a model that fits in a few hundred bytes. The
 * day a timeline is big enough for that to matter is the day this is worth
 * revisiting, and a ten-minute clip keyframed heavily is still kilobytes.
 */

import type { Timeline } from '../../playback/timeline.js';

/**
 * 50 entries. A shot is composed in dozens of edits, not thousands, and 50
 * clones of a few kilobytes is nothing to hold; the cap exists so a session
 * left open all afternoon cannot grow without bound, not because 50 is a
 * number anyone will reach.
 */
const UNDO_DEPTH = 50;

export interface TimelineHistory {
  /** Before a one-shot edit: the whole of it happens in one call. */
  pushUndo(): void;
  /** The press of a gesture that may or may not turn into a drag. */
  armUndo(): void;
  /** The first move of a drag: the armed snapshot becomes the one entry. */
  commitArmedUndo(): void;
  /**
   * The release of a press that never travelled.
   *
   * The third of the arm/commit pair rather than an afterthought: a press
   * that did not move was a click, and a click that changed nothing must
   * cost no entry at all. Without it the armed clone would survive to be
   * committed by the NEXT gesture, which would then undo two edits at once.
   */
  dropArmedUndo(): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

/**
 * `onChanged(restored)` is the single hook back into the chrome.
 *
 * `false` means only the stack depths moved, so the two buttons want
 * repainting and nothing else does. `true` means the timeline itself was
 * replaced under everyone holding it, so the whole panel has to be redrawn
 * and the easing picker's selection re-validated -- an undo can take away
 * the very keyframe it was pointed at.
 */
export function createHistory(
  timeline: Timeline,
  onChanged: (restored: boolean) => void,
): TimelineHistory {
  const undoStack: Timeline[] = [];
  const redoStack: Timeline[] = [];
  /**
   * The state before a GESTURE, held until the gesture proves to be one.
   *
   * A drag must cost exactly one undo entry, not one per `pointermove` --
   * fifty entries for one nudge of a keyframe is a history nobody can walk
   * back through. But a press that never travels is a click, and a click that
   * changed nothing must cost no entry at all. So the press ARMS (clones,
   * cheaply, and holds it here) and the first move that clears `DRAG_SLOP`
   * COMMITS. A press that is released without moving drops it.
   */
  let armedUndo: Timeline | null = null;

  const snapshot = (): Timeline => structuredClone(timeline);

  const remember = (state: Timeline): void => {
    undoStack.push(state);
    if (undoStack.length > UNDO_DEPTH) {
      undoStack.shift();
    }
    // A new edit makes the redo branch unreachable. Keeping it would offer to
    // reapply a change on top of a timeline it was never computed against.
    redoStack.length = 0;
    onChanged(false);
  };

  /**
   * Restore IN PLACE, never by replacing the object.
   *
   * `playback-session.ts` holds the same `Timeline` by reference and reads it
   * every frame, and so does the chrome's own `timeline` property. Assigning
   * a fresh object here would undo the edit in this file's copy and leave the
   * session driving the old one -- an undo that appeared to work on the lanes
   * and changed nothing about the picture.
   */
  const restoreTimeline = (from: Timeline): void => {
    timeline.cameras.splice(0, timeline.cameras.length, ...from.cameras);
    timeline.tracks.splice(0, timeline.tracks.length, ...from.tracks);
    timeline.cues.splice(0, timeline.cues.length, ...from.cues);
    timeline.inPoint = from.inPoint;
    timeline.outPoint = from.outPoint;
  };

  return {
    pushUndo(): void {
      remember(snapshot());
    },
    armUndo(): void {
      armedUndo = snapshot();
    },
    commitArmedUndo(): void {
      if (armedUndo) {
        remember(armedUndo);
        armedUndo = null;
      }
    },
    dropArmedUndo(): void {
      armedUndo = null;
    },
    undo(): void {
      const previous = undoStack.pop();
      if (!previous) {
        return;
      }
      redoStack.push(snapshot());
      restoreTimeline(previous);
      onChanged(true);
    },
    redo(): void {
      const next = redoStack.pop();
      if (!next) {
        return;
      }
      undoStack.push(snapshot());
      restoreTimeline(next);
      onChanged(true);
    },
    canUndo: (): boolean => undoStack.length > 0,
    canRedo: (): boolean => redoStack.length > 0,
  };
}
