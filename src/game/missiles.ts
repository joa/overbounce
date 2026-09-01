/**
 * Projectiles.
 * Ported from Quake III Arena's code/game/g_missile.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * DIVERGENCE: Quake 3 runs missiles once per server frame (50ms at the default
 * sv_fps 20); this runs them on the same 8ms tick as movement. Trajectories are
 * closed-form, so flight paths are identical either way — what changes is how
 * finely impacts are detected, and 8ms resolves them more precisely than the
 * original. Deliberate, and the only sane choice given a single simulation
 * clock.
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3, vectorCopy, dotProduct, vectorLength, vectorNormalize } from '../math/vec3.js';
import type { TraceFn, TraceResult } from '../physics/types.js';
import { createTrace } from '../physics/types.js';
import { ENTITYNUM_NONE, ENTITYNUM_WORLD, SURF_NOIMPACT } from '../physics/constants.js';
import { snapVector } from '../physics/pmove.js';
import type { Trajectory } from './trajectory.js';
import {
  TrType,
  createTrajectory,
  evaluateTrajectory,
  evaluateTrajectoryDelta,
} from './trajectory.js';
import type { DamageTarget } from './damage.js';
import { radiusDamage } from './damage.js';

const fround = Math.fround;

/**
 * Missiles are spawned with their trajectory time 50ms in the past, so they
 * "move a bit on the very first frame". This matters for rocket jumping: it is
 * what carries the rocket clear of the muzzle before the first impact test.
 */
export const MISSILE_PRESTEP_TIME = 50;

export interface Missile {
  classname: string;
  pos: Trajectory;
  currentOrigin: Vec3;
  damage: number;
  splashDamage: number;
  splashRadius: number;
  /** Grenades bounce; rockets and plasma do not. */
  bounceHalf: boolean;
  ownerNum: number;
  /** Level time at which it explodes on its own — a fuse, or a lifetime. */
  nextthink: number;
  alive: boolean;
}

export interface MissileWorld {
  trace: TraceFn;
  targets: readonly DamageTarget[];
  /** `MASK_SHOT`. */
  clipmask: number;
  /**
   * Called wherever a missile goes off, for effects and sound.
   *
   * `normal` is `CG_ImpactMark`'s `dir` -- omitted only when the impact
   * can't leave a mark at all (hit a mover, not the world). Whether anything
   * is actually nearby to stamp is `markFragments`' call to make, not this
   * layer's -- see `explodeMissile` and `missileImpact` below.
   */
  onExplode?: (missile: Missile, origin: Vec3, normal?: Vec3) => void;
  /** Called when a bouncing missile hits something without detonating. */
  onBounce?: (missile: Missile, origin: Vec3) => void;
  /**
   * `G_Damage` on whatever the missile struck, by entity number.
   *
   * Only movers care: `G_Damage`'s `ET_MOVER` branch (g_combat.c:859) turns
   * damage on a door or button into a USE, which is how shooting a door opens
   * it. The player is handled through `targets` instead.
   */
  onHitEntity?: (entityNum: number, origin: Vec3) => void;
  /** `G_RadiusDamage` reaching non-`targets` entities -- again, the movers. */
  onSplash?: (origin: Vec3, radius: number) => void;
  /**
   * Whether self-inflicted splash costs health. Defaults to true.
   *
   * `?selfdamage=0` is the defrag no-damage mode: full knockback, no health
   * loss, so rocket jumps behave identically and only the health economy of a
   * course changes. NOT Quake -- id has no such switch, it is server-side.
   */
  selfDamage?: boolean;
}

function spawn(
  classname: string,
  start: Vec3,
  dir: Vec3,
  speed: number,
  trType: TrType,
  time: number,
  ownerNum: number,
  opts: {
    damage: number;
    splashDamage: number;
    splashRadius: number;
    lifetime: number;
    bounceHalf?: boolean;
  },
): Missile {
  const d = vec3(dir[0], dir[1], dir[2]);
  vectorNormalize(d);

  const pos = createTrajectory();
  pos.trType = trType;
  pos.trTime = time - MISSILE_PRESTEP_TIME;
  vectorCopy(start, pos.trBase);
  for (let i = 0; i < 3; i++) {
    pos.trDelta[i] = fround(d[i] * speed);
  }
  // "save net bandwidth" — but it also quantizes the launch velocity, so it is
  // part of the physics, not just a transport detail.
  snapVector(pos.trDelta);

  return {
    classname,
    pos,
    currentOrigin: vec3(start[0], start[1], start[2]),
    damage: opts.damage,
    splashDamage: opts.splashDamage,
    splashRadius: opts.splashRadius,
    bounceHalf: opts.bounceHalf ?? false,
    ownerNum,
    nextthink: time + opts.lifetime,
    alive: true,
  };
}

/**
 * `fire_rocket`: 900ups in VQ3, straight line, 15 second lifetime.
 *
 * CPM fires the same rocket 100ups faster. That number does NOT come from the
 * same place the 900 does, and the difference matters:
 *
 *  - 900 is `VectorScale(dir, 900, bolt->s.pos.trDelta)` in id's g_weapon.c,
 *    readable and verified like everything else in VQ3.
 *  - 1000 is community-documented CPMA and owner-confirmed. It was NOT read
 *    out of CPMA's bytecode: that attempt is recorded in
 *    `.agent/docs/cpma-constants.md`, including how far it got and why it
 *    stopped, so nobody repeats it expecting a different answer.
 *
 * Which is the standing rule for this whole mode -- VQ3 carries the 1:1
 * guarantee, CPM does not -- applied to a projectile rather than to pmove.
 */
export const ROCKET_SPEED_VQ3 = 900;
export const ROCKET_SPEED_CPM = 1000;

export function fireRocket(
  start: Vec3,
  dir: Vec3,
  time: number,
  ownerNum: number,
  speed: number = ROCKET_SPEED_VQ3,
): Missile {
  return spawn('rocket', start, dir, speed, TrType.LINEAR, time, ownerNum, {
    damage: 100,
    splashDamage: 100,
    splashRadius: 120,
    lifetime: 15000,
  });
}

/** `fire_grenade`: 700ups, ballistic, bounces, 2500ms fuse. */
export function fireGrenade(start: Vec3, dir: Vec3, time: number, ownerNum: number): Missile {
  return spawn('grenade', start, dir, 700, TrType.GRAVITY, time, ownerNum, {
    damage: 100,
    splashDamage: 100,
    splashRadius: 150,
    lifetime: 2500,
    bounceHalf: true,
  });
}

/** `fire_plasma`: 2000ups, straight line, small splash, 10 second lifetime. */
export function firePlasma(start: Vec3, dir: Vec3, time: number, ownerNum: number): Missile {
  return spawn('plasma', start, dir, 2000, TrType.LINEAR, time, ownerNum, {
    damage: 20,
    splashDamage: 15,
    splashRadius: 20,
    lifetime: 10000,
  });
}

/**
 * `dir = (0,0,1)` in `G_ExplodeMissile`: "we don't have a valid direction, so
 * just point straight up". Unconditional in id -- `markFragments` (the real
 * `R_MarkFragments` port, `src/collision/markfragments.ts`) is what decides
 * whether anything is actually nearby to draw on, same as id's
 * `CM_MarkFragments` does for this exact call. A fuse pop with nothing under
 * it naturally yields zero fragments; no gating trace needed here.
 */
const FUSE_MARK_NORMAL: Vec3 = vec3(0, 0, 1);

/** `G_ExplodeMissile`: detonate without an impact (fuse or lifetime expiry). */
function explodeMissile(m: Missile, world: MissileWorld, time: number): void {
  const origin = vec3();
  evaluateTrajectory(m.pos, time, origin);
  // The original snaps here but NOT on the wall-impact path. Preserved.
  snapVector(origin);
  vectorCopy(origin, m.currentOrigin);

  m.alive = false;
  world.onExplode?.(m, m.currentOrigin, FUSE_MARK_NORMAL);

  if (m.splashDamage) {
    world.onSplash?.(m.currentOrigin, m.splashRadius);
    radiusDamage(
      m.currentOrigin,
      m.ownerNum,
      m.splashDamage,
      m.splashRadius,
      ENTITYNUM_NONE,
      world.targets,
      world.selfDamage ?? true,
    );
  }
}

/** `G_BounceMissile`. */
function bounceMissile(
  m: Missile,
  trace: TraceResult,
  prevTime: number,
  time: number,
): void {
  const velocity = vec3();
  const hitTime = prevTime + (time - prevTime) * trace.fraction;
  evaluateTrajectoryDelta(m.pos, hitTime, velocity);

  const dot = dotProduct(velocity, trace.plane.normal);
  for (let i = 0; i < 3; i++) {
    m.pos.trDelta[i] = velocity[i] + fround(fround(-2 * dot) * trace.plane.normal[i]);
  }

  if (m.bounceHalf) {
    for (let i = 0; i < 3; i++) {
      m.pos.trDelta[i] = fround(m.pos.trDelta[i] * 0.65);
    }
    // check for stop
    if (trace.plane.normal[2] > 0.2 && vectorLength(m.pos.trDelta) < 40) {
      m.pos.trType = TrType.STATIONARY;
      vectorCopy(trace.endpos, m.pos.trBase);
      vectorCopy(trace.endpos, m.currentOrigin);
      return;
    }
  }

  for (let i = 0; i < 3; i++) {
    m.currentOrigin[i] = m.currentOrigin[i] + trace.plane.normal[i];
  }
  vectorCopy(m.currentOrigin, m.pos.trBase);
  m.pos.trTime = time;
}

/** `G_MissileImpact`, world-only (Overbounce has no other damageable entities). */
function missileImpact(
  m: Missile,
  trace: TraceResult,
  world: MissileWorld,
  prevTime: number,
  time: number,
): void {
  // check for bounce
  if (m.bounceHalf) {
    bounceMissile(m, trace, prevTime, time);
    world.onBounce?.(m, m.currentOrigin);
    return;
  }

  m.alive = false;
  // `R_BoxSurfaces_r` never walks mover entities, only `tr.world->nodes` --
  // `markFragments` (the real `R_MarkFragments` port) only knows the static
  // collision model, so a mark here would search the wrong geometry (or
  // find none) if this hit a door. Per-surface filters (`SURF_NOMARKS`,
  // `SURF_NODRAW`, `CONTENTS_SOLID`) live inside that search, same as id.
  const markNormal = trace.entityNum === ENTITYNUM_WORLD ? trace.plane.normal : undefined;
  world.onExplode?.(m, trace.endpos, markNormal);

  /*
   * `if (other->takedamage) { ... G_Damage(other, ...) }` -- the direct hit.
   *
   * `clip.ts` stamped the mover's own number on the trace, which is the same
   * number `ClientImpacts` uses for buttons, so this needs no extra lookup.
   */
  if (trace.entityNum !== ENTITYNUM_WORLD && trace.entityNum !== ENTITYNUM_NONE) {
    world.onHitEntity?.(trace.entityNum, trace.endpos);
  }

  if (m.splashDamage) {
    world.onSplash?.(trace.endpos, m.splashRadius);
    // NOTE: the wall path uses the raw trace endpos, while G_ExplodeMissile
    // snaps the origin first. That asymmetry is id's and is preserved: rocket
    // jumps take this path, grenade fuses take the other.
    radiusDamage(
      trace.endpos,
      m.ownerNum,
      m.splashDamage,
      m.splashRadius,
      ENTITYNUM_NONE,
      world.targets,
      world.selfDamage ?? true,
    );
  }
}

/** `G_RunMissile`: advance one missile and resolve any impact. */
export function runMissile(
  m: Missile,
  world: MissileWorld,
  prevTime: number,
  time: number,
): void {
  if (!m.alive) {
    return;
  }

  const origin = vec3();
  evaluateTrajectory(m.pos, time, origin);

  const tr = createTrace();
  const zero = vec3();

  // Missiles never collide with whoever fired them: G_RunMissile passes
  // `ent->r.ownerNum`. Without that, a rocket fired at your own feet would
  // detonate against you instead of the floor, and rocket jumping would be
  // impossible.
  world.trace(tr, m.currentOrigin, zero, zero, origin, m.ownerNum, world.clipmask);

  if (tr.startsolid || tr.allsolid) {
    tr.fraction = 0;
  } else {
    vectorCopy(tr.endpos, m.currentOrigin);
  }

  if (tr.fraction !== 1) {
    // never explode or bounce on sky
    if (tr.surfaceFlags & SURF_NOIMPACT) {
      m.alive = false;
      return;
    }
    missileImpact(m, tr, world, prevTime, time);
    if (!m.alive) {
      return;
    }
  }

  // check think function after bouncing
  if (time >= m.nextthink) {
    explodeMissile(m, world, time);
  }
}

/** Advance every live missile, dropping the dead ones. */
export function runMissiles(
  missiles: Missile[],
  world: MissileWorld,
  prevTime: number,
  time: number,
): void {
  for (const m of missiles) {
    runMissile(m, world, prevTime, time);
  }
  for (let i = missiles.length - 1; i >= 0; i--) {
    if (!missiles[i].alive) {
      missiles.splice(i, 1);
    }
  }
}
