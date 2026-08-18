/**
 * Splash damage and knockback.
 * Ported from Quake III Arena's code/game/g_combat.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is the half of the weapon code that actually matters for Overbounce.
 * The game has no enemies; weapons exist to move the player, and that movement
 * is entirely a product of `G_Damage`'s knockback impulse.
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3, vectorNormalize } from '../math/vec3.js';
import type { PlayerState } from '../physics/types.js';
import { applyArmor } from './items.js';
import { PMF_TIME_KNOCKBACK } from '../physics/constants.js';

const fround = Math.fround;

/** `g_knockback` default. */
export const G_KNOCKBACK = 1000;
/** The mass every player is assumed to have, from G_Damage. */
export const PLAYER_MASS = 200;
/** Knockback is clamped to this before being turned into an impulse. */
export const MAX_KNOCKBACK = 200;

/**
 * Something splash damage can act on. Only the player exists in Overbounce, but
 * `G_RadiusDamage` is written against a list, and keeping that shape means jump
 * pads, movers and future course entities drop in without reshaping the code.
 */
export interface DamageTarget {
  number: number;
  /** `r.currentOrigin`. */
  origin: Vec3;
  /** `r.absmin` / `r.absmax` — origin plus the entity's bounds. */
  absmin: Vec3;
  absmax: Vec3;
  velocity: Vec3;
  health: number;
  /**
   * PW_BATTLESUIT is active. Set by the game layer each tick, because damage.ts
   * has no clock of its own and a powerup is a time window.
   */
  battlesuit?: boolean;
  takedamage: boolean;
  /** Present for players; knockback sets the movement timer through it. */
  ps: PlayerState | null;
}

/** Build a damage target from a player state and its bounding box. */
export function playerTarget(
  ps: PlayerState,
  mins: Vec3,
  maxs: Vec3,
  number = 0,
): DamageTarget {
  return {
    number,
    origin: ps.origin,
    absmin: vec3(ps.origin[0] + mins[0], ps.origin[1] + mins[1], ps.origin[2] + mins[2]),
    absmax: vec3(ps.origin[0] + maxs[0], ps.origin[1] + maxs[1], ps.origin[2] + maxs[2]),
    velocity: ps.velocity,
    health: ps.health,
    takedamage: true,
    ps,
  };
}

/** Refresh a target's bounds after the player has moved. */
export function updateTargetBounds(
  target: DamageTarget,
  mins: Vec3,
  maxs: Vec3,
): void {
  for (let i = 0; i < 3; i++) {
    target.absmin[i] = target.origin[i] + mins[i];
    target.absmax[i] = target.origin[i] + maxs[i];
  }
}

export interface DamageResult {
  /** Damage actually taken, after the self-damage halving. */
  taken: number;
  /** Magnitude of the velocity impulse applied. */
  knockbackSpeed: number;
}

/**
 * `G_Damage`, reduced to the parts that move a player.
 *
 * The ordering here is the whole trick behind rocket jumping, and id commented
 * it as such: knockback is computed from the FULL damage, and only afterwards
 * is self-inflicted damage halved. A rocket to your own feet therefore launches
 * you as hard as it would launch an enemy, while costing you half the health.
 */
export function damage(
  target: DamageTarget,
  attackerNum: number,
  dir: Vec3,
  amount: number,
): DamageResult {
  if (!target.takedamage) {
    return { taken: 0, knockbackSpeed: 0 };
  }

  let dmg = amount;

  // `if (!dir) dflags |= DAMAGE_NO_KNOCKBACK; else VectorNormalize(dir);`
  vectorNormalize(dir);

  let knockback = dmg;
  if (knockback > MAX_KNOCKBACK) {
    knockback = MAX_KNOCKBACK;
  }

  let knockbackSpeed = 0;

  // figure momentum add, even if the damage won't be taken
  if (knockback && target.ps) {
    const scale = fround(fround(G_KNOCKBACK * knockback) / PLAYER_MASS);
    for (let i = 0; i < 3; i++) {
      target.velocity[i] = target.velocity[i] + fround(dir[i] * scale);
    }
    knockbackSpeed = scale;

    // Set the timer so the player cannot immediately cancel the movement.
    // While it runs, PM_Friction is skipped and PM_WalkMove uses air
    // acceleration — which is why a rocket jump does not get scrubbed off the
    // instant you land.
    if (!target.ps.pm_time) {
      let t = knockback * 2;
      if (t < 50) {
        t = 50;
      }
      if (t > 200) {
        t = 200;
      }
      target.ps.pm_time = t;
      target.ps.pm_flags |= PMF_TIME_KNOCKBACK;
    }
  }

  // always give half damage if hurting self
  // calculated after knockback, so rocket jumping works
  if (target.number === attackerNum) {
    dmg = fround(dmg * 0.5);
  }

  if (dmg < 1) {
    dmg = 1;
  }

  // Battlesuit, then armour, then health -- G_Damage's order.
  //
  // Note battlesuit blocks radius damage OUTRIGHT, and splash is the only
  // damage in this game, so wearing one makes rocket jumping free. That is
  // faithful, and it is a genuine movement powerup here rather than a
  // defensive one.
  if (target.ps) {
    if (target.battlesuit) {
      return { taken: 0, knockbackSpeed };
    }
    dmg = applyArmor(target.ps, dmg);
  }

  target.health -= dmg;
  if (target.ps) {
    target.ps.health = target.health;
  }

  return { taken: dmg, knockbackSpeed };
}

/**
 * `G_RadiusDamage`.
 *
 * Two details decide how a rocket jump feels, and both are easy to get wrong:
 *
 *  - Distance is measured from the EDGE of the target's bounding box, not its
 *    centre. Standing on a rocket therefore counts as distance zero over the
 *    whole width of the player, not just at one point.
 *  - The direction gets `dir[2] += 24` before normalising, described in the
 *    original as pushing "the center of mass higher than the origin so players
 *    get knocked into the air more". A rocket at your feet launches you up, not
 *    sideways, because of this line.
 */
export function radiusDamage(
  origin: Vec3,
  attackerNum: number,
  amount: number,
  radius: number,
  ignoreNum: number,
  targets: readonly DamageTarget[],
): boolean {
  let r = radius;
  if (r < 1) {
    r = 1;
  }

  let hitClient = false;
  const v = vec3();
  const dir = vec3();

  for (const ent of targets) {
    if (ent.number === ignoreNum) {
      continue;
    }
    if (!ent.takedamage) {
      continue;
    }

    // find the distance from the edge of the bounding box
    for (let i = 0; i < 3; i++) {
      if (origin[i] < ent.absmin[i]) {
        v[i] = ent.absmin[i] - origin[i];
      } else if (origin[i] > ent.absmax[i]) {
        v[i] = origin[i] - ent.absmax[i];
      } else {
        v[i] = 0;
      }
    }

    const dist = fround(
      Math.sqrt(
        fround(fround(fround(v[0] * v[0]) + fround(v[1] * v[1])) + fround(v[2] * v[2])),
      ),
    );
    if (dist >= r) {
      continue;
    }

    const points = fround(amount * fround(1.0 - fround(dist / r)));

    for (let i = 0; i < 3; i++) {
      dir[i] = ent.origin[i] - origin[i];
    }
    // push the center of mass higher than the origin so players get knocked
    // into the air more
    dir[2] = dir[2] + 24;

    damage(ent, attackerNum, dir, points);
    hitClient = true;
  }

  return hitClient;
}
