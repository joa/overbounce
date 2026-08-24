/**
 * Ported from Quake III Arena's code/game/bg_pmove.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Takes a playerState and a usercmd as input and returns a modified
 * playerState.
 *
 * WHAT IS AND IS NOT PORTED
 *
 * Ported in full, because it affects movement: friction, acceleration, command
 * scaling, jumping, air and walk moves, ground tracing, duck handling, water
 * levels and water movement, crash landing, timers, and view angle updating.
 *
 * Deliberately omitted, because Overbounce has no items and no combat:
 *   - PM_FlyMove and the PW_FLIGHT powerup (and its friction term)
 *   - PM_GrappleMove and PMF_GRAPPLE_PULL
 *   - PM_InvulnerabilityMove and the invulnerability bbox in PM_CheckDuck
 *   - PM_SPECTATOR handling and pm_spectatorfriction
 *   - PM_Weapon, PM_TorsoAnimation, PM_Animate, PM_WaterEvents
 *
 * PM_Footsteps and the legs-animation calls interleaved through the movement
 * functions ARE ported; see anim.ts. PM_Weapon and the torso animations that
 * live inside it are not, since Overbounce has no weapon state machine.
 *
 * Animation and sound are outputs: legsAnim, torsoAnim and bobCycle are written
 * and never read back, so none of it feeds into movement. If spectator or flight movement is ever needed, the omitted
 * friction terms in PM_Friction must be restored along with it.
 *
 * ONE FUNCTION HERE IS NOT FROM bg_pmove.c: `pmCpmJump`, `pmCheckJump`'s CPM
 * branch (ramp jump + double jump). Everything else in this file carries the
 * same fidelity guarantee as the rest of `physics/`; that one function does
 * not -- see its own header, and `cpm.ts`'s, for what it is actually sourced
 * from and why.
 */

import {
  vec3,
  vectorClear,
  vectorCopy,
  vectorLength,
  vectorMA,
  vectorNormalize,
  vectorScale,
  dotProduct,
  PITCH,
} from '../math/vec3.js';
import { angleVectors, short2angle, toShort } from '../math/angles.js';
import { airControl, cpmAirParams } from './cpm.js';
import {
  Anim,
  continueLegsAnim,
  forceLegsAnim,
} from './anim.js';
import {
  BUTTON_ATTACK,
  BUTTON_USE_HOLDABLE,
  BUTTON_WALKING,
  CROUCH_VIEWHEIGHT,
  DEAD_VIEWHEIGHT,
  DEFAULT_VIEWHEIGHT,
  ENTITYNUM_NONE,
  JUMP_VELOCITY,
  MASK_WATER,
  MINS_Z,
  MIN_WALK_NORMAL,
  OVERCLIP,
  PMF_ALL_TIMES,
  PMF_BACKWARDS_JUMP,
  PMF_BACKWARDS_RUN,
  PMF_DUCKED,
  PMF_JUMP_HELD,
  PMF_RESPAWNED,
  PMF_TIME_KNOCKBACK,
  PMF_TIME_LAND,
  PMF_TIME_WATERJUMP,
  PmType,
  SURF_METALSTEPS,
  SURF_NODAMAGE,
  SURF_NOSTEPS,
  SURF_SLICK,
  TIMER_LAND,
  pm_accelerate,
  pm_airaccelerate,
  pm_friction,
  pm_stopspeed,
  pm_swimScale,
  pm_wateraccelerate,
  pm_waterfriction,
  pm_duckScale,
} from './constants.js';
import { addEvent, clipVelocity } from './pm-common.js';
import { slideMove, stepSlideMove } from './slidemove.js';
import { PhysicsMode, PmEvent, createTrace } from './types.js';
import type { PmoveContext, PmoveLocal, PlayerState, UserCmd } from './types.js';
import { createPmoveLocal, copyTrace } from './types.js';

const fround = Math.fround;

/**
 * `SnapVector`, applied to velocity at the end of every movement frame.
 *
 * This is not cosmetic: velocity is quantized to integers 125 times a second,
 * so fractional speed can never accumulate, and the exact rounding rule changes
 * where overbounce lands.
 *
 * UNRESOLVED: the game VM calls `trap_SnapVector`, a syscall into the engine,
 * and the engine half of Quake III was never released in this repository. The
 * `SnapVector` macro visible in q_shared.h truncates toward zero, while the
 * engine's implementation used the x87 `fistp` instruction, which rounds to
 * nearest with ties to even. We default to round-half-to-even, matching the
 * engine, and keep truncation available for comparison. Confirm against a real
 * Q3/defrag client before treating any overbounce coordinate as authoritative.
 */
export type SnapMode = 'nearest-even' | 'truncate';

export let snapMode: SnapMode = 'nearest-even';

export function setSnapMode(mode: SnapMode): void {
  snapMode = mode;
}

function snapToInt(x: number): number {
  if (snapMode === 'truncate') {
    return Math.trunc(x);
  }
  // Round half to even, matching the default IEEE rounding mode.
  const r = Math.round(x);
  if (Math.abs(x - Math.trunc(x)) === 0.5) {
    return r % 2 === 0 ? r : r - 1;
  }
  return r;
}

export function snapVector(v: Float32Array): void {
  v[0] = snapToInt(v[0]);
  v[1] = snapToInt(v[1]);
  v[2] = snapToInt(v[2]);
}

/*
=============
PM_Friction

Handles both ground friction and water friction
=============
*/
function pmFriction(pm: PmoveContext, pml: PmoveLocal): void {
  const vel = pm.ps.velocity;
  const vec = vec3(vel[0], vel[1], vel[2]);

  if (pml.walking) {
    vec[2] = 0; // ignore slope movement
  }

  const speed = vectorLength(vec);
  if (speed < 1) {
    vel[0] = 0;
    vel[1] = 0; // allow sinking underwater
    return;
  }

  let drop = 0;

  // apply ground friction
  if (pm.waterlevel <= 1) {
    if (pml.walking && !(pml.groundTrace.surfaceFlags & SURF_SLICK)) {
      // if getting knocked back, no friction
      if (!(pm.ps.pm_flags & PMF_TIME_KNOCKBACK)) {
        const control = speed < pm_stopspeed ? pm_stopspeed : speed;
        drop = fround(drop + fround(fround(control * pm_friction) * pml.frametime));
      }
    }
  }

  // apply water friction even if just wading
  if (pm.waterlevel) {
    drop = fround(
      drop +
        fround(
          fround(fround(speed * pm_waterfriction) * pm.waterlevel) * pml.frametime,
        ),
    );
  }

  // scale the velocity
  let newspeed = fround(speed - drop);
  if (newspeed < 0) {
    newspeed = 0;
  }
  newspeed = fround(newspeed / speed);

  vel[0] = vel[0] * newspeed;
  vel[1] = vel[1] * newspeed;
  vel[2] = vel[2] * newspeed;
}

/*
=============
PM_Accelerate

Handles user intended acceleration.
=============

This is the `#if 1` "q2 style" branch of the original. id's alternative
implementation is guarded by `#else` and annotated:

    // proper way (avoids strafe jump maxspeed bug), but feels bad

Acceleration is applied along `wishdir` only in proportion to how much speed is
still missing ALONG THAT DIRECTION. Velocity perpendicular to `wishdir` is never
counted, so by continuously rotating `wishdir` a player adds speed indefinitely
without ever reaching the `wishspeed` cap. That is strafe jumping, and it is the
reason this branch must never be replaced with the "proper" one.
*/
function pmAccelerate(
  pm: PmoveContext,
  pml: PmoveLocal,
  wishdir: Float32Array,
  wishspeed: number,
  accel: number,
): void {
  const currentspeed = dotProduct(pm.ps.velocity, wishdir);
  const addspeed = fround(wishspeed - currentspeed);
  if (addspeed <= 0) {
    return;
  }
  let accelspeed = fround(fround(accel * pml.frametime) * wishspeed);
  if (accelspeed > addspeed) {
    accelspeed = addspeed;
  }

  for (let i = 0; i < 3; i++) {
    pm.ps.velocity[i] = pm.ps.velocity[i] + fround(accelspeed * wishdir[i]);
  }
}

/*
============
PM_CmdScale

Returns the scale factor to apply to cmd movements.
This allows the clients to use axial -127 to 127 values for all directions
without getting a sqrt(2) distortion in speed.
============
*/
function pmCmdScale(pm: PmoveContext, cmd: UserCmd): number {
  let max = Math.abs(cmd.forwardmove);
  if (Math.abs(cmd.rightmove) > max) {
    max = Math.abs(cmd.rightmove);
  }
  if (Math.abs(cmd.upmove) > max) {
    max = Math.abs(cmd.upmove);
  }
  if (!max) {
    return 0;
  }

  const total = fround(
    Math.sqrt(
      cmd.forwardmove * cmd.forwardmove +
        cmd.rightmove * cmd.rightmove +
        cmd.upmove * cmd.upmove,
    ),
  );
  // `(float)speed * max` is float arithmetic; `127.0 * total` promotes to double.
  return fround(fround(pm.ps.speed * max) / (127.0 * total));
}

/*
================
PM_SetMovementDir
================
*/
function pmSetMovementDir(pm: PmoveContext): void {
  const { cmd, ps } = pm;
  if (cmd.forwardmove || cmd.rightmove) {
    if (cmd.rightmove === 0 && cmd.forwardmove > 0) {
      ps.movementDir = 0;
    } else if (cmd.rightmove < 0 && cmd.forwardmove > 0) {
      ps.movementDir = 1;
    } else if (cmd.rightmove < 0 && cmd.forwardmove === 0) {
      ps.movementDir = 2;
    } else if (cmd.rightmove < 0 && cmd.forwardmove < 0) {
      ps.movementDir = 3;
    } else if (cmd.rightmove === 0 && cmd.forwardmove < 0) {
      ps.movementDir = 4;
    } else if (cmd.rightmove > 0 && cmd.forwardmove < 0) {
      ps.movementDir = 5;
    } else if (cmd.rightmove > 0 && cmd.forwardmove === 0) {
      ps.movementDir = 6;
    } else if (cmd.rightmove > 0 && cmd.forwardmove > 0) {
      ps.movementDir = 7;
    }
  } else {
    // if they aren't actively going directly sideways, change the animation to
    // the diagonal so they don't stop too crooked
    if (ps.movementDir === 2) {
      ps.movementDir = 1;
    } else if (ps.movementDir === 6) {
      ps.movementDir = 7;
    }
  }
}

/*
=============
PM_CheckJump
=============
*/
function pmCheckJump(pm: PmoveContext, pml: PmoveLocal): boolean {
  if (pm.ps.pm_flags & PMF_RESPAWNED) {
    return false; // don't allow jump until all buttons are up
  }

  if (pm.cmd.upmove < 10) {
    // not holding jump
    return false;
  }

  // must wait for jump to be released
  if (pm.ps.pm_flags & PMF_JUMP_HELD) {
    // clear upmove so cmdscale doesn't lower running speed
    pm.cmd.upmove = 0;
    return false;
  }

  pml.groundPlane = false; // jumping away
  pml.walking = false;
  pm.ps.pm_flags |= PMF_JUMP_HELD;

  pm.ps.groundEntityNum = ENTITYNUM_NONE;
  if (pm.physicsMode === PhysicsMode.CPM) {
    // CPM: ramp jump + double jump. See pmCpmJump.
    pmCpmJump(pm, pml);
  } else {
    // VQ3: velocity[2] is SET, not added to. A player still moving upward
    // when they jump has their upward speed clamped down to 270 -- this is
    // exactly the behaviour CPM's ramp/double jump below does NOT have.
    pm.ps.velocity[2] = JUMP_VELOCITY;
  }
  addEvent(pm, PmEvent.JUMP);

  if (pm.cmd.forwardmove >= 0) {
    forceLegsAnim(pm.ps, Anim.LEGS_JUMP);
    pm.ps.pm_flags &= ~PMF_BACKWARDS_JUMP;
  } else {
    forceLegsAnim(pm.ps, Anim.LEGS_JUMPB);
    pm.ps.pm_flags |= PMF_BACKWARDS_JUMP;
  }

  return true;
}

/**
 * CPM's ramp jump + double jump, structured after Warsow/qfusion's
 * `PM_CheckJump` (`gs_pmove.cpp`) -- see `cpm.ts`'s header for the standing
 * this file's numbers have (community-documented CPM behaviour, not a
 * verified CPMA port). Unlike vanilla Q3's unconditional `velocity[2] =
 * JUMP_VELOCITY` above, real CPM source does two things differently:
 *
 *  1. If moving down and into an upward-facing ground plane (running down a
 *     ramp toward its high side while still airborne enough to be falling),
 *     clip velocity against that plane first -- exactly `PM_ClipVelocity`
 *     with `OVERCLIP`, the same call every other surface clip in this port
 *     already uses. This is "ramp jump": the downward component becomes
 *     upward instead of being discarded by the jump that follows.
 *  2. If any upward velocity survives that (from the ramp clip, or simply
 *     from jumping again before a previous jump's arc has turned over),
 *     jump speed is ADDED rather than overwritten -- "double jump". Warsow
 *     fires a different sound event (`EV_DOUBLEJUMP`) above a 100ups
 *     threshold, but that threshold has no effect on velocity in its own
 *     source and this engine has no sound path here, so it is not ported.
 *
 * The clip factor is this project's own `OVERCLIP` (1.001), not Warsow's
 * retuned `PM_OVERBOUNCE` (1.01). Unlike `AIR_STOP_ACCELERATE`, this is not a
 * case of picking a *documented* CPM value over Warsow's retune -- no
 * independent CPM source gives a ramp-jump clip factor at all, documented or
 * otherwise. `OVERCLIP` is chosen for internal consistency (it is the
 * constant every other clip in this port already uses), not because a CPM
 * reference calls for it specifically. `JUMP_VELOCITY` is likewise Q3/CPM's
 * own 270, not Warsow's differently-tuned jump speed -- only the ADD-vs-SET
 * structure comes from Warsow, not its constants.
 *
 * Call site: Warsow calls its `PM_CheckJump` unconditionally once per frame,
 * right after `PM_CategorizePosition` sets `pml->groundplane`, and it
 * early-returns on `pm->groundentity == -1` before touching that plane. This
 * port instead calls `pmCpmJump` from inside `pmWalkMove`, id's own call
 * site, which `pmoveSingle` only reaches after `pmGroundTrace` has set
 * `pml.groundTrace` and found a ground plane. Same net effect either way: the
 * jump logic only ever reads a ground plane that was set by the ground trace
 * for the current frame, and never runs at all when airborne. The call site
 * differs; the state it reads does not.
 */
function pmCpmJump(pm: PmoveContext, pml: PmoveLocal): void {
  const normal = pml.groundTrace.plane.normal;
  const velocity = pm.ps.velocity;

  const into = fround(
    fround(normal[0] * velocity[0]) + fround(normal[1] * velocity[1]),
  );
  if (normal[2] > 0 && velocity[2] < 0 && into > 0) {
    clipVelocity(velocity, normal, velocity, OVERCLIP);
  }

  if (velocity[2] > 0) {
    velocity[2] = fround(velocity[2] + JUMP_VELOCITY);
  } else {
    velocity[2] = JUMP_VELOCITY;
  }
}

/*
=============
PM_CheckWaterJump
=============
*/
function pmCheckWaterJump(pm: PmoveContext, pml: PmoveLocal): boolean {
  if (pm.ps.pm_time) {
    return false;
  }

  // check for water jump
  if (pm.waterlevel !== 2) {
    return false;
  }

  const flatforward = vec3(pml.forward[0], pml.forward[1], 0);
  vectorNormalize(flatforward);

  const spot = vec3();
  vectorMA(pm.ps.origin, 30, flatforward, spot);
  spot[2] = spot[2] + 4;
  let cont = pm.pointcontents(spot, pm.ps.clientNum);
  if (!(cont & 1 /* CONTENTS_SOLID */)) {
    return false;
  }

  spot[2] = spot[2] + 16;
  cont = pm.pointcontents(spot, pm.ps.clientNum);
  if (cont) {
    return false;
  }

  // jump out of water
  vectorScale(pml.forward, 200, pm.ps.velocity);
  pm.ps.velocity[2] = 350;

  pm.ps.pm_flags |= PMF_TIME_WATERJUMP;
  pm.ps.pm_time = 2000;

  return true;
}

/*
===================
PM_WaterJumpMove

Flying out of the water
===================
*/
function pmWaterJumpMove(pm: PmoveContext, pml: PmoveLocal): void {
  // waterjump has no control, but falls
  stepSlideMove(pm, pml, true);

  pm.ps.velocity[2] = pm.ps.velocity[2] - fround(pm.ps.gravity * pml.frametime);
  if (pm.ps.velocity[2] < 0) {
    // cancel as soon as we are falling down again
    pm.ps.pm_flags &= ~PMF_ALL_TIMES;
    pm.ps.pm_time = 0;
  }
}

/*
===================
PM_WaterMove
===================
*/
function pmWaterMove(pm: PmoveContext, pml: PmoveLocal): void {
  if (pmCheckWaterJump(pm, pml)) {
    pmWaterJumpMove(pm, pml);
    return;
  }

  pmFriction(pm, pml);

  const scale = pmCmdScale(pm, pm.cmd);

  const wishvel = vec3();
  if (!scale) {
    wishvel[0] = 0;
    wishvel[1] = 0;
    wishvel[2] = -60; // sink towards bottom
  } else {
    for (let i = 0; i < 3; i++) {
      wishvel[i] =
        fround(fround(scale * pml.forward[i]) * pm.cmd.forwardmove) +
        fround(fround(scale * pml.right[i]) * pm.cmd.rightmove);
    }
    wishvel[2] = wishvel[2] + fround(scale * pm.cmd.upmove);
  }

  const wishdir = vec3(wishvel[0], wishvel[1], wishvel[2]);
  let wishspeed = vectorNormalize(wishdir);

  if (wishspeed > fround(pm.ps.speed * pm_swimScale)) {
    wishspeed = fround(pm.ps.speed * pm_swimScale);
  }

  pmAccelerate(pm, pml, wishdir, wishspeed, pm_wateraccelerate);

  // make sure we can go up slopes easily under water
  if (
    pml.groundPlane &&
    dotProduct(pm.ps.velocity, pml.groundTrace.plane.normal) < 0
  ) {
    const vel = vectorLength(pm.ps.velocity);
    // slide along the ground plane
    clipVelocity(
      pm.ps.velocity,
      pml.groundTrace.plane.normal,
      pm.ps.velocity,
      OVERCLIP,
    );
    vectorNormalize(pm.ps.velocity);
    vectorScale(pm.ps.velocity, vel, pm.ps.velocity);
  }

  slideMove(pm, pml, false);
}

/*
===================
PM_AirMove
===================
*/
function pmAirMove(pm: PmoveContext, pml: PmoveLocal): void {
  pmFriction(pm, pml);

  const fmove = pm.cmd.forwardmove;
  const smove = pm.cmd.rightmove;

  const scale = pmCmdScale(pm, pm.cmd);

  // set the movementDir so clients can rotate the legs for strafing
  pmSetMovementDir(pm);

  // project moves down to flat plane
  pml.forward[2] = 0;
  pml.right[2] = 0;
  vectorNormalize(pml.forward);
  vectorNormalize(pml.right);

  const wishvel = vec3();
  for (let i = 0; i < 2; i++) {
    wishvel[i] = fround(pml.forward[i] * fmove) + fround(pml.right[i] * smove);
  }
  wishvel[2] = 0;

  const wishdir = vec3(wishvel[0], wishvel[1], wishvel[2]);
  let wishspeed = vectorNormalize(wishdir);
  wishspeed = fround(wishspeed * scale);

  // not on ground, so little effect on velocity
  if (pm.physicsMode === PhysicsMode.CPM) {
    // CPM replaces this single call with a branch plus air control. See cpm.ts
    // -- and note that unlike everything else in this file, that module is NOT
    // a verified port, because CPMA is closed source.
    const p = cpmAirParams(pm, wishdir, wishspeed);
    pmAccelerate(pm, pml, wishdir, p.wishspeed, p.accel);
    if (p.aircontrol) {
      // Air control gets the UNCLAMPED wishspeed, which is the whole point of
      // the wishspeed2 split.
      airControl(pm, pml, wishdir, p.wishspeed2);
    }
  } else {
    pmAccelerate(pm, pml, wishdir, wishspeed, pm_airaccelerate);
  }

  // we may have a ground plane that is very steep, even though we don't have a
  // groundentity: slide along the steep plane
  if (pml.groundPlane) {
    clipVelocity(
      pm.ps.velocity,
      pml.groundTrace.plane.normal,
      pm.ps.velocity,
      OVERCLIP,
    );
  }

  stepSlideMove(pm, pml, true);
}

/*
===================
PM_WalkMove
===================
*/
function pmWalkMove(pm: PmoveContext, pml: PmoveLocal): void {
  if (
    pm.waterlevel > 2 &&
    dotProduct(pml.forward, pml.groundTrace.plane.normal) > 0
  ) {
    // begin swimming
    pmWaterMove(pm, pml);
    return;
  }

  if (pmCheckJump(pm, pml)) {
    // jumped away
    if (pm.waterlevel > 1) {
      pmWaterMove(pm, pml);
    } else {
      pmAirMove(pm, pml);
    }
    return;
  }

  pmFriction(pm, pml);

  const fmove = pm.cmd.forwardmove;
  const smove = pm.cmd.rightmove;

  const scale = pmCmdScale(pm, pm.cmd);

  // set the movementDir so clients can rotate the legs for strafing
  pmSetMovementDir(pm);

  // project moves down to flat plane
  pml.forward[2] = 0;
  pml.right[2] = 0;

  // project the forward and right directions onto the ground plane
  clipVelocity(pml.forward, pml.groundTrace.plane.normal, pml.forward, OVERCLIP);
  clipVelocity(pml.right, pml.groundTrace.plane.normal, pml.right, OVERCLIP);

  vectorNormalize(pml.forward);
  vectorNormalize(pml.right);

  const wishvel = vec3();
  for (let i = 0; i < 3; i++) {
    wishvel[i] = fround(pml.forward[i] * fmove) + fround(pml.right[i] * smove);
  }
  // when going up or down slopes the wish velocity should Not be zero
  //  wishvel[2] = 0;

  const wishdir = vec3(wishvel[0], wishvel[1], wishvel[2]);
  let wishspeed = vectorNormalize(wishdir);
  wishspeed = fround(wishspeed * scale);

  // clamp the speed lower if ducking
  if (pm.ps.pm_flags & PMF_DUCKED) {
    if (wishspeed > fround(pm.ps.speed * pm_duckScale)) {
      wishspeed = fround(pm.ps.speed * pm_duckScale);
    }
  }

  // clamp the speed lower if wading or walking on the bottom
  if (pm.waterlevel) {
    let waterScale = fround(pm.waterlevel / 3.0);
    waterScale = fround(1.0 - fround(fround(1.0 - pm_swimScale) * waterScale));
    if (wishspeed > fround(pm.ps.speed * waterScale)) {
      wishspeed = fround(pm.ps.speed * waterScale);
    }
  }

  // when a player gets hit, they temporarily lose full control, which allows
  // them to be moved a bit
  let accelerate: number;
  if (
    pml.groundTrace.surfaceFlags & SURF_SLICK ||
    pm.ps.pm_flags & PMF_TIME_KNOCKBACK
  ) {
    accelerate = pm_airaccelerate;
  } else {
    accelerate = pm_accelerate;
  }

  pmAccelerate(pm, pml, wishdir, wishspeed, accelerate);

  if (
    pml.groundTrace.surfaceFlags & SURF_SLICK ||
    pm.ps.pm_flags & PMF_TIME_KNOCKBACK
  ) {
    pm.ps.velocity[2] = pm.ps.velocity[2] - fround(pm.ps.gravity * pml.frametime);
  } else {
    // don't reset the z velocity for slopes
    //  pm->ps->velocity[2] = 0;
    //
    // THIS COMMENTED-OUT LINE IS HALF OF OVERBOUNCE. Leaving vertical velocity
    // intact means a player can be considered "walking" while still carrying
    // hundreds of units per second of downward speed, which the rescale below
    // then converts into horizontal speed. Restoring this line would delete the
    // mechanic the game is named after.
  }

  // ---------------------------------------------------------------------
  // OVERBOUNCE. `vel` captures the FULL speed including the downward
  // component. Clipping flattens the vector against the ground, discarding
  // that component and leaving a much shorter horizontal vector. Renormalizing
  // and rescaling to `vel` then stretches that horizontal direction back out
  // to the original magnitude — so the entire falling speed reappears as
  // horizontal speed.
  //
  // id's stated intent (the comment below is theirs) was only to stop players
  // losing speed while running up and down slopes.
  // ---------------------------------------------------------------------
  const vel = vectorLength(pm.ps.velocity);

  // slide along the ground plane
  clipVelocity(
    pm.ps.velocity,
    pml.groundTrace.plane.normal,
    pm.ps.velocity,
    OVERCLIP,
  );

  // don't decrease velocity when going up or down a slope
  vectorNormalize(pm.ps.velocity);
  vectorScale(pm.ps.velocity, vel, pm.ps.velocity);

  // don't do anything if standing still
  //
  // NOTE: this guard tests the velocity AFTER the rescale above has already
  // rewritten it, so it does not prevent an overbounce — it only skips the
  // move. With no horizontal velocity, clipping leaves just the small positive
  // residual OVERCLIP's asymmetry creates, normalizing gives exactly (0,0,1),
  // and the rescale launches the player UPWARD at their full landing speed.
  // That is the vertical overbounce, and it is the one Q3 players mean by "an
  // OB". Same code path as the horizontal case; only the direction differs.
  if (!pm.ps.velocity[0] && !pm.ps.velocity[1]) {
    return;
  }

  stepSlideMove(pm, pml, false);
}

/*
==============
PM_DeadMove
==============
*/
function pmDeadMove(pm: PmoveContext, pml: PmoveLocal): void {
  if (!pml.walking) {
    return;
  }

  // extra friction
  let forward = vectorLength(pm.ps.velocity);
  forward = fround(forward - 20);
  if (forward <= 0) {
    vectorClear(pm.ps.velocity);
  } else {
    vectorNormalize(pm.ps.velocity);
    vectorScale(pm.ps.velocity, forward, pm.ps.velocity);
  }
}

/*
===================
PM_NoclipMove
===================
*/
function pmNoclipMove(pm: PmoveContext, pml: PmoveLocal): void {
  pm.ps.viewheight = DEFAULT_VIEWHEIGHT;

  const speed = vectorLength(pm.ps.velocity);
  if (speed < 1) {
    vectorClear(pm.ps.velocity);
  } else {
    const friction = fround(pm_friction * 1.5); // extra friction
    const control = speed < pm_stopspeed ? pm_stopspeed : speed;
    const drop = fround(fround(control * friction) * pml.frametime);

    let newspeed = fround(speed - drop);
    if (newspeed < 0) {
      newspeed = 0;
    }
    newspeed = fround(newspeed / speed);
    vectorScale(pm.ps.velocity, newspeed, pm.ps.velocity);
  }

  // accelerate
  const scale = pmCmdScale(pm, pm.cmd);

  const fmove = pm.cmd.forwardmove;
  const smove = pm.cmd.rightmove;

  const wishvel = vec3();
  for (let i = 0; i < 3; i++) {
    wishvel[i] = fround(pml.forward[i] * fmove) + fround(pml.right[i] * smove);
  }
  wishvel[2] = wishvel[2] + pm.cmd.upmove;

  const wishdir = vec3(wishvel[0], wishvel[1], wishvel[2]);
  let wishspeed = vectorNormalize(wishdir);
  wishspeed = fround(wishspeed * scale);

  pmAccelerate(pm, pml, wishdir, wishspeed, pm_accelerate);

  // move
  vectorMA(pm.ps.origin, pml.frametime, pm.ps.velocity, pm.ps.origin);
}

/*
=================
PM_CrashLand

Check for hard landings that generate sound events and fall damage.
=================
*/
function pmCrashLand(pm: PmoveContext, pml: PmoveLocal): void {
  // decide which landing animation to use
  if (pm.ps.pm_flags & PMF_BACKWARDS_JUMP) {
    forceLegsAnim(pm.ps, Anim.LEGS_LANDB);
  } else {
    forceLegsAnim(pm.ps, Anim.LEGS_LAND);
  }

  pm.ps.legsTimer = TIMER_LAND;

  // calculate the exact velocity on landing
  const dist = fround(pm.ps.origin[2] - pml.previous_origin[2]);
  const vel = pml.previous_velocity[2];
  const acc = -pm.ps.gravity;

  const a = fround(acc / 2);
  const b = vel;
  const c = -dist;

  const den = fround(fround(b * b) - fround(fround(4 * a) * c));
  if (den < 0) {
    return;
  }
  const t = fround(fround(-b - fround(Math.sqrt(den))) / fround(2 * a));

  let delta = fround(vel + fround(t * acc));
  delta = fround(fround(delta * delta) * 0.0001);

  // ducking while falling doubles damage
  if (pm.ps.pm_flags & PMF_DUCKED) {
    delta = fround(delta * 2);
  }

  // never take falling damage if completely underwater
  if (pm.waterlevel === 3) {
    return;
  }

  // reduce falling damage if there is standing water
  if (pm.waterlevel === 2) {
    delta = fround(delta * 0.25);
  }
  if (pm.waterlevel === 1) {
    delta = fround(delta * 0.5);
  }

  if (delta < 1) {
    return;
  }

  // SURF_NODAMAGE is used for bounce pads where you don't ever want to take
  // damage or play a crunch sound
  if (!(pml.groundTrace.surfaceFlags & SURF_NODAMAGE)) {
    if (delta > 60) {
      addEvent(pm, PmEvent.FALL_FAR);
    } else if (delta > 40) {
      if (pm.ps.health > 0) {
        addEvent(pm, PmEvent.FALL_MEDIUM);
      }
    } else if (delta > 7) {
      addEvent(pm, PmEvent.FALL_SHORT);
    } else {
      addEvent(pm, PmEvent.FOOTSTEP);
    }
  }

  // start footstep cycle over
  pm.ps.bobCycle = 0;
}

/*
===============
PM_FootstepForSurface

Returns the event to play for the ground the player is standing on.
===============
*/
function pmFootstepForSurface(pml: PmoveLocal): PmEvent | null {
  if (pml.groundTrace.surfaceFlags & SURF_NOSTEPS) {
    // Q3 returns EV_NONE here and PM_AddEvent adds it anyway, which costs an
    // event slot and means nothing. We return null and add nothing, which is
    // the same silence without the noise in `pm.events`.
    return null;
  }
  if (pml.groundTrace.surfaceFlags & SURF_METALSTEPS) {
    return PmEvent.FOOTSTEP_METAL;
  }
  return PmEvent.FOOTSTEP;
}

/*
===============
PM_Footsteps

Advances the bob cycle and raises a footstep event each time it crosses a half
cycle. `bobCycle` is a pure output — nothing in the movement path reads it, so
this cannot perturb physics, and the movement tests must stay bit-identical.

The cycle only advances while on the ground AND holding a movement key: both
early returns leave it where it was rather than resetting, so a player who
lands mid-stride carries on mid-stride. The one reset is the standing-still
case, and it is guarded by `xyspeed < 5` — sliding to a stop with no keys held
freezes the cycle instead of zeroing it.
===============
*/
function pmFootsteps(pm: PmoveContext, pml: PmoveLocal): void {
  // calculate speed and cycle to be used for all cyclic walking effects
  pm.xyspeed = fround(
    Math.sqrt(
      fround(
        fround(pm.ps.velocity[0] * pm.ps.velocity[0]) +
          fround(pm.ps.velocity[1] * pm.ps.velocity[1]),
      ),
    ),
  );

  if (pm.ps.groundEntityNum === ENTITYNUM_NONE) {
    // airborne leaves position in cycle intact, but doesn't advance
    if (pm.waterlevel > 1) {
      continueLegsAnim(pm.ps, Anim.LEGS_SWIM);
    }
    return;
  }

  // if not trying to move
  if (!pm.cmd.forwardmove && !pm.cmd.rightmove) {
    if (pm.xyspeed < 5) {
      pm.ps.bobCycle = 0; // start at beginning of cycle again
      if (pm.ps.pm_flags & PMF_DUCKED) {
        continueLegsAnim(pm.ps, Anim.LEGS_IDLECR);
      } else {
        continueLegsAnim(pm.ps, Anim.LEGS_IDLE);
      }
    }
    return;
  }

  let footstep = false;
  let bobmove: number;

  if (pm.ps.pm_flags & PMF_DUCKED) {
    bobmove = 0.5; // ducked characters bob much faster
    if (pm.ps.pm_flags & PMF_BACKWARDS_RUN) {
      continueLegsAnim(pm.ps, Anim.LEGS_BACKCR);
    } else {
      continueLegsAnim(pm.ps, Anim.LEGS_WALKCR);
    }
    // ducked characters never play footsteps
    /*
    } else if ( pm->ps->pm_flags & PMF_BACKWARDS_RUN ) {
      if ( !( pm->cmd.buttons & BUTTON_WALKING ) ) {
        bobmove = 0.4;  // faster speeds bob faster
        footstep = qtrue;
      } else {
        bobmove = 0.3;
      }
      PM_ContinueLegsAnim( LEGS_BACK );
    */
  } else {
    if (!(pm.cmd.buttons & BUTTON_WALKING)) {
      bobmove = fround(0.4); // faster speeds bob faster
      if (pm.ps.pm_flags & PMF_BACKWARDS_RUN) {
        continueLegsAnim(pm.ps, Anim.LEGS_BACK);
      } else {
        continueLegsAnim(pm.ps, Anim.LEGS_RUN);
      }
      footstep = true;
    } else {
      bobmove = fround(0.3); // walking bobs slow
      if (pm.ps.pm_flags & PMF_BACKWARDS_RUN) {
        continueLegsAnim(pm.ps, Anim.LEGS_BACKWALK);
      } else {
        continueLegsAnim(pm.ps, Anim.LEGS_WALK);
      }
    }
  }

  // check for footstep / splash sounds
  const old = pm.ps.bobCycle;
  // The cast truncates. At 8ms and bobmove 0.4 that is 3.2 -> +3 per tick, so
  // the stride length is framerate dependent exactly as it is in Q3.
  pm.ps.bobCycle = Math.trunc(old + fround(bobmove * pml.msec)) & 255;

  // if we just crossed a cycle boundary, play an appropriate footstep event
  if (((old + 64) ^ (pm.ps.bobCycle + 64)) & 128) {
    if (pm.waterlevel === 0) {
      // on ground will only play sounds if running
      if (footstep && !pm.noFootsteps) {
        const event = pmFootstepForSurface(pml);
        if (event !== null) {
          addEvent(pm, event);
        }
      }
    } else if (pm.waterlevel === 1) {
      // splashing
      addEvent(pm, PmEvent.FOOTSPLASH);
    } else if (pm.waterlevel === 2) {
      // wading / swimming at surface
      addEvent(pm, PmEvent.SWIM);
    }
    // waterlevel 3: no sound when completely underwater
  }
}

/*
=============
PM_CorrectAllSolid
=============
*/
function pmCorrectAllSolid(
  pm: PmoveContext,
  pml: PmoveLocal,
  trace: ReturnType<typeof createTrace>,
): boolean {
  const point = vec3();

  // jitter around
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (let k = -1; k <= 1; k++) {
        vectorCopy(pm.ps.origin, point);
        point[0] = point[0] + i;
        point[1] = point[1] + j;
        point[2] = point[2] + k;
        pm.trace(trace, point, pm.mins, pm.maxs, point, pm.ps.clientNum, pm.tracemask);
        if (!trace.allsolid) {
          point[0] = pm.ps.origin[0];
          point[1] = pm.ps.origin[1];
          point[2] = pm.ps.origin[2] - 0.25;

          pm.trace(
            trace,
            pm.ps.origin,
            pm.mins,
            pm.maxs,
            point,
            pm.ps.clientNum,
            pm.tracemask,
          );
          copyTrace(trace, pml.groundTrace);
          return true;
        }
      }
    }
  }

  pm.ps.groundEntityNum = ENTITYNUM_NONE;
  pml.groundPlane = false;
  pml.walking = false;

  return false;
}

/*
=============
PM_GroundTraceMissed

The ground trace didn't hit a surface, so we are in freefall.
=============
*/
function pmGroundTraceMissed(pm: PmoveContext, pml: PmoveLocal): void {
  if (pm.ps.groundEntityNum !== ENTITYNUM_NONE) {
    // we just transitioned into freefall
    const trace = createTrace();
    const point = vec3();
    vectorCopy(pm.ps.origin, point);
    point[2] = point[2] - 64;

    pm.trace(trace, pm.ps.origin, pm.mins, pm.maxs, point, pm.ps.clientNum, pm.tracemask);
    if (trace.fraction === 1.0) {
      if (pm.cmd.forwardmove >= 0) {
        forceLegsAnim(pm.ps, Anim.LEGS_JUMP);
    pm.ps.pm_flags &= ~PMF_BACKWARDS_JUMP;
      } else {
        forceLegsAnim(pm.ps, Anim.LEGS_JUMPB);
    pm.ps.pm_flags |= PMF_BACKWARDS_JUMP;
      }
    }
  }

  pm.ps.groundEntityNum = ENTITYNUM_NONE;
  pml.groundPlane = false;
  pml.walking = false;
}

/*
=============
PM_GroundTrace
=============
*/
function pmGroundTrace(pm: PmoveContext, pml: PmoveLocal): void {
  const trace = createTrace();
  const point = vec3(pm.ps.origin[0], pm.ps.origin[1], pm.ps.origin[2] - 0.25);

  pm.trace(trace, pm.ps.origin, pm.mins, pm.maxs, point, pm.ps.clientNum, pm.tracemask);
  copyTrace(trace, pml.groundTrace);

  // do something corrective if the trace starts in a solid...
  if (trace.allsolid) {
    if (!pmCorrectAllSolid(pm, pml, trace)) {
      return;
    }
  }

  // if the trace didn't hit anything, we are in free fall
  if (trace.fraction === 1.0) {
    pmGroundTraceMissed(pm, pml);
    pml.groundPlane = false;
    pml.walking = false;
    return;
  }

  // check if getting thrown off the ground
  if (pm.ps.velocity[2] > 0 && dotProduct(pm.ps.velocity, trace.plane.normal) > 10) {
    if (pm.cmd.forwardmove >= 0) {
      forceLegsAnim(pm.ps, Anim.LEGS_JUMP);
    pm.ps.pm_flags &= ~PMF_BACKWARDS_JUMP;
    } else {
      forceLegsAnim(pm.ps, Anim.LEGS_JUMPB);
    pm.ps.pm_flags |= PMF_BACKWARDS_JUMP;
    }

    pm.ps.groundEntityNum = ENTITYNUM_NONE;
    pml.groundPlane = false;
    pml.walking = false;
    return;
  }

  // slopes that are too steep will not be considered onground
  if (trace.plane.normal[2] < MIN_WALK_NORMAL) {
    pm.ps.groundEntityNum = ENTITYNUM_NONE;
    pml.groundPlane = true;
    pml.walking = false;
    return;
  }

  pml.groundPlane = true;
  pml.walking = true;

  // hitting solid ground will end a waterjump
  if (pm.ps.pm_flags & PMF_TIME_WATERJUMP) {
    pm.ps.pm_flags &= ~(PMF_TIME_WATERJUMP | PMF_TIME_LAND);
    pm.ps.pm_time = 0;
  }

  if (pm.ps.groundEntityNum === ENTITYNUM_NONE) {
    // just hit the ground
    pmCrashLand(pm, pml);

    // don't do landing time if we were just going down a slope
    if (pml.previous_velocity[2] < -200) {
      // Despite the flag name, this does NOT block jumping — PM_CheckJump never
      // reads pm_time. What a nonzero pm_time actually does is make
      // PM_SlideMove restore the pre-collision velocity, so for 250ms after a
      // hard landing the player's velocity is not clipped by surfaces at all.
      pm.ps.pm_flags |= PMF_TIME_LAND;
      pm.ps.pm_time = 250;
    }
  }

  pm.ps.groundEntityNum = trace.entityNum;

  // don't reset the z velocity for slopes
  //  pm->ps->velocity[2] = 0;
  //
  // See PM_WalkMove: this is the other half of overbounce.
}

/*
=============
PM_SetWaterLevel
=============
*/
function pmSetWaterLevel(pm: PmoveContext): void {
  pm.waterlevel = 0;
  pm.watertype = 0;

  const point = vec3(pm.ps.origin[0], pm.ps.origin[1], pm.ps.origin[2] + MINS_Z + 1);
  let cont = pm.pointcontents(point, pm.ps.clientNum);

  if (cont & MASK_WATER) {
    const sample2 = pm.ps.viewheight - MINS_Z;
    const sample1 = (sample2 / 2) | 0; // integer division in the original

    pm.watertype = cont;
    pm.waterlevel = 1;
    point[2] = pm.ps.origin[2] + MINS_Z + sample1;
    cont = pm.pointcontents(point, pm.ps.clientNum);
    if (cont & MASK_WATER) {
      pm.waterlevel = 2;
      point[2] = pm.ps.origin[2] + MINS_Z + sample2;
      cont = pm.pointcontents(point, pm.ps.clientNum);
      if (cont & MASK_WATER) {
        pm.waterlevel = 3;
      }
    }
  }
}

/*
==============
PM_CheckDuck

Sets mins, maxs, and pm->ps->viewheight
==============
*/
function pmCheckDuck(pm: PmoveContext): void {
  pm.mins[0] = -15;
  pm.mins[1] = -15;

  pm.maxs[0] = 15;
  pm.maxs[1] = 15;

  pm.mins[2] = MINS_Z;

  if (pm.ps.pm_type === PmType.DEAD) {
    pm.maxs[2] = -8;
    pm.ps.viewheight = DEAD_VIEWHEIGHT;
    return;
  }

  if (pm.cmd.upmove < 0) {
    // duck
    pm.ps.pm_flags |= PMF_DUCKED;
  } else {
    // stand up if possible
    if (pm.ps.pm_flags & PMF_DUCKED) {
      // try to stand up
      pm.maxs[2] = 32;
      const trace = createTrace();
      pm.trace(
        trace,
        pm.ps.origin,
        pm.mins,
        pm.maxs,
        pm.ps.origin,
        pm.ps.clientNum,
        pm.tracemask,
      );
      if (!trace.allsolid) {
        pm.ps.pm_flags &= ~PMF_DUCKED;
      }
    }
  }

  if (pm.ps.pm_flags & PMF_DUCKED) {
    pm.maxs[2] = 16;
    pm.ps.viewheight = CROUCH_VIEWHEIGHT;
  } else {
    pm.maxs[2] = 32;
    pm.ps.viewheight = DEFAULT_VIEWHEIGHT;
  }
}

/*
================
PM_DropTimers
================
*/
function pmDropTimers(pm: PmoveContext, pml: PmoveLocal): void {
  // drop misc timing counter
  if (pm.ps.pm_time) {
    if (pml.msec >= pm.ps.pm_time) {
      pm.ps.pm_flags &= ~PMF_ALL_TIMES;
      pm.ps.pm_time = 0;
    } else {
      pm.ps.pm_time -= pml.msec;
    }
  }

  // drop animation counters
  if (pm.ps.legsTimer > 0) {
    pm.ps.legsTimer -= pml.msec;
    if (pm.ps.legsTimer < 0) {
      pm.ps.legsTimer = 0;
    }
  }

  if (pm.ps.torsoTimer > 0) {
    pm.ps.torsoTimer -= pml.msec;
    if (pm.ps.torsoTimer < 0) {
      pm.ps.torsoTimer = 0;
    }
  }
}

/*
================
PM_UpdateViewAngles

Can be used as another entry point when only the viewangles are being updated
instead of a full move.
================
*/
export function pmUpdateViewAngles(ps: PlayerState, cmd: UserCmd): void {
  if (ps.pm_type === PmType.INTERMISSION || ps.pm_type === PmType.SPINTERMISSION) {
    return; // no view changes at all
  }

  if (ps.pm_type !== PmType.SPECTATOR && ps.health <= 0) {
    return; // no view changes at all
  }

  // circularly clamp the angles with deltas
  for (let i = 0; i < 3; i++) {
    // `short temp` in the original: this genuinely wraps at 16 bits.
    let temp = toShort(cmd.angles[i] + ps.delta_angles[i]);
    if (i === PITCH) {
      // don't let the player look up or down more than 90 degrees
      if (temp > 16000) {
        ps.delta_angles[i] = 16000 - cmd.angles[i];
        temp = 16000;
      } else if (temp < -16000) {
        ps.delta_angles[i] = -16000 - cmd.angles[i];
        temp = -16000;
      }
    }
    ps.viewangles[i] = short2angle(temp);
  }
}

/*
================
PmoveSingle
================
*/
export function pmoveSingle(pm: PmoveContext): void {
  // clear results
  pm.numtouch = 0;
  pm.watertype = 0;
  pm.waterlevel = 0;
  pm.events.length = 0;

  // clear the respawned flag if attack and use are cleared
  //
  // This lives at the END of PmoveSingle in the C, alongside the eFlags
  // bookkeeping we do not port. Missing it is not cosmetic: PM_CheckJump
  // refuses while PMF_RESPAWNED is set, so a respawned player who never has
  // the flag cleared can never jump again.
  if (pm.ps.health > 0 && !(pm.cmd.buttons & (BUTTON_ATTACK | BUTTON_USE_HOLDABLE))) {
    pm.ps.pm_flags &= ~PMF_RESPAWNED;
  }

  // make sure walking button is clear if they are running, to avoid
  // proxy no-footsteps cheats
  if (Math.abs(pm.cmd.forwardmove) > 64 || Math.abs(pm.cmd.rightmove) > 64) {
    pm.cmd.buttons &= ~1; /* BUTTON_WALKING is bit 0 in q_shared.h */
  }

  // clear all pmove local vars
  const pml = createPmoveLocal();

  // determine the time
  pml.msec = pm.cmd.serverTime - pm.ps.commandTime;
  if (pml.msec < 1) {
    pml.msec = 1;
  } else if (pml.msec > 200) {
    pml.msec = 200;
  }
  pm.ps.commandTime = pm.cmd.serverTime;

  // save old org in case we get stuck
  vectorCopy(pm.ps.origin, pml.previous_origin);

  // save old velocity for crashlanding
  vectorCopy(pm.ps.velocity, pml.previous_velocity);

  pml.frametime = fround(pml.msec * 0.001);

  // update the viewangles
  pmUpdateViewAngles(pm.ps, pm.cmd);

  angleVectors(pm.ps.viewangles, pml.forward, pml.right, pml.up);

  if (pm.cmd.upmove < 10) {
    // not holding jump
    pm.ps.pm_flags &= ~PMF_JUMP_HELD;
  }

  // decide if backpedaling animations should be used
  if (pm.cmd.forwardmove < 0) {
    pm.ps.pm_flags |= PMF_BACKWARDS_RUN;
  } else if (
    pm.cmd.forwardmove > 0 ||
    (pm.cmd.forwardmove === 0 && pm.cmd.rightmove)
  ) {
    pm.ps.pm_flags &= ~PMF_BACKWARDS_RUN;
  }

  if (pm.ps.pm_type >= PmType.DEAD) {
    pm.cmd.forwardmove = 0;
    pm.cmd.rightmove = 0;
    pm.cmd.upmove = 0;
  }

  if (pm.ps.pm_type === PmType.NOCLIP) {
    pmNoclipMove(pm, pml);
    pmDropTimers(pm, pml);
    return;
  }

  if (pm.ps.pm_type === PmType.FREEZE) {
    return; // no movement at all
  }

  if (
    pm.ps.pm_type === PmType.INTERMISSION ||
    pm.ps.pm_type === PmType.SPINTERMISSION
  ) {
    return; // no movement at all
  }

  // set watertype, and waterlevel
  pmSetWaterLevel(pm);
  pml.previous_waterlevel = pm.waterlevel;

  // set mins, maxs, and viewheight
  pmCheckDuck(pm);

  // set groundentity
  pmGroundTrace(pm, pml);

  if (pm.ps.pm_type === PmType.DEAD) {
    pmDeadMove(pm, pml);
  }

  pmDropTimers(pm, pml);

  if (pm.ps.pm_flags & PMF_TIME_WATERJUMP) {
    pmWaterJumpMove(pm, pml);
  } else if (pm.waterlevel > 1) {
    // swimming
    pmWaterMove(pm, pml);
  } else if (pml.walking) {
    // walking on ground
    pmWalkMove(pm, pml);
  } else {
    // airborne
    pmAirMove(pm, pml);
  }

  // set groundentity, watertype, and waterlevel
  pmGroundTrace(pm, pml);
  pmSetWaterLevel(pm);

  // footstep events / legs animations
  pmFootsteps(pm, pml);

  // snap some parts of playerstate to save network bandwidth
  snapVector(pm.ps.velocity);
}

/*
================
Pmove

Chops the move up so behaviour is not framerate dependent.
================
*/
export function pmove(pm: PmoveContext): void {
  const finalTime = pm.cmd.serverTime;

  if (finalTime < pm.ps.commandTime) {
    return; // should not happen
  }

  if (finalTime > pm.ps.commandTime + 1000) {
    pm.ps.commandTime = finalTime - 1000;
  }

  pm.ps.pmove_framecount = (pm.ps.pmove_framecount + 1) & ((1 << 6) - 1);

  // chop the move up if it is too long, to prevent framerate dependent behavior
  while (pm.ps.commandTime !== finalTime) {
    let msec = finalTime - pm.ps.commandTime;

    if (pm.pmove_fixed) {
      if (msec > pm.pmove_msec) {
        msec = pm.pmove_msec;
      }
    } else {
      if (msec > 66) {
        msec = 66;
      }
    }
    pm.cmd.serverTime = pm.ps.commandTime + msec;
    pmoveSingle(pm);

    if (pm.ps.pm_flags & PMF_JUMP_HELD) {
      pm.cmd.upmove = 20;
    }
  }

  // Restore the caller's serverTime, which the loop above overwrote.
  pm.cmd.serverTime = finalTime;
}
