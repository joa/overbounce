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
import { ENTITYNUM_NONE, SURF_NOIMPACT } from '../physics/constants.js';
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

/** `fire_rocket`: 900ups, straight line, 15 second lifetime. */
export function fireRocket(start: Vec3, dir: Vec3, time: number, ownerNum: number): Missile {
  return spawn('rocket', start, dir, 900, TrType.LINEAR, time, ownerNum, {
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

/** `G_ExplodeMissile`: detonate without an impact (fuse or lifetime expiry). */
function explodeMissile(m: Missile, world: MissileWorld, time: number): void {
  const origin = vec3();
  evaluateTrajectory(m.pos, time, origin);
  // The original snaps here but NOT on the wall-impact path. Preserved.
  snapVector(origin);
  vectorCopy(origin, m.currentOrigin);

  m.alive = false;

  if (m.splashDamage) {
    radiusDamage(
      m.currentOrigin,
      m.ownerNum,
      m.splashDamage,
      m.splashRadius,
      ENTITYNUM_NONE,
      world.targets,
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
    return;
  }

  m.alive = false;

  if (m.splashDamage) {
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
