/**
 * Hitscan fire: `Bullet_Fire`, ported from Quake III Arena's g_weapon.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Its own module rather than part of `missiles.ts`, which is about things that
 * persist and think: a bullet exists for one trace and is then a decal and a
 * damage event. See `.agent/plans/MACHINEGUN.md` for why a project about
 * movement has a weapon that does not move you (short version: `acc_fuzzle`
 * and every DeFRaG course with a shootable button).
 *
 * ## The spread is not an angle
 *
 * `Bullet_Fire` builds the endpoint of a 131072-unit ray and then displaces
 * THAT by `spread * 16` units along right and up:
 *
 *     r = random() * M_PI * 2.0f;
 *     u = sin(r) * crandom() * spread * 16;
 *     r = cos(r) * crandom() * spread * 16;
 *     VectorMA (muzzle, 8192*16, forward, end);
 *     VectorMA (end, r, right, end);
 *     VectorMA (end, u, up, end);
 *
 * So the cone's half-angle is `atan(spread * 16 / 131072)` -- about 1.4 degrees
 * at `MACHINEGUN_SPREAD` -- and porting it as an angular jitter at the muzzle
 * would be a different weapon with a different feel. The two random draws are
 * NOT a disc: `random()` picks the direction and `crandom()` scales each axis
 * independently, which is the square-ish scatter Quake actually has.
 *
 * ## Randomness has to be reproducible here
 *
 * Everything else this project simulates is a pure function of the usercmd
 * stream, which is what lets a ghost replay a run tick for tick. A bullet can
 * open a shootable button, so it is part of the course, and a spread drawn
 * from `Math.random()` would let a ghost miss a button the run it recorded
 * hit. The caller therefore passes its own generator; `Game` seeds one from a
 * constant at course reset and advances it only here.
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3 } from '../math/vec3.js';
import type { TraceFn } from '../physics/types.js';
import { createTrace } from '../physics/types.js';
import { SURF_NOIMPACT } from '../physics/constants.js';

/** `MACHINEGUN_SPREAD`, g_weapon.c:155. */
export const MACHINEGUN_SPREAD = 200;
/**
 * `MACHINEGUN_DAMAGE`, g_weapon.c:156. The team-play 5 has no teams here.
 *
 * Recorded rather than used, and deliberately so: the only damage target in
 * this game is the player, a hitscan cannot hit its own owner, and a mover is
 * USED rather than hurt (`G_Damage`'s `ET_MOVER` branch turns any damage into
 * a use, whatever the amount). The number belongs here for the day something
 * shootable owns health.
 */
export const MACHINEGUN_DAMAGE = 7;

/** `VectorMA(muzzle, 8192*16, forward, end)` -- g_weapon.c's own reach. */
const BULLET_RANGE = 8192 * 16;

/**
 * `SnapVectorTowards`, g_weapon.c.
 *
 * Snaps the impact to integers, but always in the direction of the shooter --
 * truncating towards the wall instead would bury the decal inside it, which is
 * the whole reason this is not `SnapVector`.
 */
export function snapVectorTowards(v: Vec3, to: Vec3): void {
  for (let i = 0; i < 3; i++) {
    v[i] = to[i] <= v[i] ? Math.trunc(v[i]) : Math.trunc(v[i]) + 1;
  }
}

/** What one bullet did. Null from `fireBullet` means it hit nothing that marks. */
export interface BulletHit {
  /** Impact point, snapped towards the muzzle. */
  origin: Vec3;
  /** The surface normal, for the decal. */
  normal: Vec3;
  /** What was hit; `ENTITYNUM_WORLD` for the map itself. */
  entityNum: number;
}

export interface BulletWorld {
  trace: TraceFn;
  /** `MASK_SHOT`. */
  clipmask: number;
}

/**
 * One bullet, one trace.
 *
 * id loops up to ten times so a bullet passes through players it has already
 * damaged; with no other players in this game the first trace ends it, and the
 * loop is deliberately not ported as an empty shell.
 *
 * `random` returns 0..1, the same contract as id's `random()`. `crandom()` is
 * `2 * (random() - 0.5)` (q_shared.h:751).
 */
export function fireBullet(
  world: BulletWorld,
  muzzle: Vec3,
  forward: Vec3,
  right: Vec3,
  up: Vec3,
  spread: number,
  ownerNum: number,
  random: () => number,
): BulletHit | null {
  const crandom = (): number => 2 * (random() - 0.5);

  const dir = random() * Math.PI * 2;
  const u = Math.sin(dir) * crandom() * spread * 16;
  const r = Math.cos(dir) * crandom() * spread * 16;

  const end = vec3(
    muzzle[0] + forward[0] * BULLET_RANGE + right[0] * r + up[0] * u,
    muzzle[1] + forward[1] * BULLET_RANGE + right[1] * r + up[1] * u,
    muzzle[2] + forward[2] * BULLET_RANGE + right[2] * r + up[2] * u,
  );

  const results = createTrace();
  // A point trace: `trap_Trace(&tr, muzzle, NULL, NULL, end, ...)` passes null
  // for both bounds, which is a zero-sized hull.
  const zero = vec3(0, 0, 0);
  world.trace(results, muzzle, zero, zero, end, ownerNum, world.clipmask);

  // `if (tr.surfaceFlags & SURF_NOIMPACT) return;` -- sky, and anything else
  // the mapper marked as not worth an effect. No decal, no damage, no sound.
  if (results.surfaceFlags & SURF_NOIMPACT) {
    return null;
  }

  const origin = vec3(results.endpos[0], results.endpos[1], results.endpos[2]);
  snapVectorTowards(origin, muzzle);

  return {
    origin,
    normal: vec3(results.plane.normal[0], results.plane.normal[1], results.plane.normal[2]),
    entityNum: results.entityNum,
  };
}
