/**
 * Pickups: the table, the caps, and what powerups actually do.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The health caps are the part worth pinning. They are NOT uniform — the +5
 * shard and the +100 mega go to 200 while the +25 and +50 stop at 100 — and
 * that asymmetry is a rule, not an accident, so it needs a test that would fail
 * if someone "simplified" it.
 */

import { describe, it, expect } from 'vitest';
import {
  ARMOR_PROTECTION,
  ITEMS,
  ItemType,
  Powerup,
  QUAD_FACTOR,
  RESPAWN_ARMOR,
  RESPAWN_MEGAHEALTH,
  RESPAWN_POWERUP,
  applyArmor,
  findItem,
  hasPowerup,
  pickup,
  respawnTime,
} from '../../src/game/items.js';
import { createPlayerState } from '../../src/physics/types.js';
import { Game } from '../../src/game/game.js';
import { Weapon } from '../../src/game/weapons.js';
import { buildEntities } from '../../src/game/entities.js';
import { flatWorld, originOnFloor } from '../physics/world.js';

describe('the item table', () => {
  it('has the whole of bg_itemlist', () => {
    // 51 real entries; the C has a null at index 0 that the extractor drops.
    expect(ITEMS.length).toBeGreaterThan(40);
  });

  it('finds items by classname, case insensitively', () => {
    expect(findItem('item_armor_body')?.quantity).toBe(100);
    expect(findItem('ITEM_HEALTH_MEGA')?.quantity).toBe(100);
    expect(findItem('not_an_item')).toBeNull();
  });

  it('kept the model paths, which is the thing most likely to be transposed', () => {
    expect(findItem('item_armor_body')?.models[0]).toBe('models/powerups/armor/armor_red.md3');
    expect(findItem('item_armor_combat')?.models[0]).toBe('models/powerups/armor/armor_yel.md3');
    expect(findItem('item_quad')?.models[0]).toBe('models/powerups/instant/quad.md3');
  });

  it('kept the pickup sounds', () => {
    expect(findItem('item_armor_body')?.pickupSound).toBe('sound/misc/ar2_pkup.wav');
    expect(findItem('item_health_mega')?.pickupSound).toBe('sound/items/m_health.wav');
    expect(findItem('item_quad')?.pickupSound).toBe('sound/items/quaddamage.wav');
  });

  it('typed each item correctly', () => {
    expect(findItem('item_armor_shard')?.type).toBe(ItemType.ARMOR);
    expect(findItem('item_health_mega')?.type).toBe(ItemType.HEALTH);
    expect(findItem('item_quad')?.type).toBe(ItemType.POWERUP);
    expect(findItem('weapon_rocketlauncher')?.type).toBe(ItemType.WEAPON);
    expect(findItem('ammo_rockets')?.type).toBe(ItemType.AMMO);
  });

  it('tagged the powerups', () => {
    expect(findItem('item_quad')?.tag).toBe(Powerup.QUAD);
    expect(findItem('item_enviro')?.tag).toBe(Powerup.BATTLESUIT);
    expect(findItem('item_haste')?.tag).toBe(Powerup.HASTE);
    expect(findItem('item_invis')?.tag).toBe(Powerup.INVIS);
    expect(findItem('item_regen')?.tag).toBe(Powerup.REGEN);
  });
});

describe('respawn times', () => {
  it('uses 25s for armour and weapons, 120s for powerups', () => {
    expect(respawnTime(findItem('item_armor_body')!)).toBe(RESPAWN_ARMOR);
    expect(respawnTime(findItem('weapon_rocketlauncher')!)).toBe(RESPAWN_ARMOR);
    expect(respawnTime(findItem('item_quad')!)).toBe(RESPAWN_POWERUP);
  });

  it('respawns mega health on the ordinary health timer', () => {
    // The C says `#define RESPAWN_MEGAHEALTH 35//120` with the 120 commented
    // out, so despite the "mega health respawns slow" comment it is 35.
    expect(RESPAWN_MEGAHEALTH).toBe(35);
    expect(respawnTime(findItem('item_health_mega')!)).toBe(35);
  });
});

describe('armour', () => {
  it('adds and caps at twice max health', () => {
    const ps = createPlayerState();
    pickup(ps, findItem('item_armor_body')!, 0);
    expect(ps.armor).toBe(100);
    pickup(ps, findItem('item_armor_body')!, 0);
    expect(ps.armor).toBe(200);
    pickup(ps, findItem('item_armor_body')!, 0);
    expect(ps.armor).toBe(200);
  });

  it('gives yellow 50 and shards 5', () => {
    const ps = createPlayerState();
    pickup(ps, findItem('item_armor_combat')!, 0);
    expect(ps.armor).toBe(50);
    pickup(ps, findItem('item_armor_shard')!, 0);
    expect(ps.armor).toBe(55);
  });

  it('absorbs 66% of a hit, rounded up', () => {
    const ps = createPlayerState();
    ps.armor = 100;
    // ceil(50 * 0.66) = 33 absorbed, 17 through.
    expect(applyArmor(ps, 50)).toBe(17);
    expect(ps.armor).toBe(67);
    expect(ARMOR_PROTECTION).toBe(0.66);
  });

  it('never absorbs for free, even a 1-point hit', () => {
    // ceil(1 * 0.66) = 1, so a point of armour goes.
    const ps = createPlayerState();
    ps.armor = 10;
    expect(applyArmor(ps, 1)).toBe(0);
    expect(ps.armor).toBe(9);
  });

  it('absorbs only what is left when armour runs out', () => {
    const ps = createPlayerState();
    ps.armor = 5;
    expect(applyArmor(ps, 100)).toBe(95);
    expect(ps.armor).toBe(0);
  });

  it('passes damage straight through with no armour', () => {
    const ps = createPlayerState();
    expect(applyArmor(ps, 40)).toBe(40);
  });
});

describe('health', () => {
  it('caps ordinary health at 100', () => {
    const ps = createPlayerState();
    ps.health = 90;
    pickup(ps, findItem('item_health_large')!, 0); // +50
    expect(ps.health).toBe(100);
  });

  it('lets the mega and the shard go to 200', () => {
    // The asymmetry: only quantity 5 and quantity 100 exceed max health, which
    // is why a mega is worth so much more than its number suggests.
    const ps = createPlayerState();
    ps.health = 100;
    pickup(ps, findItem('item_health_mega')!, 0);
    expect(ps.health).toBe(200);

    const ps2 = createPlayerState();
    ps2.health = 100;
    pickup(ps2, findItem('item_health_small')!, 0);
    expect(ps2.health).toBe(105);
  });
});

describe('powerups', () => {
  it('stacks in time, not in strength', () => {
    const ps = createPlayerState();
    const quad = findItem('item_quad')!;

    pickup(ps, quad, 10_000);
    const first = ps.powerups[Powerup.QUAD];
    expect(first).toBe(10_000 + quad.quantity * 1000);

    pickup(ps, quad, 12_000);
    expect(ps.powerups[Powerup.QUAD]).toBe(first + quad.quantity * 1000);
  });

  it('snaps the start down to a whole second', () => {
    // "round timing to seconds to make multiple powerup timers count in sync"
    const ps = createPlayerState();
    pickup(ps, findItem('item_quad')!, 10_450);
    expect(ps.powerups[Powerup.QUAD] % 1000).toBe(0);
  });

  it('expires', () => {
    const ps = createPlayerState();
    pickup(ps, findItem('item_quad')!, 0);
    expect(hasPowerup(ps, Powerup.QUAD, 1000)).toBe(true);
    expect(hasPowerup(ps, Powerup.QUAD, 999_000)).toBe(false);
  });
});

describe('quad in the game loop', () => {
  function game(entities: ReturnType<typeof buildEntities> = []): Game {
    return new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      weapon: Weapon.ROCKET_LAUNCHER,
      entities,
      spawn: { origin: originOnFloor(0), yaw: 0 },
    });
  }

  /**
   * One shot, and the health it costs.
   *
   * Health is raised first because a quaded rocket does 150 to its own owner
   * and the player would otherwise die and respawn, which resets health and
   * makes the measurement read zero -- correct behaviour, useless number.
   */
  const selfDamageOfOneShot = (quad: boolean): number => {
    const g = game();
    g.ps.health = 1000;
    if (quad) {
      g.ps.powerups[Powerup.QUAD] = 999_999;
    }
    const before = g.ps.health;
    // The rocket detonates on the tick it is fired: at pitch 89 the 50ms
    // prestep already puts it in the floor.
    g.step({ attack: true, pitch: 89 });
    return before - g.ps.health;
  };

  it('triples rocket damage, which here is your own damage', () => {
    // Quad is a liability in a game with no enemies: the only thing you can
    // splash is yourself, so it triples what a rocket jump costs.
    const plain = selfDamageOfOneShot(false);
    const quaded = selfDamageOfOneShot(true);

    expect(plain).toBeGreaterThan(0);
    expect(quaded).toBeCloseTo(plain * QUAD_FACTOR, 0);
  });

  it('lets battlesuit make rocket jumping free', () => {
    // Battlesuit blocks radius damage outright, and splash is the only damage
    // in this game -- so it is a movement powerup here, not a defensive one.
    const g = game();
    g.ps.powerups[Powerup.BATTLESUIT] = 999_999;
    const before = g.ps.health;
    g.run(8, { attack: true, pitch: 89 });
    expect(g.ps.health).toBe(before);
  });

  it('spends armour before health', () => {
    const g = game();
    g.ps.armor = 200;
    const health = g.ps.health;
    g.run(8, { attack: true, pitch: 89 });
    expect(g.ps.armor).toBeLessThan(200);
    // Most of it went to armour, so health barely moved.
    expect(health - g.ps.health).toBeLessThan(health * 0.5);
  });
});

describe('items placed in a map', () => {
  const entities = buildEntities([
    { classname: 'item_armor_body', origin: '0 0 40' },
    { classname: 'item_quad', origin: '200 0 40' },
  ]);

  it('spawns them and lets the player pick them up', () => {
    const g = new Game({
      world: flatWorld(),
      origin: [0, 0, 40],
      entities,
      spawn: { origin: [0, 0, 40], yaw: 0 },
    });
    expect(g.itemWorld!.items).toHaveLength(2);

    const frame = g.step({});
    const picked = frame.items.find((e) => e.kind === 'pickup');
    expect(picked?.placed.item.classname).toBe('item_armor_body');
    expect(g.ps.armor).toBe(100);
  });

  it('takes the item away and brings it back on its timer', () => {
    const g = new Game({
      world: flatWorld(),
      origin: [0, 0, 40],
      entities,
      spawn: { origin: [0, 0, 40], yaw: 0 },
    });
    g.step({});
    const armor = g.itemWorld!.items[0];
    expect(armor.present).toBe(false);
    expect(armor.respawnAt).toBe(RESPAWN_ARMOR * 1000 + g.time);

    // Not back early...
    g.time = armor.respawnAt - 1000;
    g.itemWorld!.update(g.ps, g.time);
    expect(armor.present).toBe(false);

    // ...and back on time, with an event so a sound can be played.
    g.time = armor.respawnAt;
    const events = g.itemWorld!.update(g.ps, g.time);
    expect(armor.present).toBe(true);
    expect(events.some((e) => e.kind === 'respawn')).toBe(true);
  });

  it('does not let a dead player pick anything up', () => {
    const g = new Game({
      world: flatWorld(),
      origin: [0, 0, 40],
      entities,
      spawn: { origin: [0, 0, 40], yaw: 0 },
    });
    g.ps.health = 0;
    const events = g.itemWorld!.update(g.ps, 0);
    expect(events).toHaveLength(0);
  });

  it('drops items to the floor, as FinishSpawningItem does', () => {
    // A mapper places items roughly and lets the game settle them.
    const g = new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      entities: buildEntities([{ classname: 'item_armor_body', origin: '0 0 500' }]),
    });
    expect(g.itemWorld!.items[0].origin[2]).toBeLessThan(100);
  });

  it('honours the suspended spawnflag', () => {
    const g = new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      entities: buildEntities([
        { classname: 'item_armor_body', origin: '0 0 500', spawnflags: '1' },
      ]),
    });
    expect(g.itemWorld!.items[0].origin[2]).toBe(500);
  });
});
