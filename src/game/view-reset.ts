/**
 * Where "reset view" points the player.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Not a Quake feature. It exists because the courses are side-locked and the
 * mouse is not: a `.cam` `"lock" "y 0"` pins the player's POSITION on the
 * depth axis (`side-locked-courses.md`), but yaw is a free 360 degrees, so a
 * player who turns toward the camera finds that W and S push along the locked
 * axis and go nowhere. Reported by the first outside player
 * (`.agent/docs/first-bug-report.md`); the owner chose a key that snaps the
 * view back, bound to B and Q.
 *
 * Nothing here touches pmove. A reset is a large mouse turn: `main.ts` writes
 * the result into the input accumulator with `setView`, and the next usercmd
 * carries it through `ANGLE2SHORT` like any other angle. `delta_angles` is 0
 * during play (`respawn.ts` explains why), so the angle sent is the angle
 * pmove ends up with, and a ghost replays the turn from its usercmds.
 */

/** Only the axis matters here; `Game`'s lock carries its value too. */
export interface ViewResetLock {
  axis: 0 | 1 | 2;
}

/**
 * The yaw, in degrees, a reset turns to.
 *
 * - **Locked on y** (every `ob_*` course): the course runs along X, so
 *   forward is 0 or 180 degrees, whichever is NEARER the current yaw. A player
 *   running a leg toward -X is turned back along that leg, not spun around.
 *   Exactly 90 degrees off from both picks 0, the direction every course
 *   spawns facing.
 * - **Locked on x**: the same along Y, 90 or 270.
 * - **No lock, or a z lock** (which leaves no scroll axis): the spawn's own
 *   facing, the one forward a map states.
 *
 * `yaw` may be any accumulated value (the input layer never wraps it); the
 * answer is always in [0, 360).
 */
export function resetViewYaw(yaw: number, lock: ViewResetLock | null, spawnYaw: number): number {
  if (!lock || lock.axis === 2) {
    return wrap360(spawnYaw);
  }
  const forward = lock.axis === 1 ? 0 : 90;
  const backward = forward + 180;
  return Math.abs(angleDelta(yaw, forward)) <= Math.abs(angleDelta(yaw, backward))
    ? forward
    : backward;
}

/** Signed shortest turn from `from` to `to`, in (-180, 180]. */
function angleDelta(from: number, to: number): number {
  const d = wrap360(to - from);
  return d > 180 ? d - 360 : d;
}

function wrap360(a: number): number {
  return ((a % 360) + 360) % 360;
}
