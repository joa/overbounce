/**
 * Test helper: run a simulation until the player comes to rest.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import type { Simulation } from '../src/physics/simulate.js';

/**
 * Step until the player is on the ground and has stopped moving vertically.
 *
 * Do NOT test `velocity[2] === 0` for this. A resting player's vertical
 * velocity is often a small nonzero integer, and legitimately so:
 *
 *   1. PM_ClipVelocity's OVERCLIP asymmetry leaves a residual of `-0.001 * vz`
 *      pointing away from the surface when a fall is absorbed.
 *   2. SnapVector rounds that to the nearest integer: a landing at -408ups
 *      leaves 0.408 -> 0, but -558ups leaves 0.558 -> 1.
 *   3. PM_Friction cannot remove it. Its `speed < 1` early-out measures
 *      HORIZONTAL speed only (vec[2] = 0 while walking) and returns before the
 *      drop maths, zeroing vel[0] and vel[1] and leaving vz untouched.
 *   4. PM_WalkMove's rescale reproduces exactly that value every frame, and the
 *      standing-still guard skips the move.
 *
 * So vz = 1 is a genuine fixed point. The player is at rest; the number just is
 * not zero.
 *
 * Settling is therefore defined by the origin no longer changing.
 */
export function settle(sim: Simulation, maxTicks = 600): boolean {
  let prevZ = sim.ps.origin[2];

  for (let i = 0; i < maxTicks; i++) {
    sim.step({});
    const z = sim.ps.origin[2];
    if (sim.onGround && Math.abs(z - prevZ) < 1e-4 && i > 0) {
      return true;
    }
    prevZ = z;
  }

  return false;
}
