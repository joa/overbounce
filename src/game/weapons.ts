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
 * The railgun followed on 2026-09-09 (`railgun.ts`, `.agent/plans/RAILGUN.md`)
 * for the same reason at longer range: a target a bullet's spread turns into
 * a lottery is one a rail hits.
 *
 * The shotgun came next, the same day (`shotgun.ts`, `.agent/plans/SHOTGUN.md`):
 * eleven traces per pull, for the target you can see but cannot hold a
 * crosshair on while strafing past it.
 *
 * The lightning gun, BFG and grappling hook still have no purpose here and
 * are not ported.
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3 } from '../math/vec3.js';
import { angleVectors } from '../math/angles.js';
import type { PlayerState } from '../physics/types.js';
import { snapVector } from '../physics/pmove.js';
import { WeaponTag } from './items.js';
import type { Missile } from './missiles.js';
import { fireGrenade, firePlasma, fireRocket, ROCKET_SPEED_CPM, ROCKET_SPEED_VQ3 } from './missiles.js';
import { PhysicsMode } from '../physics/types.js';

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
  RAILGUN = 5,
  SHOTGUN = 6,
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
  // bg_pmove.c:1669-1670, `case WP_RAILGUN: addTime = 1500`. The slowest gun
  // in the game: 187.5 ticks, so a missed rail is a second and a half of
  // running before the next one.
  [Weapon.RAILGUN]: 1500,
  // bg_pmove.c:1654-1655, `case WP_SHOTGUN: addTime = 1000`. Exactly 125
  // ticks -- the only fire interval here that divides evenly by 8ms.
  [Weapon.SHOTGUN]: 1000,
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
  [Weapon.RAILGUN]: WeaponTag.RAILGUN,
  [Weapon.SHOTGUN]: WeaponTag.SHOTGUN,
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
    case WeaponTag.RAILGUN:
      return Weapon.RAILGUN;
    case WeaponTag.SHOTGUN:
      return Weapon.SHOTGUN;
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
  // bg_misc.c:295, `weapon_railgun`'s quantity. Ten slugs at 1500ms apiece is
  // fifteen seconds of holding the trigger.
  [Weapon.RAILGUN]: 10,
  // bg_misc.c:215, `weapon_shotgun`'s quantity. Ten shells, eleven pellets
  // each: 110 traces a pickup.
  [Weapon.SHOTGUN]: 10,
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
  // cg_weapons.c:804 -- orange. Not the beam's colour, which is the player's
  // `color1` and lives with the trail; the flash is the gun's own.
  [Weapon.RAILGUN]: [1, 0.5, 0],
  // cg_weapons.c:737 -- the machine gun's yellow, exactly.
  [Weapon.SHOTGUN]: [1, 1, 0],
};

export const WEAPON_NAME: Record<Weapon, string> = {
  [Weapon.NONE]: 'none',
  [Weapon.ROCKET_LAUNCHER]: 'rocket launcher',
  [Weapon.GRENADE_LAUNCHER]: 'grenade launcher',
  [Weapon.PLASMAGUN]: 'plasma gun',
  [Weapon.MACHINEGUN]: 'machine gun',
  [Weapon.RAILGUN]: 'railgun',
  [Weapon.SHOTGUN]: 'shotgun',
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
  //
  // KNOWN DEVIATION (2026-09-09, not yet fixed): the C is the q_shared.h
  // `SnapVector` MACRO, a `(int)` cast that truncates toward zero. This
  // helper is `trap_SnapVector`, the engine's round-to-nearest, and the two
  // disagree by a unit whenever a component's fraction is 0.5 or more.
  // Correcting it moves every projectile's birth point and the goldens with
  // it, so it is scheduled as its own change -- see
  // `.agent/docs/snapvector-macro-vs-trap.md`. `shotgun.ts`'s `snapVectorInt`
  // is the correct operation.
  snapVector(out);
  return out;
}

/** Fire `weapon` from the player's current position and view angles. */
export function fireWeapon(
  weapon: Weapon,
  ps: PlayerState,
  time: number,
  ownerNum: number,
  /**
   * Only the rocket cares, and only for its speed -- see
   * `missiles.ts`'s `ROCKET_SPEED_CPM`. Defaulted so every existing caller
   * and every test that does not care about CPM keeps firing VQ3 rockets.
   */
  physicsMode: PhysicsMode = PhysicsMode.VQ3,
): Missile | null {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  angleVectors(ps.viewangles, forward, right, up);

  const muzzle = vec3();
  calcMuzzlePoint(ps, forward, muzzle);

  switch (weapon) {
    case Weapon.ROCKET_LAUNCHER:
      return fireRocket(
        muzzle,
        forward,
        time,
        ownerNum,
        physicsMode === PhysicsMode.CPM ? ROCKET_SPEED_CPM : ROCKET_SPEED_VQ3,
      );
    case Weapon.GRENADE_LAUNCHER:
      return fireGrenade(muzzle, forward, time, ownerNum);
    case Weapon.PLASMAGUN:
      return firePlasma(muzzle, forward, time, ownerNum);
    default:
      return null;
  }
}
