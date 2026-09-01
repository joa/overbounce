/**
 * Weapons, as movement tools.
 * Ported from Quake III Arena's g_weapon.c and the PM_Weapon fire table.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Overbounce ships the three weapons that move a player -- the rocket
 * launcher, the grenade launcher and the plasma gun -- and, since 2026-09-01,
 * the machine gun, which moves nobody. It is here because a DeFRaG course can
 * gate progress behind something you have to shoot, and `acc_fuzzle` is an
 * accuracy map whose whole premise is that. See `.agent/plans/MACHINEGUN.md`.
 *
 * The railgun, shotgun, lightning gun, BFG and grappling hook still have no
 * purpose here and are not ported.
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3 } from '../math/vec3.js';
import { angleVectors } from '../math/angles.js';
import type { PlayerState } from '../physics/types.js';
import { snapVector } from '../physics/pmove.js';
import { WeaponTag } from './items.js';
import type { Missile } from './missiles.js';
import { fireGrenade, firePlasma, fireRocket } from './missiles.js';

/**
 * Overbounce's own short list.
 *
 * MACHINEGUN is 4 and not 1 for a reason that outlives the tidiness of putting
 * it first: `GhostTick.weapon` stores these numbers, so renumbering the three
 * that already exist would rearm every recorded ghost with the wrong gun.
 * Appending is free; reordering is not.
 */
export const enum Weapon {
  NONE = 0,
  ROCKET_LAUNCHER = 1,
  GRENADE_LAUNCHER = 2,
  PLASMAGUN = 3,
  MACHINEGUN = 4,
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
  // bg_pmove.c, PM_Weapon: `case WP_MACHINEGUN: addTime = 100`.
  [Weapon.MACHINEGUN]: 100,
};

/**
 * `Weapon` is Overbounce's short list; `WeaponTag` is Quake's full `weapon_t`.
 * They are NOT the same numbers -- Quake's rocket launcher is 5, ours is 1 --
 * so anything that crosses between the item system and the firing code has to
 * go through these tables. Casting one to the other silently arms the wrong gun.
 */
export const WEAPON_TAG: Record<Weapon, WeaponTag> = {
  [Weapon.NONE]: WeaponTag.NONE,
  [Weapon.ROCKET_LAUNCHER]: WeaponTag.ROCKET_LAUNCHER,
  [Weapon.GRENADE_LAUNCHER]: WeaponTag.GRENADE_LAUNCHER,
  [Weapon.PLASMAGUN]: WeaponTag.PLASMAGUN,
  [Weapon.MACHINEGUN]: WeaponTag.MACHINEGUN,
};

/** The inverse. Quake weapons Overbounce does not fire map to NONE. */
export function weaponFromTag(tag: WeaponTag): Weapon {
  switch (tag) {
    case WeaponTag.ROCKET_LAUNCHER:
      return Weapon.ROCKET_LAUNCHER;
    case WeaponTag.GRENADE_LAUNCHER:
      return Weapon.GRENADE_LAUNCHER;
    case WeaponTag.PLASMAGUN:
      return Weapon.PLASMAGUN;
    case WeaponTag.MACHINEGUN:
      return Weapon.MACHINEGUN;
    default:
      return Weapon.NONE;
  }
}

/**
 * Ammo a fresh weapon carries, from `bg_itemlist`'s `quantity` field.
 *
 * The plasma gun's 50 against the launchers' 10 is the whole reason plasma
 * climbing is a technique and rocket jumping is a resource: one is something
 * you sustain, the other is something you spend.
 */
export const WEAPON_START_AMMO: Record<Weapon, number> = {
  [Weapon.NONE]: 0,
  [Weapon.ROCKET_LAUNCHER]: 10,
  [Weapon.GRENADE_LAUNCHER]: 10,
  [Weapon.PLASMAGUN]: 50,
  // g_client.c:1183. 50 is the team-game figure and there are no teams here.
  [Weapon.MACHINEGUN]: 100,
};

/**
 * `MUZZLE_FLASH_TIME`, cg_local.h:55. How long the flash light lasts.
 *
 * 20ms is barely two physics ticks -- it is a strobe, not a lamp, and that is
 * the point: it lights the room for an instant when you fire and is gone.
 */
export const MUZZLE_FLASH_TIME = 20;

/**
 * `CG_AddPlayerWeapon`, cg_weapons.c:1358:
 *
 *     trap_R_AddLightToScene( flash.origin, 300 + (rand()&31), ... )
 *
 * The random term is a flicker, not noise -- a fixed radius reads as a lamp
 * switching on and off.
 */
export const MUZZLE_FLASH_LIGHT = 300;
export const MUZZLE_FLASH_FLICKER = 31;

/**
 * `flashDlightColor`, per weapon, from `CG_RegisterWeapon`.
 *
 * Note the rocket and the grenade launcher are NOT the same: 0.75 green against
 * 0.70. Quake distinguishes them and so should this.
 */
export const FLASH_DLIGHT_COLOR: Record<Weapon, [number, number, number]> = {
  [Weapon.NONE]: [0, 0, 0],
  // cg_weapons.c:751
  [Weapon.ROCKET_LAUNCHER]: [1, 0.75, 0],
  // cg_weapons.c:774
  [Weapon.GRENADE_LAUNCHER]: [1, 0.7, 0],
  // cg_weapons.c:796 -- the plasma gun's only dynamic light in Quake. Its
  // PROJECTILE has no `missileDlight` at all.
  [Weapon.PLASMAGUN]: [0.6, 0.6, 1],
  // cg_weapons.c:727 -- flat yellow, the brightest flash of the four.
  [Weapon.MACHINEGUN]: [1, 1, 0],
};

export const WEAPON_NAME: Record<Weapon, string> = {
  [Weapon.NONE]: 'none',
  [Weapon.ROCKET_LAUNCHER]: 'rocket launcher',
  [Weapon.GRENADE_LAUNCHER]: 'grenade launcher',
  [Weapon.PLASMAGUN]: 'plasma gun',
  [Weapon.MACHINEGUN]: 'machine gun',
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
