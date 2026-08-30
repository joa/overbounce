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
 * That claim has not changed. What changed on 2026-08-30 is the evidence under
 * it. **Every constant in this file was read out of CPMA 1.53's own shipped VM
 * bytecode**, along with the branch conditions and the order the branches run
 * in — see `.agent/docs/cpma-constants.md`, which gives the address each number
 * came from, and `.agent/plans/CPMA-REVERSE-ENG.md` for why that is allowed and
 * where the line is. Reading a stripped binary is not reading a source, so the
 * paragraph above still stands; the numbers are simply no longer guesses.
 *
 * Warsow / qfusion `gs_pmove.cpp` (GPLv2) is where the *shape* of this module
 * came from, and it got three things wrong about CPM that the bytecode
 * corrected: air control runs BEFORE accelerating rather than after, the
 * strafe and air-control branches are selected by `ps.movementDir` rather than
 * by the command directly, and the ramp jump does not clip against the ground
 * plane at all. Its `pm_aircontrol = 150`, `pm_strafebunnyaccel = 70` and
 * `pm_wishspeed = 30` did turn out to be right.
 *
 * Ramp jump and double jump are NOT in this file. Both are a branch inside
 * `PM_CheckJump`, not `PM_AirMove` — the split this module exists to isolate —
 * so they live as `pmCpmJump` in `pmove.ts`, next to the VQ3 jump they replace,
 * the same way that file's CPM branch in `pmAirMove` calls back into this one.
 * Their constants are here, with the rest.
 */

import { dotProduct, vec3, vectorNormalize } from '../math/vec3.js';
import type { Vec3 } from '../math/vec3.js';
import type { PmoveContext, PmoveLocal } from './types.js';

const fround = Math.fround;

/**
 * Inertia-to-forward conversion rate.
 *
 * CPMA does not compile this one in: it lives in a per-physics-mode settings
 * table, at the offset `PM_Aircontrol` multiplies by and `PM_AirMove` tests
 * against zero to decide whether to run the CPM branch at all. VQ3's row holds
 * 0 there, which is exactly how CPMA's VQ3 mode stays VQ3, and CPM's row holds
 * 150 — inherited from the `PMC` row it is copied from.
 */
export const AIR_CONTROL = 150;

/**
 * Air acceleration while strafing with no forward input — the number that makes
 * CPM's "+strafe" turning work.
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
 * This was the open question the whole bytecode exercise existed to settle:
 * Warsow's equivalent is 2.0, retuned for its own game, while CPM was
 * consistently *documented* as 2.5, and the two had been reconciled by
 * judgement. CPMA stores 2.5, next to `WISH_SPEED` and `STRAFE_ACCELERATE` in
 * the same block of compiled-in floats, read by exactly one function.
 */
export const AIR_STOP_ACCELERATE = 2.5;

/**
 * Ground acceleration in CPM, replacing VQ3's `pm_accelerate` of 10.
 *
 * Another settings-table field: VQ3's row holds 10, CPM's holds 15. This one
 * was simply missing before — CPM mode accelerated on the ground exactly like
 * VQ3, which is wrong and is felt on every start from a standstill.
 */
export const CPM_ACCELERATE = 15;

/**
 * CPM's jump velocity, replacing VQ3's `JUMP_VELOCITY` of 270.
 *
 * CPMA jumps at 275 in *every* mode it ships, its own VQ3 included. We keep
 * 270 for VQ3 regardless: our VQ3 reference is id's source, where 270 is
 * verified, and CPMA's emulation of VQ3 is not that reference. So 275 applies
 * to the CPM path only, which is the one place CPMA is the authority.
 */
export const CPM_JUMP_VELOCITY = 275;

/**
 * Added to `velocity[2]` by a double jump, on top of the jump itself.
 *
 * A flat bonus, not a multiplier and not a re-application of jump velocity, so
 * a double jump leaves the ground at 380.
 */
export const CPM_DOUBLE_JUMP_VELOCITY = 105;

/**
 * How long after a jump a second one still counts as a double jump, in
 * milliseconds.
 *
 * The window is measured from the previous *jump*, not from landing — nothing
 * resets it on touching the ground, it only counts down. Jump, land, and jump
 * again inside 400ms and the second jump is a double jump; dawdle on the ground
 * and it is an ordinary one.
 */
export const CPM_DOUBLE_JUMP_TIME = 400;

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
 *    VQ3 "hold strafe and wiggle". CPMA spells this as "`movementDir` is 0 or
 *    4", the two directions `PM_SetMovementDir` assigns when `rightmove` is
 *    zero, and that is what is written here — the same test, from the field
 *    that actually carries it.
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
  if ((pm.ps.movementDir !== 0 && pm.ps.movementDir !== 4) || wishspeed === 0) {
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
}

/**
 * Decide how a CPM air frame accelerates.
 *
 * Split out from the move itself so it can be tested without a world, and so
 * `PM_AirMove` keeps the shape of the C it is a port of.
 *
 * **Call this AFTER air control, never before.** CPMA runs air control first
 * and then takes this dot product, so the velocity being tested is the one air
 * control has already rotated — which is not a detail, because air control's
 * whole job is to swing velocity toward wishdir, and it can swing a dot product
 * from negative to positive within a single frame. Getting the order backwards
 * (which is what Warsow does, and what this port did until the bytecode said
 * otherwise) hands `PM_Accelerate` 2.5 on frames where CPMA hands it 1.
 *
 * The wishspeed clamp is the other subtle part: the strafe branch clamps to 30
 * before accelerating, and air control ran on the *unclamped* value. Clamp
 * before air control and air control barely does anything.
 */
export function cpmAirParams(
  pm: PmoveContext,
  wishdir: Vec3,
  wishspeed: number,
): CpmAirParams {
  let accel: number;

  // Pushing against your own velocity decelerates hard -- this is what lets a
  // CPM player stop in mid-air, and it has no VQ3 equivalent.
  if (dotProduct(pm.ps.velocity, wishdir) < 0) {
    accel = AIR_STOP_ACCELERATE;
  } else {
    accel = 1; // pm_airaccelerate
  }

  // Strafe-only: the +strafe bunnyhop branch. `movementDir` 2 and 6 are the
  // two directions PM_SetMovementDir assigns for `rightmove != 0` with no
  // forward input, which is how CPMA tests for this.
  if (pm.ps.movementDir === 2 || pm.ps.movementDir === 6) {
    if (wishspeed > WISH_SPEED) {
      wishspeed = WISH_SPEED;
    }
    accel = STRAFE_ACCELERATE;
  }

  return { accel, wishspeed };
}

/** A neutral wishdir for callers that need one. */
export function zeroDir(): Vec3 {
  return vec3();
}
