/**
 * Weapon auto switch: "a weapon you were not already carrying", against a
 * real `Game` walking over real pickups.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The rule is one comparison, and everything that can go wrong with it is
 * ORDER -- comparing against a set that has already been updated makes every
 * pickup look old, and updating from the wrong moment makes a spawn grant
 * look new. So these tests do not call `isNew` against a hand-built set:
 * they run the same compare-then-sync loop `main.ts` runs, over pickup
 * events the simulation actually produced, and let the item code decide what
 * a pickup is.
 */

import { describe, it, expect } from 'vitest';
import { CarriedWeapons } from '../../src/game/autoswitch.js';
import { Game } from '../../src/game/game.js';
import { buildEntities } from '../../src/game/entities.js';
import { ItemType, hasAmmo } from '../../src/game/items.js';
import { Weapon, WEAPON_TAG, weaponFromTag } from '../../src/game/weapons.js';
import { flatWorld } from '../physics/world.js';

/** The six Overbounce carries, in `main.ts`'s `WEAPON_BINDS` order. */
const SLOTS: readonly Weapon[] = [
  Weapon.MACHINEGUN,
  Weapon.SHOTGUN,
  Weapon.GRENADE_LAUNCHER,
  Weapon.ROCKET_LAUNCHER,
  Weapon.RAILGUN,
  Weapon.PLASMAGUN,
];

const heldWeapons = (g: Game): Weapon[] => SLOTS.filter((w) => hasAmmo(g.ps, WEAPON_TAG[w]));

/**
 * One tick of `main.ts`'s auto-switch handling, in its own order: read the
 * events, judge each against what the tick STARTED with, then take the new
 * reading. Reports every weapon picked up and every weapon switched to --
 * the first so a test can prove the pickup it is asking about actually
 * happened, rather than passing because nothing did.
 */
function stepWithAutoSwitch(
  g: Game,
  carried: CarriedWeapons,
): { picked: Weapon[]; switched: Weapon[] } {
  const picked: Weapon[] = [];
  const switched: Weapon[] = [];
  const f = g.step({});
  for (const e of f.items) {
    if (e.kind !== 'pickup' || e.placed.item.type !== ItemType.WEAPON) {
      continue;
    }
    const weapon = weaponFromTag(e.placed.item.tag);
    picked.push(weapon);
    if (carried.isNew(weapon) && g.selectWeapon(weapon)) {
      switched.push(weapon);
    }
  }
  carried.sync(heldWeapons(g));
  return { picked, switched };
}

/** A game standing on a flat floor with `classnames` placed on the spot. */
function gameWith(classnames: string[], weapon = Weapon.ROCKET_LAUNCHER): Game {
  return new Game({
    world: flatWorld(),
    origin: [0, 0, 40],
    weapon,
    entities: buildEntities(classnames.map((classname) => ({ classname, origin: '0 0 40' }))),
    spawn: { origin: [0, 0, 40], yaw: 0 },
  });
}

describe('weapon auto switch', () => {
  it('equips a weapon the player has never carried', () => {
    const g = gameWith(['weapon_plasmagun']);
    const carried = new CarriedWeapons();
    // The spawn grant, which is not a pickup -- see `autoswitch.ts`.
    carried.sync(heldWeapons(g));
    expect(g.weapon).toBe(Weapon.ROCKET_LAUNCHER);

    expect(stepWithAutoSwitch(g, carried).switched).toEqual([Weapon.PLASMAGUN]);
    expect(g.weapon).toBe(Weapon.PLASMAGUN);
  });

  it('does NOT equip one the player already has', () => {
    // The case the whole rule exists for: a course's pickups respawn, and
    // the second time over the same launcher must leave your hands alone.
    const g = gameWith(['weapon_plasmagun']);
    const carried = new CarriedWeapons();
    carried.sync(heldWeapons(g));

    expect(stepWithAutoSwitch(g, carried).switched).toEqual([Weapon.PLASMAGUN]);

    // Back to something else by hand, then stand there until the pickup
    // comes back -- `G_WEAPON_RESPAWN` is 5s, which is 625 ticks, so the
    // budget here is generous rather than tight.
    g.selectWeapon(Weapon.ROCKET_LAUNCHER);
    let pickedAgain = 0;
    let switchedAgain = 0;
    for (let i = 0; i < 1500; i++) {
      const tick = stepWithAutoSwitch(g, carried);
      pickedAgain += tick.picked.length;
      switchedAgain += tick.switched.length;
    }
    // The assertion that keeps this from passing on a pickup that never
    // respawned: it did come back, and it was picked up again.
    expect(pickedAgain).toBeGreaterThan(0);
    expect(switchedAgain).toBe(0);
    expect(g.weapon).toBe(Weapon.ROCKET_LAUNCHER);
  });

  it('does not count the weapon the player spawned holding', () => {
    // Standing on a launcher identical to the one `ClientSpawn` gave out.
    // Being handed a weapon is not picking one up, and the first sync is
    // what says so.
    const g = gameWith(['weapon_rocketlauncher'], Weapon.ROCKET_LAUNCHER);
    const carried = new CarriedWeapons();
    carried.sync(heldWeapons(g));
    const tick = stepWithAutoSwitch(g, carried);
    expect(tick.picked).toEqual([Weapon.ROCKET_LAUNCHER]);
    expect(tick.switched).toEqual([]);
  });

  it('switches once per new weapon, across several of them', () => {
    const g = gameWith(['weapon_plasmagun', 'weapon_railgun', 'weapon_shotgun']);
    const carried = new CarriedWeapons();
    carried.sync(heldWeapons(g));

    const all: Weapon[] = [];
    for (let i = 0; i < 200; i++) {
      all.push(...stepWithAutoSwitch(g, carried).switched);
    }
    expect([...all].sort()).toEqual(
      [Weapon.PLASMAGUN, Weapon.RAILGUN, Weapon.SHOTGUN].sort(),
    );
  });

  it('ignores a weapon Overbounce does not model', () => {
    // A real pickup with real ammo -- `weaponFromTag` answers NONE for it,
    // and switching to nothing is not a switch.
    const g = gameWith(['weapon_lightning']);
    const carried = new CarriedWeapons();
    carried.sync(heldWeapons(g));

    expect(stepWithAutoSwitch(g, carried).switched).toEqual([]);
    expect(g.weapon).toBe(Weapon.ROCKET_LAUNCHER);
  });
});

describe('CarriedWeapons', () => {
  it('is empty until synced, and a sync is the whole reading', () => {
    const c = new CarriedWeapons();
    expect(c.isNew(Weapon.RAILGUN)).toBe(true);

    c.sync([Weapon.RAILGUN, Weapon.SHOTGUN]);
    expect(c.isNew(Weapon.RAILGUN)).toBe(false);
    expect(c.isNew(Weapon.PLASMAGUN)).toBe(true);

    // A weapon that left the inventory -- a respawn wipe, a `target_init` --
    // goes out of the set with it, so picking it back up counts as new.
    c.sync([Weapon.SHOTGUN]);
    expect(c.isNew(Weapon.RAILGUN)).toBe(true);
    expect(c.has(Weapon.SHOTGUN)).toBe(true);
  });

  it('never calls NONE new', () => {
    const c = new CarriedWeapons();
    expect(c.isNew(Weapon.NONE)).toBe(false);
  });
});
