/**
 * Tracing against the world AND the brush entities moving through it.
 * Ported from Quake III Arena's code/server/sv_world.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `boxTrace` walks the world BSP tree and nothing else, which is right and is
 * all Overbounce needed while every solid in the map was static. A `func_door`
 * is not in that tree: it is a submodel with its own leaf, sitting at an origin
 * that changes every tick. `SV_Trace` is how Quake reconciles the two — trace
 * the world first, then clip the same sweep against each entity in turn and
 * keep whichever hit came first.
 *
 * The `entityNum` this stamps on the result is load-bearing, not decoration:
 *
 *   - `PM_GroundTrace` copies it into `ps.groundEntityNum`, which is what makes
 *     "the player is standing on the pusher" true and therefore what makes
 *     riding a moving door work at all;
 *   - `PM_SlideMove` feeds it to `PM_AddTouchEnt`, and `ClientImpacts` walks
 *     that list — which is the entire mechanism behind `func_button`, since a
 *     button is touched by bumping into a solid, not by entering a trigger.
 *
 * Get the number wrong and both of those fail silently, with the door still
 * looking perfectly solid.
 */

import type { Vec3 } from '../math/vec3.js';
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from '../physics/constants.js';
import type { TraceResult } from '../physics/types.js';
import { createTrace, copyTrace } from '../physics/types.js';
import type { CollisionModel } from './model.js';
import { boxTrace, boxTraceSubmodel } from './trace.js';

/**
 * One solid brush entity, as the trace needs to see it.
 *
 * This is the `sharedEntity_t` subset `SV_ClipMoveToEntities` actually reads.
 * `origin` is `r.currentOrigin` and is expected to be the SAME array the mover
 * writes to, so the clip list needs no per-tick synchronisation: the game layer
 * moves the door and the trace sees it moved.
 */
export interface ClipEntity {
  /** `s.number`. Stamped onto any trace this entity wins. */
  entityNum: number;
  /** Index into `CollisionModel.submodels`. */
  submodel: number;
  /** `r.currentOrigin` — live, not a copy. */
  origin: Vec3;
  /**
   * `r.contents`. `SV_SetBrushModel` sets this to -1 for every bmodel, with the
   * comment "we don't know exactly what is in the brushes", so a bmodel matches
   * every contentmask. Kept as a field rather than hardcoded because
   * `CM_TransformedBoxTrace` still filters per brush inside the submodel.
   */
  contents: number;
  /**
   * `r.mins` / `r.maxs` from `CM_ModelBounds`, in the submodel's own space.
   * Used only for the cheap bounds reject; the exact clip does not need them.
   */
  mins: ArrayLike<number>;
  maxs: ArrayLike<number>;
}

/** Scratch, so a trace in the physics hot path allocates nothing. */
const scratch: TraceResult = createTrace();
const boxmins: [number, number, number] = [0, 0, 0];
const boxmaxs: [number, number, number] = [0, 0, 0];

/**
 * `SV_Trace` — sweep [mins,maxs] from start to end through the world and every
 * entity in `entities`.
 *
 * With an empty entity list this is `boxTrace` plus the `entityNum` stamp, so
 * it is safe to route every trace through here whether the map has movers or
 * not.
 */
export function traceWithEntities(
  model: CollisionModel,
  results: TraceResult,
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  contentmask: number,
  entities: readonly ClipEntity[],
  passEntityNum: number = ENTITYNUM_NONE,
): void {
  // clip to world
  boxTrace(model, results, start, mins, maxs, end, contentmask);
  results.entityNum = results.fraction !== 1.0 ? ENTITYNUM_WORLD : ENTITYNUM_NONE;
  if (results.fraction === 0) {
    return; // blocked immediately by the world
  }

  if (entities.length === 0) {
    return;
  }

  // create the bounding box of the entire move
  // we can limit it to the part of the move not
  // already clipped off by the world, which can be
  // a significant savings for line of sight and shot traces
  //
  // (id's comment, and id's code, which does NOT actually use the clipped
  // endpoint -- `VectorCopy( clip.trace.endpos, clip.end )` is commented out
  // one line above in sv_world.c and `end` is used instead. Left as id left it:
  // using the clipped end would drop entity hits that the world merely grazed.)
  for (let i = 0; i < 3; i++) {
    if (end[i] > start[i]) {
      boxmins[i] = start[i] + mins[i] - 1;
      boxmaxs[i] = end[i] + maxs[i] + 1;
    } else {
      boxmins[i] = end[i] + mins[i] - 1;
      boxmaxs[i] = start[i] + maxs[i] + 1;
    }
  }

  clipMoveToEntities(
    model,
    results,
    start,
    mins,
    maxs,
    end,
    contentmask,
    entities,
    passEntityNum,
  );
}

/** `SV_ClipMoveToEntities`. */
function clipMoveToEntities(
  model: CollisionModel,
  clip: TraceResult,
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  contentmask: number,
  entities: readonly ClipEntity[],
  passEntityNum: number,
): void {
  for (const touch of entities) {
    if (clip.allsolid) {
      return;
    }

    // see if we should ignore this entity
    if (passEntityNum !== ENTITYNUM_NONE && touch.entityNum === passEntityNum) {
      continue; // don't clip against the pass entity
    }

    // if it doesn't have any brushes of a type we
    // are looking for, ignore it
    if (!(contentmask & touch.contents)) {
      continue;
    }

    // `SV_AreaEntities` — the sector tree only ever hands back entities whose
    // linked bounds overlap the move box, so the reject is part of the
    // original's behaviour and not an optimisation added here. absmin/absmax
    // for a bmodel are currentOrigin + r.mins / r.maxs.
    if (
      touch.origin[0] + touch.mins[0] > boxmaxs[0] ||
      touch.origin[1] + touch.mins[1] > boxmaxs[1] ||
      touch.origin[2] + touch.mins[2] > boxmaxs[2] ||
      touch.origin[0] + touch.maxs[0] < boxmins[0] ||
      touch.origin[1] + touch.maxs[1] < boxmins[1] ||
      touch.origin[2] + touch.maxs[2] < boxmins[2]
    ) {
      continue;
    }

    // might intersect, so do an exact clip
    boxTraceSubmodel(
      model,
      touch.submodel,
      scratch,
      start,
      mins,
      maxs,
      end,
      contentmask,
      touch.origin,
    );

    if (scratch.allsolid) {
      clip.allsolid = true;
      scratch.entityNum = touch.entityNum;
    } else if (scratch.startsolid) {
      clip.startsolid = true;
      scratch.entityNum = touch.entityNum;
    }

    if (scratch.fraction < clip.fraction) {
      // make sure we keep a startsolid from a previous trace
      const oldStart = clip.startsolid;

      scratch.entityNum = touch.entityNum;
      copyTrace(scratch, clip);
      clip.startsolid = clip.startsolid || oldStart;
    }
  }
}
