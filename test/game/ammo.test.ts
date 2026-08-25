/**
 * Ammo: the counter, the cap, and what happens at zero.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Two rules here are load-bearing and easy to get backwards.
 *
 * `PM_Weapon` gates on `if (!pm->ps->ammo[weapon])` -- a ZERO test, not a
 * positive one, which is what lets -1 mean unlimited without a special case.
 *
 * `Pickup_Weapon` TOPS UP to the weapon's quantity rather than adding it, and
 * gives exactly one shot if you already have more. Making it additive would
 * turn a launcher on a run map into an infinite ammo supply.
 */

import { describe, it, expect } from 'vitest';
import {
  AMMO_UNLIMITED,
  MAX_AMMO,
  WeaponTag,
  addAmmo,
  findItem,
  hasAmmo,
  pickup,
  useAmmo,
} from '../../src/game/items.js';
import { createPlayerState } from '../../src/physics/types.js';
import {
  WEAPON_START_AMMO,
  WEAPON_TAG,
  Weapon,
  weaponFromTag,
} from '../../src/game/weapons.js';
import { Game } from '../../src/game/game.js';
import { flatWorld, originOnFloor } from '../physics/world.js';

const still = { forward: 0, right: 0, up: 0, yaw: 0, pitch: 0, attack: false, crouch: false };

describe('Add_Ammo', () => {
  it('adds and caps at 200', () => {
    const ps = createPlayerState();
    addAmmo(ps, WeaponTag.ROCKET_LAUNCHER, 150);
    expect(ps.ammo[WeaponTag.ROCKET_LAUNCHER]).toBe(150);
    addAmmo(ps, WeaponTag.ROCKET_LAUNCHER, 150);
    expect(ps.ammo[WeaponTag.ROCKET_LAUNCHER]).toBe(MAX_AMMO);
  });

  it('leaves unlimited ammo unlimited', () => {
    const ps = createPlayerState();
    ps.ammo[WeaponTag.GAUNTLET] = AMMO_UNLIMITED;
    addAmmo(ps, WeaponTag.GAUNTLET, 50);
    useAmmo(ps, WeaponTag.GAUNTLET);
    expect(ps.ammo[WeaponTag.GAUNTLET]).toBe(AMMO_UNLIMITED);
    expect(hasAmmo(ps, WeaponTag.GAUNTLET)).toBe(true);
  });

  it('treats zero, and only zero, as empty', () => {
    const ps = createPlayerState();
    expect(hasAmmo(ps, WeaponTag.PLASMAGUN)).toBe(false);
    addAmmo(ps, WeaponTag.PLASMAGUN, 1);
    expect(hasAmmo(ps, WeaponTag.PLASMAGUN)).toBe(true);
  });
});

describe('Pickup_Weapon', () => {
  it('tops up to the weapon quantity rather than adding it', () => {
    const ps = createPlayerState();
    const rl = findItem('weapon_rocketlauncher')!;
    expect(rl.quantity).toBe(10);

    pickup(ps, rl, 0);
    expect(ps.ammo[WeaponTag.ROCKET_LAUNCHER]).toBe(10);

    // Already at the quantity: a single shot, not another ten.
    pickup(ps, rl, 0);
    expect(ps.ammo[WeaponTag.ROCKET_LAUNCHER]).toBe(11);
  });

  it('tops a partial stock back up to the quantity', () => {
    const ps = createPlayerState();
    addAmmo(ps, WeaponTag.ROCKET_LAUNCHER, 4);
    pickup(ps, findItem('weapon_rocketlauncher')!, 0);
    expect(ps.ammo[WeaponTag.ROCKET_LAUNCHER]).toBe(10);
  });

  it('reports the weapon by its Quake tag, not Overbounce\u2019s index', () => {
    const ps = createPlayerState();
    const result = pickup(ps, findItem('weapon_rocketlauncher')!, 0);
    // Quake's rocket launcher is 5; Overbounce's is 1. Confusing the two arms
    // the wrong gun, which is exactly what a raw cast used to do here.
    expect(result?.weapon).toBe(WeaponTag.ROCKET_LAUNCHER);
    expect(WeaponTag.ROCKET_LAUNCHER).not.toBe(Weapon.ROCKET_LAUNCHER);
    expect(weaponFromTag(result!.weapon!)).toBe(Weapon.ROCKET_LAUNCHER);
  });

  it('maps every Overbounce weapon to a distinct Quake tag and back', () => {
    for (const w of [Weapon.ROCKET_LAUNCHER, Weapon.GRENADE_LAUNCHER, Weapon.PLASMAGUN]) {
      expect(weaponFromTag(WEAPON_TAG[w])).toBe(w);
    }
    // Weapons Overbounce does not fire come back as NONE rather than as a
    // number that happens to index the wrong thing.
    expect(weaponFromTag(WeaponTag.RAILGUN)).toBe(Weapon.NONE);
  });
});

describe('Pickup_Ammo', () => {
  it('adds the item quantity to the right weapon', () => {
    const ps = createPlayerState();
    const rockets = findItem('ammo_rockets')!;
    pickup(ps, rockets, 0);
    expect(ps.ammo[WeaponTag.ROCKET_LAUNCHER]).toBe(rockets.quantity);
    expect(ps.ammo[WeaponTag.PLASMAGUN]).toBe(0);
  });
});

describe('firing spends ammo', () => {
  const spawn = { origin: originOnFloor(0), yaw: 0 };

  function armed(): Game {
    return new Game({
      world: flatWorld(),
      weapon: Weapon.ROCKET_LAUNCHER,
      spawn,
      origin: spawn.origin,
    });
  }

  it('starts a granted weapon with its bg_itemlist quantity', () => {
    const game = armed();
    expect(game.ps.ammo[WeaponTag.ROCKET_LAUNCHER]).toBe(
      WEAPON_START_AMMO[Weapon.ROCKET_LAUNCHER],
    );
  });

  it('decrements one per shot', () => {
    const game = armed();
    const before = game.ps.ammo[WeaponTag.ROCKET_LAUNCHER];

    // The launcher's 800ms cooldown means holding attack fires once, so the
    // shot has to be found rather than assumed.
    let fired = 0;
    for (let i = 0; i < 10; i++) {
      if (game.step({ ...still, attack: true }).fired) {
        fired++;
      }
    }
    expect(fired).toBe(1);
    expect(game.ps.ammo[WeaponTag.ROCKET_LAUNCHER]).toBe(before - 1);
  });

  it('will not fire at zero', () => {
    const game = armed();
    game.ps.ammo[WeaponTag.ROCKET_LAUNCHER] = 0;

    let fired = 0;
    for (let i = 0; i < 400; i++) {
      if (game.step({ ...still, attack: true }).fired) {
        fired++;
      }
    }
    expect(fired).toBe(0);
    expect(game.missiles.length).toBe(0);
  });

  it('fires again once ammo is restored', () => {
    const game = armed();
    game.ps.ammo[WeaponTag.ROCKET_LAUNCHER] = 0;
    for (let i = 0; i < 20; i++) {
      game.step({ ...still, attack: true });
    }
    addAmmo(game.ps, WeaponTag.ROCKET_LAUNCHER, 1);

    let fired = 0;
    for (let i = 0; i < 200; i++) {
      if (game.step({ ...still, attack: true }).fired) {
        fired++;
      }
    }
    expect(fired).toBe(1);
    expect(game.ps.ammo[WeaponTag.ROCKET_LAUNCHER]).toBe(0);
  });
});

describe('a life owns its inventory', () => {
  const spawn = { origin: originOnFloor(0), yaw: 0 };

  it('clears armour, powerups, ammo AND the weapon itself on respawn', () => {
    const game = new Game({
      world: flatWorld(),
      weapon: Weapon.PLASMAGUN,
      spawn,
      origin: spawn.origin,
    });

    game.ps.armor = 100;
    game.ps.powerups[3] = 999999;
    addAmmo(game.ps, WeaponTag.RAILGUN, 20);
    game.ps.ammo[WeaponTag.PLASMAGUN] = 1;

    // Kill outright rather than by damage, so the test is about respawn and
    // not about the damage path.
    game.ps.health = 0;
    let respawned = false;
    for (let i = 0; i < 400 && !respawned; i++) {
      respawned = game.step(still).respawned !== null;
    }
    expect(respawned).toBe(true);

    expect(game.ps.armor).toBe(0);
    expect(game.ps.powerups[3]).toBe(0);
    expect(game.ps.ammo[WeaponTag.RAILGUN]).toBe(0);
    // A death costs the weapon too, not just its ammo -- carrying it across
    // would leave a course's later attempts starting from a different
    // loadout than its own placed pickups define, which is not a clean run.
    expect(game.weapon).toBe(Weapon.NONE);
    expect(game.ps.ammo[WeaponTag.PLASMAGUN]).toBe(0);
  });
});
