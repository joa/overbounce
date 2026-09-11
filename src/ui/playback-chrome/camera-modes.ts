/**
 * The CAMERA MODE row: which camera the shot is on, over time.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * CAMERA MODE is the first row of the track list and the only one that is not
 * a keyframe lane.
 *
 * A camera mode is not a number that interpolates: it HOLDS from the cut that
 * set it until the next cut -- so the row draws spans rather than diamonds:
 * one tinted, labelled bar per segment with a boundary line where the shot
 * changes. Which is why `setCameraAt` merges two abutting segments of the
 * same mode rather than leaving a line across a moment where nothing happens.
 *
 * Read-only for now; the CAMERA pills in the bar above are what write a
 * segment, and flying the free camera writes one too.
 *
 * The segment maths lives here with the row rather than in the chrome,
 * because the CAMERA POS lane's hatching is derived from the SAME list the
 * bar draws -- that is what makes it impossible for the hatching and the bar
 * to disagree about where a mode starts.
 */

import type { CameraSegment, PlaybackCamera, Timeline } from '../../playback/timeline.js';

export interface ModeRow {
  /** The whole `.ob-pb-track` row, for the chrome to append FIRST. */
  readonly element: HTMLElement;
  render(): void;
  /** The camera at `time`, by exactly the rule the session draws with. */
  modeAt(time: number): PlaybackCamera;
  /**
   * The spans a CAMERA POS lane is hatched over: everywhere the camera is not
   * FREE.
   *
   * Derived from the same segment list the row above draws, so the hatching
   * and the bar can never disagree about where a mode starts.
   */
  hatchSpans(): { from: number; to: number }[];
}

export interface ModeRowOptions {
  timeline: Timeline;
  duration: number;
  /** The clip's own default, for a first segment that starts after zero. */
  defaultCamera: PlaybackCamera;
  /** Whatever camera is live right now -- see `segments`. */
  liveCamera(): PlaybackCamera;
  frac(ms: number): number;
  pct(ms: number): string;
}

export function createModeRow(options: ModeRowOptions): ModeRow {
  const { timeline, duration, defaultCamera, liveCamera, frac, pct } = options;

  const element = document.createElement('div');
  element.className = 'ob-pb-track';
  const name = document.createElement('span');
  name.className = 'ob-pb-track-name fixed';
  name.textContent = 'CAMERA MODE';
  const bars = document.createElement('div');
  bars.className = 'ob-pb-modes';
  bars.title =
    'Which camera is active over time. The CAMERA buttons above cut to one at the playhead';
  const value = document.createElement('div');
  value.className = 'ob-pb-track-value';
  value.textContent = 'mode';
  value.title = 'FPV / FREE / CHASE / SIDE';
  element.append(name, bars, value);

  /**
   * The segments to DRAW, which is not quite `timeline.cameras`.
   *
   * An empty list means "no cuts", and the session resolves that to whatever
   * camera is live rather than to the clip's default -- `timeline.cameras.
   * length > 0 ? state.camera : camera` in `playback-session.ts`. So an empty
   * list is one segment spanning the whole clip, and the row agrees with the
   * picture instead of announcing a mode the viewer is not looking at.
   *
   * A first segment that starts after zero gets a head segment of the clip's
   * own default, which is what `evaluateCamera` falls back to there.
   */
  const segments = (): CameraSegment[] => {
    if (timeline.cameras.length === 0) {
      return [{ time: 0, camera: liveCamera() }];
    }
    const head = timeline.cameras[0];
    return head.time > 0
      ? [{ time: 0, camera: defaultCamera }, ...timeline.cameras]
      : [...timeline.cameras];
  };

  return {
    element,
    render(): void {
      bars.innerHTML = '';
      const list = segments();
      list.forEach((segment, i) => {
        const next: CameraSegment | undefined = list[i + 1];
        const band = document.createElement('div');
        // The mode's own class carries its tint -- see the `.ob-pb-mode` rules.
        band.className = `ob-pb-mode ${segment.camera}${next ? ' cut' : ''}`;
        band.style.left = pct(segment.time);
        band.style.right = next ? `${(100 - frac(next.time) * 100).toFixed(4)}%` : '0';
        band.textContent = segment.camera.toUpperCase();
        bars.appendChild(band);
        if (i > 0) {
          const cut = document.createElement('div');
          cut.className = 'ob-pb-cut';
          cut.style.left = pct(segment.time);
          bars.appendChild(cut);
        }
      });
    },
    modeAt(time: number): PlaybackCamera {
      const list = segments();
      let current = list[0].camera;
      for (const segment of list) {
        if (segment.time > time) {
          break;
        }
        current = segment.camera;
      }
      return current;
    },
    hatchSpans(): { from: number; to: number }[] {
      const list = segments();
      const spans: { from: number; to: number }[] = [];
      list.forEach((segment, i) => {
        if (segment.camera !== 'free') {
          const next: CameraSegment | undefined = list[i + 1];
          spans.push({ from: segment.time, to: next ? next.time : duration });
        }
      });
      return spans;
    },
  };
}
