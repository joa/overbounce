/**
 * Weapons, as movement tools.
 * Ported from Quake III Arena's g_weapon.c and the PM_Weapon fire table.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Overbounce ships only the three weapons that move a player: the rocket
 * launcher, the grenade launcher and the plasma gun. There is nothing to shoot,
 * so the railgun, shotgun, lightning gun, BFG and grappling hook have no
 * purpose here and are not ported.
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3 } from '../math/vec3.js';
import { angleVectors } from '../math/angles.js';
import type { PlayerState } from '../physics/types.js';
import { snapVector } from '../physics/pmove.js';
import type { Missile } from './missiles.js';
import { fireGrenade, firePlasma, fireRocket } from './missiles.js';

export const enum Weapon {
  NONE = 0,
  ROCKET_LAUNCHER = 1,
  GRENADE_LAUNCHER = 2,
  PLASMAGUN = 3,
}

/**
 * `addTime` from PM_Weapon's fire table, in milliseconds.
 *
 * The rocket launcher's 800ms is the real constraint on a rocket-jump route:
 * it is 100 physics ticks between shots, so a double rocket jump has to be set
 * up rather than spammed.
 */
export const FIRE_TIME: Record<Weapon, number> = {
  [Weapon.NONE]: 0,
  [Weapon.ROCKET_LAUNCHER]: 800,
  [Weapon.GRENADE_LAUNCHER]: 800,
  [Weapon.PLASMAGUN]: 100,
};

export const WEAPON_NAME: Record<Weapon, string> = {
  [Weapon.NONE]: 'none',
  [Weapon.ROCKET_LAUNCHER]: 'rocket launcher',
  [Weapon.GRENADE_LAUNCHER]: 'grenade launcher',
  [Weapon.PLASMAGUN]: 'plasma gun',
};

/**
 * `CalcMuzzlePoint`: where a projectile is born.
 *
 * Note the components: the player's origin, plus their CURRENT viewheight, plus
 * 14 units forward — then snapped to integers. Viewheight matters, because it
 * is 26 standing and 12 crouched, so crouching genuinely lowers the muzzle and
 * changes the geometry of a rocket jump.
 */
export function calcMuzzlePoint(
  ps: PlayerState,
  forward: Vec3,
  out: Vec3,
): Vec3 {
  out[0] = ps.origin[0];
  out[1] = ps.origin[1];
  out[2] = ps.origin[2] + ps.viewheight;
  for (let i = 0; i < 3; i++) {
    out[i] = out[i] + Math.fround(14 * forward[i]);
  }
  // "snap to integer coordinates for more efficient network bandwidth usage"
  snapVector(out);
  return out;
}

/** Fire `weapon` from the player's current position and view angles. */
export function fireWeapon(
  weapon: Weapon,
  ps: PlayerState,
  time: number,
  ownerNum: number,
): Missile | null {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  angleVectors(ps.viewangles, forward, right, up);

  const muzzle = vec3();
  calcMuzzlePoint(ps, forward, muzzle);

  switch (weapon) {
    case Weapon.ROCKET_LAUNCHER:
      return fireRocket(muzzle, forward, time, ownerNum);
    case Weapon.GRENADE_LAUNCHER:
      return fireGrenade(muzzle, forward, time, ownerNum);
    case Weapon.PLASMAGUN:
      return firePlasma(muzzle, forward, time, ownerNum);
    default:
      return null;
  }
}
