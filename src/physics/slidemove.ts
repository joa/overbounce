/**
 * Ported from Quake III Arena's code/game/bg_slidemove.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * input:  origin, velocity, bounds, groundPlane, trace function
 * output: origin, velocity, impacts, stairup boolean
 */

import type { Vec3 } from '../math/vec3.js';
import {
  vec3,
  vectorClear,
  vectorCopy,
  vectorClone,
  vectorMA,
  vectorNormalize,
  vectorNormalize2,
  vectorScale,
  crossProduct,
  dotProduct,
  vectorAdd,
} from '../math/vec3.js';
import { OVERCLIP, STEPSIZE } from './constants.js';
import { addEvent, addTouchEnt, clipVelocity } from './pm-common.js';
import { createTrace, PmEvent } from './types.js';
import type { PmoveContext, PmoveLocal } from './types.js';

const fround = Math.fround;

const MAX_CLIP_PLANES = 5;

/**
 * `PM_SlideMove`. Returns true if the velocity was clipped in some way.
 *
 * Two behaviours in here are load-bearing and must not be "cleaned up":
 *
 *  1. When `gravity` is set, the function tracks a second velocity vector
 *     (`endVelocity`) alongside the working one, and at the very end
 *     OVERWRITES the working velocity with it. All the clipping performed
 *     against surfaces during the slide is therefore discarded in the gravity
 *     path — only the clipping applied to `endVelocity` survives.
 *
 *  2. The working velocity is set to the AVERAGE of the start and end vertical
 *     velocity for the duration of the move, which is a midpoint integration
 *     of gravity over the frame while the final velocity is Euler.
 */
export function slideMove(
  pm: PmoveContext,
  pml: PmoveLocal,
  gravity: boolean,
): boolean {
  const numbumps = 4;

  const velocity = pm.ps.velocity;
  const primal_velocity = vectorClone(velocity);

  /**
   * In the original this is an uninitialized stack variable when `gravity` is
   * false, and is then read and written by the clipping code below. That is
   * technically undefined behaviour, but it is harmless because the value only
   * ever reaches `ps.velocity` under the `if (gravity)` guard at the end.
   * Zeroing it here is safe and keeps the port deterministic.
   */
  const endVelocity = vec3();

  const clipVelocityTmp = vec3();
  const endClipVelocity = vec3();
  const dir = vec3();
  const end = vec3();
  const trace = createTrace();

  if (gravity) {
    vectorCopy(velocity, endVelocity);
    endVelocity[2] = endVelocity[2] - fround(pm.ps.gravity * pml.frametime);
    velocity[2] = fround(velocity[2] + endVelocity[2]) * 0.5;
    primal_velocity[2] = endVelocity[2];
    if (pml.groundPlane) {
      // slide along the ground plane
      clipVelocity(velocity, pml.groundTrace.plane.normal, velocity, OVERCLIP);
    }
  }

  let time_left = pml.frametime;

  const planes: Vec3[] = [vec3(), vec3(), vec3(), vec3(), vec3()];
  let numplanes: number;

  // never turn against the ground plane
  if (pml.groundPlane) {
    numplanes = 1;
    vectorCopy(pml.groundTrace.plane.normal, planes[0]);
  } else {
    numplanes = 0;
  }

  // never turn against original velocity
  vectorNormalize2(velocity, planes[numplanes]);
  numplanes++;

  let bumpcount = 0;
  for (bumpcount = 0; bumpcount < numbumps; bumpcount++) {
    // calculate position we are trying to move to
    vectorMA(pm.ps.origin, time_left, velocity, end);

    // see if we can make it there
    pm.trace(trace, pm.ps.origin, pm.mins, pm.maxs, end, pm.ps.clientNum, pm.tracemask);

    if (trace.allsolid) {
      // entity is completely trapped in another solid
      velocity[2] = 0; // don't build up falling damage, but allow sideways acceleration
      return true;
    }

    if (trace.fraction > 0) {
      // actually covered some distance
      vectorCopy(trace.endpos, pm.ps.origin);
    }

    if (trace.fraction === 1) {
      break; // moved the entire distance
    }

    // save entity for contact
    addTouchEnt(pm, trace.entityNum);

    time_left = time_left - fround(time_left * trace.fraction);

    if (numplanes >= MAX_CLIP_PLANES) {
      // this shouldn't really happen
      vectorClear(velocity);
      return true;
    }

    //
    // if this is the same plane we hit before, nudge velocity
    // out along it, which fixes some epsilon issues with
    // non-axial planes
    //
    let i = 0;
    for (i = 0; i < numplanes; i++) {
      if (dotProduct(trace.plane.normal, planes[i]) > 0.99) {
        vectorAdd(trace.plane.normal, velocity, velocity);
        break;
      }
    }
    if (i < numplanes) {
      continue;
    }
    vectorCopy(trace.plane.normal, planes[numplanes]);
    numplanes++;

    //
    // modify velocity so it parallels all of the clip planes
    //

    // find a plane that it enters
    for (i = 0; i < numplanes; i++) {
      const into = dotProduct(velocity, planes[i]);
      if (into >= 0.1) {
        continue; // move doesn't interact with the plane
      }

      // see how hard we are hitting things
      if (-into > pml.impactSpeed) {
        pml.impactSpeed = -into;
      }

      // slide along the plane
      clipVelocity(velocity, planes[i], clipVelocityTmp, OVERCLIP);

      // slide along the plane
      clipVelocity(endVelocity, planes[i], endClipVelocity, OVERCLIP);

      // see if there is a second plane that the new move enters
      for (let j = 0; j < numplanes; j++) {
        if (j === i) {
          continue;
        }
        if (dotProduct(clipVelocityTmp, planes[j]) >= 0.1) {
          continue; // move doesn't interact with the plane
        }

        // try clipping the move to the plane
        clipVelocity(clipVelocityTmp, planes[j], clipVelocityTmp, OVERCLIP);
        clipVelocity(endClipVelocity, planes[j], endClipVelocity, OVERCLIP);

        // see if it goes back into the first clip plane
        if (dotProduct(clipVelocityTmp, planes[i]) >= 0) {
          continue;
        }

        // slide the original velocity along the crease
        crossProduct(planes[i], planes[j], dir);
        vectorNormalize(dir);
        let d = dotProduct(dir, velocity);
        vectorScale(dir, d, clipVelocityTmp);

        crossProduct(planes[i], planes[j], dir);
        vectorNormalize(dir);
        d = dotProduct(dir, endVelocity);
        vectorScale(dir, d, endClipVelocity);

        // see if there is a third plane the new move enters
        for (let k = 0; k < numplanes; k++) {
          if (k === i || k === j) {
            continue;
          }
          if (dotProduct(clipVelocityTmp, planes[k]) >= 0.1) {
            continue; // move doesn't interact with the plane
          }

          // stop dead at a triple plane interaction
          vectorClear(velocity);
          return true;
        }
      }

      // if we have fixed all interactions, try another move
      vectorCopy(clipVelocityTmp, velocity);
      vectorCopy(endClipVelocity, endVelocity);
      break;
    }
  }

  // See the note at the top of this function: this discards every surface
  // clip applied to the working velocity during the slide.
  if (gravity) {
    vectorCopy(endVelocity, velocity);
  }

  // don't change velocity if in a timer (FIXME: is this correct?)
  if (pm.ps.pm_time) {
    vectorCopy(primal_velocity, velocity);
  }

  return bumpcount !== 0;
}

/**
 * `PM_StepSlideMove`: attempt the slide, and if it was obstructed, retry from
 * one `STEPSIZE` higher so the player walks up stairs instead of stopping.
 */
export function stepSlideMove(
  pm: PmoveContext,
  pml: PmoveLocal,
  gravity: boolean,
): void {
  const start_o = vectorClone(pm.ps.origin);
  const start_v = vectorClone(pm.ps.velocity);

  const trace = createTrace();
  const up = vec3();
  const down = vec3();

  if (!slideMove(pm, pml, gravity)) {
    return; // we got exactly where we wanted to go first try
  }

  vectorCopy(start_o, down);
  down[2] = down[2] - STEPSIZE;
  pm.trace(trace, start_o, pm.mins, pm.maxs, down, pm.ps.clientNum, pm.tracemask);

  up[0] = 0;
  up[1] = 0;
  up[2] = 1;

  // never step up when you still have up velocity
  if (
    pm.ps.velocity[2] > 0 &&
    (trace.fraction === 1.0 || dotProduct(trace.plane.normal, up) < 0.7)
  ) {
    return;
  }

  vectorCopy(start_o, up);
  up[2] = up[2] + STEPSIZE;

  // test the player position if they were a stepheight higher
  pm.trace(trace, start_o, pm.mins, pm.maxs, up, pm.ps.clientNum, pm.tracemask);
  if (trace.allsolid) {
    return; // can't step up
  }

  const stepSize = fround(trace.endpos[2] - start_o[2]);

  // try slidemove from this position
  vectorCopy(trace.endpos, pm.ps.origin);
  vectorCopy(start_v, pm.ps.velocity);

  slideMove(pm, pml, gravity);

  // push down the final amount
  vectorCopy(pm.ps.origin, down);
  down[2] = down[2] - stepSize;
  pm.trace(trace, pm.ps.origin, pm.mins, pm.maxs, down, pm.ps.clientNum, pm.tracemask);
  if (!trace.allsolid) {
    vectorCopy(trace.endpos, pm.ps.origin);
  }
  if (trace.fraction < 1.0) {
    clipVelocity(pm.ps.velocity, trace.plane.normal, pm.ps.velocity, OVERCLIP);
  }

  // use the step move
  const delta = fround(pm.ps.origin[2] - start_o[2]);
  if (delta > 2) {
    if (delta < 7) {
      addEvent(pm, PmEvent.STEP_4);
    } else if (delta < 11) {
      addEvent(pm, PmEvent.STEP_8);
    } else if (delta < 15) {
      addEvent(pm, PmEvent.STEP_12);
    } else {
      addEvent(pm, PmEvent.STEP_16);
    }
  }
}
