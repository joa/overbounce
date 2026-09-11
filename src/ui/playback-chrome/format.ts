/**
 * Clock and span strings for the playback screen.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `formatClock` is re-exported from `playback-chrome.ts`, which is where the
 * rest of the app and `test/ui/playback-clock.test.ts` import it from. It
 * lives here because it is the one piece of that file that is a pure function
 * of its argument, and a pure function is worth being able to read without
 * the 700 lines of DOM around it.
 */

/**
 * `0:23.6`, the frame's own format: minutes, seconds, one decimal.
 *
 * Deliberately NOT `hud.ts`'s `formatTime`, which prints three decimals
 * because a run time is a record. A scrub position is a place in a video and
 * a tenth is what a viewer can act on; three would jitter every frame.
 */
export function formatClock(ms: number): string {
  // Rounded to tenths BEFORE the minutes are split off, not after. Splitting
  // first and rounding the remainder prints `0:60.0` for anything from
  // 59.95s up, because the seconds round into a minute the minutes field has
  // already been computed without.
  const tenths = Math.round(Math.max(0, ms) / 100);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** `43.8s`, for the export range summary. */
export function formatSpan(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}
