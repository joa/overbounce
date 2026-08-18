/**
 * Challenge ProMode air movement.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * READ THIS BEFORE TRUSTING ANYTHING HERE.
 *
 * Every other file in `physics/` is a port of id Software's GPL'd source, and
 * carries a fidelity guarantee because the original is readable. This one does
 * not. **CPMA's game code is closed source.** There is no C to diff against, so
 * "CPM mode" here is faithful to community-documented CPM behaviour and is not,
 * and cannot be, a verified 1:1 port. VQ3 remains the mode with the guarantee,
 * and anything comparing Overbounce times to real CPMA times should say so.
 *
 * What it IS derived from, in order of authority:
 *
 *  1. Warsow / qfusion `source/common/facilities/gs_pmove.cpp` (GPLv2). This is
 *     where `PM_Aircontrol`, the `wishspeed2` split and the strafe-only branch
 *     come from, and it is real readable source rather than recollection. Its
 *     constants `pm_aircontrol = 150`, `pm_strafebunnyaccel = 70` and
 *     `pm_wishspeed = 30` match the community-documented CPM values exactly.
 *  2. Community documentation for the one constant where Warsow deliberately
 *     differs — see AIR_STOP_ACCELERATE below.
 *
 * Deliberately NOT implemented, rather than guessed at: CPM double jump and
 * ramp/slope boosting. Both are real CPM features, and both are described in
 * the community only in prose, with no source and no agreed numbers. Adding a
 * plausible-looking version would make the mode feel more complete while making
 * it less honest, and would be indistinguishable from correct until someone
 * compared a run against real CPMA. They are absent on purpose.
 */

import { dotProduct, vec3, vectorNormalize } from '../math/vec3.js';
import type { Vec3 } from '../math/vec3.js';
import type { PmoveContext, PmoveLocal } from './types.js';

const fround = Math.fround;

/**
 * Inertia-to-forward conversion rate. From Warsow's `pm_aircontrol`, and the
 * value the CPM community documents.
 */
export const AIR_CONTROL = 150;

/**
 * Air acceleration while strafing with no forward input — the number that makes
 * CPM's "+strafe" turning work. Warsow's `pm_strafebunnyaccel`.
 */
export const STRAFE_ACCELERATE = 70;

/**
 * wishspeed is clamped to this while strafe-only. Warsow's `pm_wishspeed`.
 *
 * This tiny cap is the whole trick: acceleration is applied toward `wishdir`
 * only up to 30ups, so strafing cannot add much speed directly. What it does
 * instead is turn the velocity vector, and PM_Aircontrol then converts that
 * turn back into forward speed.
 */
export const WISH_SPEED = 30;

/**
 * Acceleration used when the player is pushing *against* their own velocity.
 *
 * The one number not taken from Warsow. Warsow's equivalent
 * (`pm_airdecelerate`) is 2.0, retuned for its own game; CPM is consistently
 * documented as 2.5, and this mode's job is to feel like CPM rather than like
 * Warsow. Flagged rather than silently reconciled, because it is exactly the
 * kind of difference that is invisible until someone compares a real run.
 */
export const AIR_STOP_ACCELERATE = 2.5;

/**
 * `PM_Aircontrol` — convert sideways inertia into forward speed.
 *
 * This is the mechanic that separates CPM from VQ3. VQ3 gives you speed by
 * accelerating toward a direction slightly off your velocity, and the gain is a
 * side effect of the maxspeed bug. CPM instead lets you *steer*: point where you
 * are already going, and the vector is rotated toward your aim while its length
 * is preserved.
 *
 * Two properties are worth naming because they are what makes it feel the way
 * it does:
 *
 *  - It returns immediately if the player is holding any strafe key. Air control
 *    is a forward-only mechanic; the strafe keys are what the *other* branch
 *    uses. That is why CPM movement is "+forward and mouse" rather than the
 *    VQ3 "hold strafe and wiggle".
 *  - The turn rate goes as `dot * dot`, so it is strongest when you are already
 *    pointing nearly where you are going and falls off fast as you turn away.
 *    You cannot whip the vector around; you can only bend it.
 *
 * Speed is captured before the turn and reapplied after, so this function
 * changes direction and never magnitude. Vertical velocity is set aside and
 * restored untouched.
 */
export function airControl(
  pm: PmoveContext,
  pml: PmoveLocal,
  wishdir: Vec3,
  wishspeed: number,
): void {
  // can't control movement if not moving forward or backward
  if (pm.cmd.rightmove !== 0 || wishspeed === 0) {
    return;
  }

  const zspeed = pm.ps.velocity[2];
  pm.ps.velocity[2] = 0;
  const speed = vectorNormalize(pm.ps.velocity);

  const dot = dotProduct(pm.ps.velocity, wishdir);
  const k = fround(fround(fround(32 * AIR_CONTROL) * fround(dot * dot)) * pml.frametime);

  if (dot > 0) {
    // we can't change direction while slowing down
    for (let i = 0; i < 2; i++) {
      pm.ps.velocity[i] = fround(
        fround(pm.ps.velocity[i] * speed) + fround(wishdir[i] * k),
      );
    }
    vectorNormalize(pm.ps.velocity);
  }

  for (let i = 0; i < 2; i++) {
    pm.ps.velocity[i] = fround(pm.ps.velocity[i] * speed);
  }

  pm.ps.velocity[2] = zspeed;
}

export interface CpmAirParams {
  /** Acceleration to hand to PM_Accelerate. */
  accel: number;
  /** wishspeed to hand to PM_Accelerate, possibly clamped. */
  wishspeed: number;
  /** The UNCLAMPED wishspeed, which is what air control uses. */
  wishspeed2: number;
  /** Whether to run air control after accelerating. */
  aircontrol: boolean;
}

/**
 * Decide how a CPM air frame accelerates.
 *
 * Split out from the move itself so it can be tested without a world, and so
 * `PM_AirMove` keeps the shape of the C it is a port of.
 *
 * The `wishspeed2` split is the subtle part and is easy to lose: the strafe
 * branch clamps wishspeed to 30 before accelerating, but air control is handed
 * the *original* value. Clamp both and air control barely does anything.
 */
export function cpmAirParams(
  pm: PmoveContext,
  wishdir: Vec3,
  wishspeed: number,
): CpmAirParams {
  const fmove = pm.cmd.forwardmove;
  const smove = pm.cmd.rightmove;

  const wishspeed2 = wishspeed;
  let accel: number;

  // Pushing against your own velocity decelerates hard -- this is what lets a
  // CPM player stop in mid-air, and it has no VQ3 equivalent.
  if (dotProduct(pm.ps.velocity, wishdir) < 0) {
    accel = AIR_STOP_ACCELERATE;
  } else {
    accel = 1; // pm_airaccelerate
  }

  // Strafe-only: the +strafe bunnyhop branch.
  if (smove !== 0 && fmove === 0) {
    if (wishspeed > WISH_SPEED) {
      wishspeed = WISH_SPEED;
    }
    accel = STRAFE_ACCELERATE;
  }

  return {
    accel,
    wishspeed,
    wishspeed2,
    // Air control is forward-only; airControl itself re-checks this, but
    // saying it here keeps the branch readable at the call site.
    aircontrol: smove === 0 && fmove !== 0,
  };
}

/** A neutral wishdir for callers that need one. */
export function zeroDir(): Vec3 {
  return vec3();
}
