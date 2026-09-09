/**
 * The railgun: `weapon_railgun_fire`, ported from Quake III Arena's g_weapon.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The second hitscan weapon, and like the machine gun (`bullets.ts`) not a
 * movement tool: it is here because a DeFRaG course can put a shootable
 * target far enough away that a bullet's spread makes it a lottery, and the
 * rail is the gun that hits it. See `.agent/plans/RAILGUN.md`.
 *
 * ## What is different from a bullet
 *
 *     damage = 100 * s_quadFactor;
 *     VectorMA (muzzle, 8192, forward, end);
 *
 * The range is **8192**, not `Bullet_Fire`'s `8192*16`. A port that reused
 * `BULLET_RANGE` by analogy would reach sixteen times too far, which on a big
 * map is the difference between a target being hittable and not.
 *
 * And there is no spread. A rail is a pure function of the usercmd stream
 * already, so none of the machine gun's determinism machinery (the seeded
 * generator on `Game`) is involved here, and none should be wired in.
 *
 * ## The loop that collapses
 *
 * id traces up to `MAX_RAIL_HITS` (4) times, unlinking each damaged entity so
 * the beam passes through the players it has already hit, and stops at the
 * first thing that is `CONTENTS_SOLID`. There are no other players here and a
 * shootable button is a solid, so the first trace ends the beam -- the same
 * collapse `bullets.ts` records for its ten-iteration loop. Not ported as an
 * empty shell.
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3 } from '../math/vec3.js';
import { createTrace } from '../physics/types.js';
import { SURF_NOIMPACT } from '../physics/constants.js';
import type { BulletWorld } from './bullets.js';
import { snapVectorTowards } from './bullets.js';

/**
 * `damage = 100 * s_quadFactor`, g_weapon.c:459.
 *
 * Recorded rather than used, for the reason `MACHINEGUN_DAMAGE` gives: the
 * only damage target in this game is the player, a hitscan cannot hit its own
 * owner, and a mover is USED rather than hurt (`G_Damage`'s `ET_MOVER`
 * branch, whatever the amount).
 */
export const RAILGUN_DAMAGE = 100;

/** `VectorMA (muzzle, 8192, forward, end)`, g_weapon.c:461. */
export const RAIL_RANGE = 8192;

/**
 * `MAX_RAIL_HITS`, g_weapon.c:440. How many damageable entities one beam can
 * pass through. Recorded; see the header for why the loop it bounds is one
 * trace here.
 */
export const MAX_RAIL_HITS = 4;

/** What one rail did. There is always a beam; there is not always an impact. */
export interface RailShot {
  /**
   * Where the beam is drawn from: `tent->s.origin2`, the muzzle moved
   * "a bit to come closer to the drawn gun muzzle" -- 4 units right and 1
   * down (g_weapon.c:531-533). The cgame lowers it further when it draws.
   */
  start: Vec3;
  /** The beam's far end: `trace.endpos`, snapped towards the muzzle. */
  end: Vec3;
  /**
   * The impact surface's normal, or null for "trail but no explosion" --
   * `SURF_NOIMPACT` (sky), and, an Overbounce deviation recorded in the plan,
   * a clean miss: Quake fires `CG_MissileHitWall` 8192 units out with a
   * zeroed normal, which nothing can see and `buildImpactMark` cannot use.
   */
  normal: Vec3 | null;
  /** What was hit; `ENTITYNUM_NONE` for nothing at all. */
  entityNum: number;
}

/**
 * One rail, one trace.
 *
 * `right` and `up` are only for the trail's start point; the beam itself
 * follows `forward` exactly.
 */
export function fireRail(
  world: BulletWorld,
  muzzle: Vec3,
  forward: Vec3,
  right: Vec3,
  up: Vec3,
  ownerNum: number,
): RailShot {
  const end = vec3(
    muzzle[0] + forward[0] * RAIL_RANGE,
    muzzle[1] + forward[1] * RAIL_RANGE,
    muzzle[2] + forward[2] * RAIL_RANGE,
  );

  const trace = createTrace();
  // `trap_Trace (&trace, muzzle, NULL, NULL, end, passent, MASK_SHOT )` --
  // null bounds are a zero-sized hull.
  const zero = vec3(0, 0, 0);
  world.trace(trace, muzzle, zero, zero, end, ownerNum, world.clipmask);

  // "the final trace endpos will be the terminal point of the rail trail"
  // "snap the endpos to integers to save net bandwidth, but nudged towards
  // the line"
  const endpos = vec3(trace.endpos[0], trace.endpos[1], trace.endpos[2]);
  snapVectorTowards(endpos, muzzle);

  // VectorCopy( muzzle, tent->s.origin2 );
  // // move origin a bit to come closer to the drawn gun muzzle
  // VectorMA( tent->s.origin2, 4, right, tent->s.origin2 );
  // VectorMA( tent->s.origin2, -1, up, tent->s.origin2 );
  const start = vec3(
    muzzle[0] + 4 * right[0] - up[0],
    muzzle[1] + 4 * right[1] - up[1],
    muzzle[2] + 4 * right[2] - up[2],
  );

  // "no explosion at end if SURF_NOIMPACT, but still make the trail"
  const impact = trace.fraction < 1 && !(trace.surfaceFlags & SURF_NOIMPACT);

  return {
    start,
    end: endpos,
    normal: impact
      ? vec3(trace.plane.normal[0], trace.plane.normal[1], trace.plane.normal[2])
      : null,
    entityNum: trace.entityNum,
  };
}
