/**
 * Quake's `weapon_t` to Overbounce's `Weapon`.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * **These are different numberings and the collision is not theoretical.**
 * Quake's `WP_SHOTGUN` is 3; Overbounce's `Weapon.SHOTGUN` is 6. Quake's
 * `WP_ROCKET_LAUNCHER` is 5, which is Overbounce's `PLASMAGUN`. A demo
 * decoded straight into `Weapon` therefore does not fail -- it arms every
 * recording with a plausible wrong gun, and a rocket jump plays back as a
 * plasma shot.
 *
 * Overbounce's own numbering exists because this game ships a subset of
 * Quake's arsenal (there is nothing to shoot at, so weapons are movement
 * tools), and its enum is append-only for a reason `ghost.ts` states: those
 * numbers are in every stored ghost, so renumbering would rearm old
 * recordings. Neither side can move to match the other. One explicit table,
 * applied once at the boundary, is the whole answer.
 *
 * A demo weapon Overbounce has no equivalent for -- the BFG, the lightning
 * gun, the grappling hook, Team Arena's additions -- maps to `NONE`, which
 * the renderer draws nothing for. Silently drawing a rocket launcher for a
 * BFG would be a lie about what the recorded player was holding; drawing
 * nothing is visibly incomplete, which is the honest failure.
 */

import { Weapon } from '../game/weapons.js';
import { Q3Weapon } from '../demo/state.js';

/**
 * Indexed by `weapon_t`. Gaps are weapons Overbounce does not implement and
 * deliberately map to `NONE`.
 */
const FROM_Q3: Partial<Record<number, Weapon>> = {
  [Q3Weapon.NONE]: Weapon.NONE,
  [Q3Weapon.GAUNTLET]: Weapon.NONE,
  [Q3Weapon.MACHINEGUN]: Weapon.MACHINEGUN,
  [Q3Weapon.SHOTGUN]: Weapon.SHOTGUN,
  [Q3Weapon.GRENADE_LAUNCHER]: Weapon.GRENADE_LAUNCHER,
  [Q3Weapon.ROCKET_LAUNCHER]: Weapon.ROCKET_LAUNCHER,
  [Q3Weapon.RAILGUN]: Weapon.RAILGUN,
  [Q3Weapon.PLASMAGUN]: Weapon.PLASMAGUN,
  // LIGHTNING, BFG, GRAPPLING_HOOK and everything above deliberately absent.
};

/** `weapon_t` -> `Weapon`. Anything unmapped is `NONE`. */
export function weaponFromQ3(q3: number): Weapon {
  return FROM_Q3[q3] ?? Weapon.NONE;
}

/** The other direction, for writing a demo-derived thing back out. Only the
 *  weapons both sides have round-trip; the rest answer `WP_NONE`. */
export function weaponToQ3(weapon: Weapon): number {
  for (const [q3, ob] of Object.entries(FROM_Q3)) {
    if (ob === weapon && ob !== Weapon.NONE) {
      return Number(q3);
    }
  }
  return Q3Weapon.NONE;
}
