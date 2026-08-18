/**
 * What a pickup is supposed to look like and sound like.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Two bugs live here, and both were invisible to the physics tests because
 * neither changes a number the simulation produces:
 *
 *  - Walking over a weapon switched `game.weapon` but the model in the
 *    player's hands never changed, because it was loaded once at startup.
 *    `cg_weapons.c` resolves it from the CURRENT weapon every frame, through
 *    the weapon item's own world model -- `findWeaponItem` is that lookup.
 *  - Powerups made no sound. The sound system deliberately drops anything it
 *    has not decoded yet, and nothing preloaded the item table's pickup
 *    sounds, so the first pickup of anything was silent -- and for a powerup
 *    on a 120-second respawn, the first is the only one.
 *
 * `main.ts` cannot be imported from Node, so the parts worth pinning were
 * pulled out into functions that can be.
 */

import { describe, it, expect } from 'vitest';
import {
  ITEMS,
  ItemType,
  WeaponTag,
  findItem,
  findWeaponItem,
} from '../../src/game/items.js';
import { SOUNDS, itemPickupSounds, mapPickupSounds } from '../../src/audio/sound.js';
import { Game } from '../../src/game/game.js';
import { Weapon, WEAPON_TAG, weaponFromTag } from '../../src/game/weapons.js';
import { buildEntities } from '../../src/game/entities.js';
import { flatWorld, originOnFloor } from '../physics/world.js';

describe('the model a weapon is held as', () => {
  it('finds the IT_WEAPON item carrying each tag, as CG_RegisterWeapon does', () => {
    expect(findWeaponItem(WeaponTag.ROCKET_LAUNCHER)?.classname).toBe(
      'weapon_rocketlauncher',
    );
    expect(findWeaponItem(WeaponTag.GRENADE_LAUNCHER)?.classname).toBe(
      'weapon_grenadelauncher',
    );
    expect(findWeaponItem(WeaponTag.PLASMAGUN)?.classname).toBe('weapon_plasmagun');
  });

  it('does not confuse a weapon with the ammo box that shares its tag', () => {
    // ammo_rockets carries WP_ROCKET_LAUNCHER too. CG_RegisterWeapon's loop
    // tests giType as well as giTag for exactly this reason, and dropping the
    // type test puts a box of rockets in the player's hands.
    expect(findItem('ammo_rockets')?.tag).toBe(WeaponTag.ROCKET_LAUNCHER);
    expect(findWeaponItem(WeaponTag.ROCKET_LAUNCHER)?.type).toBe(ItemType.WEAPON);
  });

  it('gives every fireable weapon a world model to hang off tag_weapon', () => {
    // A missing model here is a player holding nothing, which reads as a
    // rendering bug rather than a table bug.
    for (const weapon of [
      Weapon.ROCKET_LAUNCHER,
      Weapon.GRENADE_LAUNCHER,
      Weapon.PLASMAGUN,
    ]) {
      const item = findWeaponItem(WEAPON_TAG[weapon]);
      expect(item?.models[0]).toMatch(/^models\/weapons2\/.*\.md3$/);
    }
  });

  it('has nothing to show for Weapon.NONE', () => {
    expect(findWeaponItem(WEAPON_TAG[Weapon.NONE])).toBeNull();
  });

  it('resolves the model of whatever the player just picked up', () => {
    // The end-to-end shape of the fix: pick a grenade launcher up while
    // holding a rocket launcher, and the model that should now be rendered is
    // the grenade launcher's. Before the fix the render side never re-read
    // `game.weapon` at all, so this was always the rocket launcher.
    const g = new Game({
      world: flatWorld(),
      origin: [0, 0, 40],
      weapon: Weapon.ROCKET_LAUNCHER,
      entities: buildEntities([
        { classname: 'weapon_grenadelauncher', origin: '0 0 40' },
      ]),
      spawn: { origin: [0, 0, 40], yaw: 0 },
    });

    const before = findWeaponItem(WEAPON_TAG[g.weapon])?.models[0];
    const frame = g.step({});

    expect(frame.items.some((e) => e.kind === 'pickup')).toBe(true);
    expect(g.weapon).toBe(Weapon.GRENADE_LAUNCHER);
    const after = findWeaponItem(WEAPON_TAG[g.weapon])?.models[0];
    expect(after).toBe('models/weapons2/grenadel/grenadel.md3');
    expect(after).not.toBe(before);
  });

  it('keeps the current weapon when the pickup is one Overbounce cannot fire', () => {
    // A deathmatch map is full of railguns. Switching to one would leave the
    // player holding a gun that does nothing -- so the model must not change
    // either, and `weaponFromTag` returning NONE is what says so.
    const g = new Game({
      world: flatWorld(),
      origin: [0, 0, 40],
      weapon: Weapon.ROCKET_LAUNCHER,
      entities: buildEntities([{ classname: 'weapon_railgun', origin: '0 0 40' }]),
      spawn: { origin: [0, 0, 40], yaw: 0 },
    });

    g.step({});
    expect(weaponFromTag(WeaponTag.RAILGUN)).toBe(Weapon.NONE);
    expect(g.weapon).toBe(Weapon.ROCKET_LAUNCHER);
    // ...but the ammo is still credited: the pickup was real.
    expect(g.ps.ammo[WeaponTag.RAILGUN]).toBe(10);
  });
});

describe('what a pickup sounds like', () => {
  it('plays an ordinary item its own sound, and only that', () => {
    expect(itemPickupSounds(findItem('item_armor_body')!)).toEqual([
      'sound/misc/ar2_pkup.wav',
    ]);
    expect(itemPickupSounds(findItem('item_health_mega')!)).toEqual([
      'sound/items/m_health.wav',
    ]);
  });

  it('layers n_health under a powerup, the way the two events do', () => {
    // cg_event.c: EV_ITEM_PICKUP plays n_healthSound for IT_POWERUP because
    // "powerups and team items will have a separate global sound", and
    // EV_GLOBAL_ITEM_PICKUP then plays the powerup's own. A single player is
    // inside the broadcast and hears both.
    expect(itemPickupSounds(findItem('item_quad')!)).toEqual([
      'sound/items/n_health.wav',
      'sound/items/quaddamage.wav',
    ]);
    expect(itemPickupSounds(findItem('item_haste')!)).toEqual([
      'sound/items/n_health.wav',
      'sound/items/haste.wav',
    ]);
    expect(itemPickupSounds(findItem('item_enviro')!)).toEqual([
      'sound/items/n_health.wav',
      'sound/items/protect.wav',
    ]);
    expect(SOUNDS.itemPickupLocal).toBe('sound/items/n_health.wav');
  });

  it('says nothing for a flag, which has no pickup sound in the table', () => {
    // team_CTF_redflag's pickup_sound is NULL in bg_itemlist, so only the
    // IT_TEAM local sound survives. A null must not become "null.wav".
    expect(findItem('team_CTF_redflag')?.pickupSound).toBeNull();
    expect(itemPickupSounds(findItem('team_CTF_redflag')!)).toEqual([
      'sound/items/n_health.wav',
    ]);
  });

  it('precaches every sound the items in THIS map can make', () => {
    // The actual bug: quad, haste and the battle suit were not in the preload
    // list, `play()` drops an undecoded sound by design, and a powerup takes
    // 120 seconds to come back -- so they were silent every single time.
    const g = new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      entities: buildEntities([
        { classname: 'item_quad', origin: '400 0 40' },
        { classname: 'item_haste', origin: '600 0 40' },
        { classname: 'item_enviro', origin: '800 0 40' },
        { classname: 'item_armor_body', origin: '1000 0 40' },
      ]),
    });

    const paths = mapPickupSounds(g.itemWorld!.items);
    expect(paths).toContain('sound/items/quaddamage.wav');
    expect(paths).toContain('sound/items/haste.wav');
    expect(paths).toContain('sound/items/protect.wav');
    expect(paths).toContain('sound/misc/ar2_pkup.wav');
    expect(paths).toContain('sound/items/n_health.wav');
  });

  it('lists each sound once however many items share it', () => {
    // Four shards would otherwise queue four decodes of the same file.
    const g = new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      entities: buildEntities([
        { classname: 'item_armor_shard', origin: '400 0 40' },
        { classname: 'item_armor_shard', origin: '600 0 40' },
        { classname: 'item_quad', origin: '800 0 40' },
        { classname: 'item_haste', origin: '1000 0 40' },
      ]),
    });

    const paths = mapPickupSounds(g.itemWorld!.items);
    expect(paths.length).toBe(new Set(paths).size);
    // n_health is shared by both powerups and appears once.
    expect(paths.filter((p) => p === 'sound/items/n_health.wav')).toHaveLength(1);
  });

  it('has a sound for every item that can be picked up at all', () => {
    // A table entry with neither a pickup sound nor a powerup type would be a
    // silent pickup no matter what the preload does. Only the flags are
    // allowed to be quiet on their own, and they get n_health.
    for (const item of ITEMS) {
      expect(itemPickupSounds(item).length).toBeGreaterThan(0);
    }
  });
});
