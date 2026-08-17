/**
 * Helpers shared between pmove.ts and slidemove.ts.
 * Ported from Quake III Arena's bg_pmove.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import type { Vec3 } from '../math/vec3.js';
import { dotProduct } from '../math/vec3.js';
import { ENTITYNUM_WORLD, MAXTOUCH } from './constants.js';
import type { PmoveContext } from './types.js';

const fround = Math.fround;

/**
 * `PM_ClipVelocity`: project `input` onto the plane described by `normal`.
 *
 * The `overbounce` factor (always `OVERCLIP` = 1.001 in practice) makes the
 * surface push back very slightly harder than a pure projection, which stops
 * players from creeping into geometry through accumulated float error.
 *
 * Note the asymmetry: velocity moving INTO the plane is multiplied by
 * `overbounce`, while velocity moving away from it is DIVIDED. That is what
 * leaves a small residual component along the normal rather than exactly zero,
 * and it is one of the two halves of the overbounce mechanic.
 */
export function clipVelocity(
  input: Vec3,
  normal: Vec3,
  out: Vec3,
  overbounce: number,
): void {
  let backoff = dotProduct(input, normal);

  if (backoff < 0) {
    backoff = fround(backoff * overbounce);
  } else {
    backoff = fround(backoff / overbounce);
  }

  for (let i = 0; i < 3; i++) {
    const change = fround(normal[i] * backoff);
    out[i] = input[i] - change;
  }
}

/** `PM_AddTouchEnt`. */
export function addTouchEnt(pm: PmoveContext, entityNum: number): void {
  if (entityNum === ENTITYNUM_WORLD) {
    return;
  }
  if (pm.numtouch === MAXTOUCH) {
    return;
  }

  for (let i = 0; i < pm.numtouch; i++) {
    if (pm.touchents[i] === entityNum) {
      return;
    }
  }

  pm.touchents[pm.numtouch] = entityNum;
  pm.numtouch++;
}

/** `PM_AddEvent`. Q3 stores one predictable event per frame; we keep a list. */
export function addEvent(pm: PmoveContext, newEvent: number): void {
  pm.events.push(newEvent);
}
