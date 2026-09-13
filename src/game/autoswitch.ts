/**
 * Which weapons the player was ALREADY carrying -- the memory behind
 * `cg_autoswitch`.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Quake's own `cg_autoswitch` switches to any weapon you pick up except the
 * machine gun, every time, whether or not you already had one. Overbounce
 * switches only on a weapon you were NOT carrying -- owner-directed
 * (2026-09-13), and the right rule for a game made of repeated attempts at
 * one route: a course hands out the same rocket launcher at every checkpoint
 * and its pickups respawn, so Quake's rule would take the launcher out of
 * your hands mid-flight because you brushed one you already had.
 *
 * The whole reason this is a remembered set and not a question asked of the
 * player state: by the time a pickup EVENT is read, the pickup has already
 * happened and the ammo is already granted, so "did you have this before"
 * has no other source. Hence the order every caller must keep, and the only
 * thing here that can be got wrong:
 *
 * ```
 *   isNew(picked)   // against what the tick STARTED with
 *   ...
 *   sync(heldNow)   // then, and only then, take the new reading
 * ```
 *
 * `sync` is also what a spawn is. Being given a launcher by `ClientSpawn`,
 * or handed the full loadout by FREERUN on every respawn, is not picking one
 * up -- so a life begins by syncing, never by starting empty.
 */

import { Weapon } from './weapons.js';

export class CarriedWeapons {
  private readonly carried = new Set<Weapon>();

  /** Take a fresh reading: this is what the player has, as of now. */
  sync(held: Iterable<Weapon>): void {
    this.carried.clear();
    for (const w of held) {
      this.carried.add(w);
    }
  }

  /**
   * Is this a weapon the last `sync` did not see?
   *
   * `Weapon.NONE` is never new. A map may place a lightning gun or a BFG --
   * real pickups that Overbounce does not model, which `weaponFromTag`
   * answers NONE for -- and switching to one would be switching to nothing.
   */
  isNew(weapon: Weapon): boolean {
    return weapon !== Weapon.NONE && !this.carried.has(weapon);
  }

  /** What the last `sync` saw. For tests and the debug panel. */
  has(weapon: Weapon): boolean {
    return this.carried.has(weapon);
  }
}
