/**
 * The shotgun: `weapon_supershotgun_fire`, `ShotgunPattern` and
 * `ShotgunPellet`, ported from Quake III Arena's g_weapon.c (lines 256-364).
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The third hitscan weapon, after the machine gun (`bullets.ts`) and the
 * railgun (`railgun.ts`), and like both not a movement tool: it is here for a
 * shootable target on a DeFRaG course, and specifically for the one you can
 * see but cannot hold a crosshair on while strafing past it -- eleven traces
 * per trigger pull is the gun for that. See `.agent/plans/SHOTGUN.md`.
 *
 * ## The pattern crosses the network as one byte
 *
 * `Bullet_Fire` scatters with `random()` on the server and sends the client
 * the impact point. The shotgun cannot afford eleven of those, so the server
 * sends ONE vector and ONE seed byte, and both sides rebuild the same eleven
 * traces from them:
 *
 *     VectorScale( forward, 4096, tent->s.origin2 );
 *     SnapVector( tent->s.origin2 );
 *     tent->s.eventParm = rand() & 255;        // seed for spread pattern
 *
 *     // derive the right and up vectors from the forward vector, because
 *     // the client won't have any other information
 *     VectorNormalize2( origin2, forward );
 *     PerpendicularVector( right, forward );
 *     CrossProduct( forward, right, up );
 *     for ( i = 0 ; i < DEFAULT_SHOTGUN_COUNT ; i++ ) {
 *         r = Q_crandom( &seed ) * DEFAULT_SHOTGUN_SPREAD * 16;
 *         u = Q_crandom( &seed ) * DEFAULT_SHOTGUN_SPREAD * 16;
 *         ...
 *
 * Three consequences, each of which a port-by-analogy with `bullets.ts`
 * would get wrong:
 *
 *  - **The basis is not the view's.** The aim direction is `forward * 4096`
 *    snapped to integers and re-normalized, so it is quantized to 1/4096 per
 *    axis; and `right`/`up` are whatever `PerpendicularVector` picks (the
 *    axis the direction leans on least) rather than the player's roll.
 *    Passing `angleVectors`' `right` and `up` in, the way `fireBullet` takes
 *    them, would rotate every pattern.
 *  - **The randomness is `Q_crandom`, a seeded LCG** (`src/math/random.ts`),
 *    not `random()`. There are exactly 256 patterns for a given aim, one per
 *    seed byte, and every pellet's offset is a pure function of the seed.
 *    The seed byte itself is the only thing drawn from `Game`'s reproducible
 *    generator (`rand() & 255`, above); the 22 pellet draws come from here.
 *  - **No `SnapVectorTowards`.** Neither `ShotgunPellet` nor its cgame twin
 *    snaps `tr.endpos`: the snap in the other two guns exists because the
 *    impact point crosses the network, and here the seed does instead.
 *
 * ## The loop that collapses
 *
 * `ShotgunPellet` traces up to ten times so a pellet passes through players
 * it has already damaged. There are no other players here, so the first
 * trace ends it -- the same collapse `bullets.ts` records, for the same
 * reason. Not ported as an empty shell.
 */

import type { Vec3 } from '../math/vec3.js';
import {
  crossProduct,
  perpendicularVector,
  vec3,
  vectorMA,
  vectorNormalize2,
  vectorScale,
} from '../math/vec3.js';
import type { Seed } from '../math/random.js';
import { qCrandom } from '../math/random.js';
import { createTrace } from '../physics/types.js';
import { CONTENTS_WATER, SURF_NOIMPACT } from '../physics/constants.js';
import type { BulletHit, BulletWorld } from './bullets.js';

/**
 * `DEFAULT_SHOTGUN_SPREAD`, bg_public.h:38. In bg_ rather than g_ "because
 * client predicts same spreads" -- the cgame runs the identical pattern.
 */
export const DEFAULT_SHOTGUN_SPREAD = 700;
/** `DEFAULT_SHOTGUN_COUNT`, bg_public.h:39. Pellets per blast. */
export const DEFAULT_SHOTGUN_COUNT = 11;
/**
 * `DEFAULT_SHOTGUN_DAMAGE`, g_weapon.c:263, per pellet (`* s_quadFactor`).
 *
 * Recorded rather than used, for the reason `MACHINEGUN_DAMAGE` gives: the
 * only damage target in this game is the player, a hitscan cannot hit its
 * own owner, and a mover is USED rather than hurt (`G_Damage`'s `ET_MOVER`
 * branch, whatever the amount).
 */
export const DEFAULT_SHOTGUN_DAMAGE = 10;

/** `VectorScale( forward, 4096, tent->s.origin2 )`, g_weapon.c:358. */
export const SHOTGUN_ORIGIN2_SCALE = 4096;

/** `VectorMA( origin, 8192 * 16, forward, end)`, g_weapon.c:342 -- the bullet's reach, not the rail's. */
const PELLET_RANGE = 8192 * 16;

/**
 * `SnapVector`, the MACRO -- q_shared.h:646:
 *
 *     #define SnapVector(v) {v[0]=((int)(v[0]));v[1]=((int)(v[1]));v[2]=((int)(v[2]));}
 *
 * A C cast, which truncates toward zero. This is NOT `trap_SnapVector`, the
 * engine syscall `PM_Weapon`'s velocity snap goes through and `pmove.ts`'s
 * `snapVector` implements (round-to-nearest, per the x87 `fistp` it used):
 * the two share a name and disagree on every fractional value. The game
 * module only ever sees the macro, so `origin2` truncates. See
 * `.agent/docs/snapvector-macro-vs-trap.md`.
 */
export function snapVectorInt(v: Vec3): void {
  v[0] = Math.trunc(v[0]);
  v[1] = Math.trunc(v[1]);
  v[2] = Math.trunc(v[2]);
}

/** What one blast did. */
export interface ShotgunBlast {
  /** `tent->s.pos.trBase`: where the pellets left from. */
  muzzle: Vec3;
  /**
   * `tent->s.origin2`: `forward * 4096`, snapped. The one vector the pattern
   * is rebuilt from, and what the cgame aims the muzzle puff along.
   */
  origin2: Vec3;
  /** `tent->s.eventParm`: the seed byte, 0..255. */
  seed: number;
  /**
   * One per pellet that hit something that marks. `BulletHit` is the shape
   * (impact, normal, entity), but unlike a bullet's the origin is NOT
   * snapped -- see the header.
   */
  pellets: BulletHit[];
  /**
   * `CG_ShotgunFire`: no smoke puff when the gun is under water
   * (`contents & CONTENTS_WATER` at `pos.trBase`, cg_weapons.c:2092).
   */
  muzzleInWater: boolean;
}

/**
 * The basis both sides rebuild from `origin2` alone: `VectorNormalize2`,
 * `PerpendicularVector`, `CrossProduct`. Exported so a test can pin the
 * roll `PerpendicularVector` picks.
 */
export function shotgunBasis(origin2: Vec3): { forward: Vec3; right: Vec3; up: Vec3 } {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  // derive the right and up vectors from the forward vector, because
  // the client won't have any other information
  vectorNormalize2(origin2, forward);
  perpendicularVector(forward, right);
  crossProduct(forward, right, up);
  return { forward, right, up };
}

/**
 * `ShotgunPattern`'s eleven end points -- the geometry, without the traces,
 * so the pattern can be checked on its own.
 *
 * The seed is consumed in place, the way `Q_crandom( &seed )` advances it;
 * the caller hands in a fresh cell holding the seed byte.
 */
export function shotgunPattern(origin: Vec3, origin2: Vec3, seed: Seed): Vec3[] {
  const { forward, right, up } = shotgunBasis(origin2);
  const ends: Vec3[] = [];

  // generate the "random" spread pattern
  for (let i = 0; i < DEFAULT_SHOTGUN_COUNT; i++) {
    // `Q_crandom( &seed ) * DEFAULT_SHOTGUN_SPREAD * 16`: float times int
    // times int, left to right, a rounding after each.
    const r = Math.fround(Math.fround(qCrandom(seed) * DEFAULT_SHOTGUN_SPREAD) * 16);
    const u = Math.fround(Math.fround(qCrandom(seed) * DEFAULT_SHOTGUN_SPREAD) * 16);
    const end = vec3();
    vectorMA(origin, PELLET_RANGE, forward, end);
    vectorMA(end, r, right, end);
    vectorMA(end, u, up, end);
    ends.push(end);
  }
  return ends;
}

/**
 * `ShotgunPellet`: one pellet, one trace.
 *
 * Null when it hit nothing that marks. `SURF_NOIMPACT` returns BEFORE the
 * damage check (g_weapon.c:279-281) -- the bullet's order, and the opposite
 * of the rail's -- so a button faced with a no-impact shader is not pressed
 * by a pellet, and the caller must not `onHitEntity` on a null.
 */
export function shotgunPellet(
  world: BulletWorld,
  start: Vec3,
  end: Vec3,
  ownerNum: number,
): BulletHit | null {
  const tr = createTrace();
  // `trap_Trace (&tr, tr_start, NULL, NULL, tr_end, passent, MASK_SHOT)` --
  // null bounds are a zero-sized hull.
  const zero = vec3(0, 0, 0);
  world.trace(tr, start, zero, zero, end, ownerNum, world.clipmask);

  // send bullet impact
  if (tr.surfaceFlags & SURF_NOIMPACT) {
    return null;
  }

  // A clean miss. On the server this is `g_entities[ENTITYNUM_NONE]`, which
  // is not `takedamage`, so nothing happens; the cgame still calls
  // `CG_MissileHitWall` 131072 units out with the zeroed normal a non-hit
  // leaves, which nothing can see and `buildImpactMark` cannot use. The same
  // deviation `.agent/plans/RAILGUN.md` records for the rail, for the same
  // reason.
  if (tr.fraction >= 1) {
    return null;
  }

  return {
    origin: vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]),
    normal: vec3(tr.plane.normal[0], tr.plane.normal[1], tr.plane.normal[2]),
    entityNum: tr.entityNum,
  };
}

/**
 * `weapon_supershotgun_fire` + `ShotgunPattern`: one blast.
 *
 * `seed` is the caller's `rand() & 255` -- `Game` draws it from its
 * reproducible generator so a ghost fires the same pattern. `forward` is the
 * view's; `right` and `up` are deliberately not taken, see the header.
 */
export function fireShotgun(
  world: BulletWorld,
  muzzle: Vec3,
  forward: Vec3,
  ownerNum: number,
  seed: number,
): ShotgunBlast {
  // VectorScale( forward, 4096, tent->s.origin2 );
  // SnapVector( tent->s.origin2 );
  const origin2 = vec3();
  vectorScale(forward, SHOTGUN_ORIGIN2_SCALE, origin2);
  snapVectorInt(origin2);

  const pellets: BulletHit[] = [];
  for (const end of shotgunPattern(muzzle, origin2, { seed })) {
    const hit = shotgunPellet(world, muzzle, end, ownerNum);
    if (hit) {
      pellets.push(hit);
    }
  }

  const contents = world.pointContents ? world.pointContents(muzzle) : 0;

  return {
    muzzle: vec3(muzzle[0], muzzle[1], muzzle[2]),
    origin2,
    seed,
    pellets,
    muzzleInWater: (contents & CONTENTS_WATER) !== 0,
  };
}
