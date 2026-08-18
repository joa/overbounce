/**
 * How well the player is strafing.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Quake's air acceleration only adds speed while the angle between your
 * velocity and your wish direction is inside a window that NARROWS as you go
 * faster. That window is the entire skill of strafe jumping, and it is
 * invisible: nothing on screen tells you where it is, so players learn it by
 * feel over months.
 *
 * This computes it exactly, from the same numbers `PM_Accelerate` uses.
 *
 * ## The maths
 *
 * `PM_Accelerate` (the `#if 1` q2-style branch Overbounce ports) does:
 *
 *     currentspeed = velocity . wishdir
 *     addspeed     = wishspeed - currentspeed
 *     if (addspeed <= 0) return
 *     accelspeed   = accel * frametime * wishspeed   (capped to addspeed)
 *     velocity    += accelspeed * wishdir
 *
 * So speed is gained only while `velocity . wishdir < wishspeed`. With
 * `|velocity| = v` and the angle between them `theta`, that is
 * `v * cos(theta) < wishspeed`, i.e.
 *
 *     theta > acos(wishspeed / v)
 *
 * and the *optimal* angle is the one that maximises the resulting speed:
 * accelerate exactly perpendicular to the gain threshold, which works out to
 *
 *     theta_opt = acos((wishspeed - accelspeed) / v)   ... clamped
 *
 * Below `wishspeed` there is no threshold at all — any direction gains — which
 * is why the indicator has nothing useful to say at low speed and says so.
 */

import { pm_airaccelerate, PMOVE_MSEC } from '../physics/constants.js';

export interface StrafeAdvice {
  /** Horizontal speed, units per second. */
  speed: number;
  /**
   * Smallest angle from the velocity, in degrees, that still gains speed.
   * Null below `wishspeed`, where every direction gains.
   */
  minGainAngle: number | null;
  /** The angle that gains the most this tick, in degrees. Null below wishspeed. */
  optimalAngle: number | null;
  /** Where the player is actually accelerating, in degrees from velocity. */
  currentAngle: number;
  /** Speed this tick would add at the current angle, in units per second. */
  gain: number;
  /** Speed the optimal angle would add. */
  bestGain: number;
  /** `gain / bestGain`, 0..1. 1 means perfect. Null when there is nothing to optimise. */
  efficiency: number | null;
}

export interface StrafeInput {
  /** Horizontal velocity. */
  vx: number;
  vy: number;
  /** Normalised horizontal wish direction. */
  wishX: number;
  wishY: number;
  /** `wishspeed` after PM_CmdScale, before the CPM clamp. */
  wishspeed: number;
  /** Seconds per tick. */
  frametime?: number;
  /** `pm_airaccelerate`, or the CPM value when strafing. */
  accel?: number;
}

/** How much `PM_Accelerate` would add along `wishdir`, in ups. */
function accelerateGain(
  speedAlongWish: number,
  wishspeed: number,
  accel: number,
  frametime: number,
): number {
  const addspeed = wishspeed - speedAlongWish;
  if (addspeed <= 0) {
    return 0;
  }
  let accelspeed = accel * frametime * wishspeed;
  if (accelspeed > addspeed) {
    accelspeed = addspeed;
  }
  return accelspeed;
}

/**
 * Evaluate the current strafe.
 *
 * `gain` is the speed added *along the wish direction*, which is not the same
 * as the speed the player ends up with: adding sideways lengthens the vector by
 * less than it adds. The efficiency ratio is computed on the resulting speed
 * for that reason, not on the raw accelspeed.
 */
export function strafeAdvice(input: StrafeInput): StrafeAdvice {
  const frametime = input.frametime ?? PMOVE_MSEC / 1000;
  const accel = input.accel ?? pm_airaccelerate;

  const speed = Math.hypot(input.vx, input.vy);
  const wishspeed = input.wishspeed;

  // Angle between velocity and wishdir.
  let currentAngle = 0;
  if (speed > 0.001) {
    const dot = (input.vx * input.wishX + input.vy * input.wishY) / speed;
    currentAngle = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
  }

  /** Resulting speed if we accelerate at `theta` degrees off the velocity. */
  const speedAfter = (thetaDeg: number): number => {
    const t = (thetaDeg * Math.PI) / 180;
    const along = speed * Math.cos(t);
    const added = accelerateGain(along, wishspeed, accel, frametime);
    // The new vector is (velocity) + added * wishdir; its length by the cosine
    // rule, with `added` at angle theta to the velocity.
    return Math.sqrt(speed * speed + added * added + 2 * speed * added * Math.cos(t));
  };

  const gain = speedAfter(currentAngle) - speed;

  // Below wishspeed every direction gains, so there is no threshold to show.
  if (speed <= wishspeed || wishspeed <= 0) {
    return {
      speed,
      minGainAngle: null,
      optimalAngle: null,
      currentAngle,
      gain,
      bestGain: gain,
      efficiency: null,
    };
  }

  // acos(wishspeed / speed): below this angle, addspeed <= 0 and nothing is
  // gained however hard you hold the key.
  const minGainAngle = (Math.acos(Math.min(1, wishspeed / speed)) * 180) / Math.PI;

  // The optimum is just past the threshold, where accelspeed is still full but
  // the vector is as aligned as it can be. Found by scanning rather than
  // solved: the closed form has to special-case the accelspeed cap, and a
  // 0.25-degree scan is exact enough to steer by and impossible to get wrong.
  let optimalAngle = minGainAngle;
  let best = speedAfter(minGainAngle);
  for (let a = minGainAngle; a <= 90; a += 0.25) {
    const s = speedAfter(a);
    if (s > best) {
      best = s;
      optimalAngle = a;
    }
  }

  const bestGain = best - speed;
  return {
    speed,
    minGainAngle,
    optimalAngle,
    currentAngle,
    gain,
    bestGain,
    efficiency: bestGain > 1e-6 ? Math.max(0, gain / bestGain) : null,
  };
}
