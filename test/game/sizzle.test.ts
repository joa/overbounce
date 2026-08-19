/**
 * Lava and slime damage, and the pickup gate.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Both are ports with exact numbers in the C, so the expectations here come
 * from `g_active.c` and `bg_misc.c` rather than from what the code prints.
 */

import { describe, it, expect } from 'vitest';
import { axialBrush } from '../../src/collision/brush.js';
import type { CollisionModel } from '../../src/collision/model.js';
import { brushListModel } from '../../src/collision/model.js';
import { Game } from '../../src/game/game.js';
import { canItemBeGrabbed, findItem } from '../../src/game/items.js';
import {
  CONTENTS_LAVA,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
} from '../../src/physics/constants.js';
import { createPlayerState } from '../../src/physics/types.js';
import { Powerup } from '../../src/game/items.js';

/** A floor with a pool of `contents` sitting on top of it. */
function poolWorld(contents: number, depth: number): CollisionModel {
  return brushListModel([
    axialBrush([-1024, -1024, -64], [1024, 1024, 0], CONTENTS_SOLID),
    axialBrush([-256, -256, 0], [256, 256, depth], contents),
  ]);
}

/** Run `ms` of game time standing still, and report the health lost. */
function stand(game: Game, ms: number): number {
  const before = game.ps.health;
  game.run(Math.round(ms / 8), {});
  return before - game.ps.health;
}

/**
 * The size of the FIRST hit, running from spawn.
 *
 * Two things make this less obvious than "settle, then sample one tick", and
 * both were got wrong first:
 *
 *  - Settling is not free. Dropping into a shallow pool takes a hit on the way
 *    and sets the 700ms `pain_debounce_time`, so a sample straight afterwards
 *    lands inside the quiet window and reads zero.
 *  - Settling past the SECOND hit is worse. Submerged in lava at 90 a go, the
 *    player is on 10 health by then and the next hit kills them -- so the
 *    measurement came back as a respawn, health going UP by 115.
 *
 * Catching the first change from tick zero avoids both, and works whether the
 * player starts in the pool or falls into it.
 */
function firstHit(game: Game): number {
  for (let i = 0; i < 200; i++) {
    const before = game.ps.health;
    game.run(1, {});
    if (game.ps.health !== before) {
      return before - game.ps.health;
    }
  }
  return 0;
}

describe('P_WorldEffects: sizzle damage', () => {
  it('does 30 a go in lava at waterlevel 1', () => {
    // `G_Damage(ent, ..., 30 * waterlevel, 0, MOD_LAVA)`. A player standing on
    // the floor of a shallow pool is waterlevel 1.
    const game = new Game({ world: poolWorld(CONTENTS_LAVA, 16), origin: [0, 0, 30] });
    expect(firstHit(game)).toBe(30);
  });

  it('waits 700ms between hits rather than burning every tick', () => {
    /*
     * `pain_debounce_time`. The lava block only READS the gate; what sets it is
     * `P_DamageFeedback` (g_active.c:73), on any frame the player took damage.
     *
     * Porting it is not optional: Quake runs `G_RunFrame` at 50ms and this game
     * layer runs on the 8ms physics tick, so without the debounce lava would
     * do 30 damage 125 times a second and no lava map would be playable.
     */
    const game = new Game({ world: poolWorld(CONTENTS_LAVA, 16), origin: [0, 0, 30] });

    // One hit, then silence for the rest of the window.
    expect(firstHit(game)).toBe(30);
    expect(stand(game, 600)).toBe(0);

    // Past 700ms, it bites again.
    expect(stand(game, 200)).toBe(30);
  });

  it('scales with how deep you are', () => {
    // Submerged is waterlevel 3, so 90 a go -- which is why falling into a
    // lava pit is not survivable and clipping its edge usually is.
    const game = new Game({ world: poolWorld(CONTENTS_LAVA, 200), origin: [0, 0, 30] });
    expect(firstHit(game)).toBe(90);
  });

  it('does a third as much in slime', () => {
    const game = new Game({ world: poolWorld(CONTENTS_SLIME, 16), origin: [0, 0, 30] });
    expect(firstHit(game)).toBe(10);
  });

  it('does NOTHING at all with a battlesuit', () => {
    /*
     * Not the usual halving. `P_WorldEffects` sends an event and applies no
     * damage whatsoever when `envirosuit` is set -- so a suited player wades
     * through lava untouched, which is what makes the suit worth a detour on a
     * lava map rather than a marginal upgrade.
     */
    const game = new Game({ world: poolWorld(CONTENTS_LAVA, 200), origin: [0, 0, 30] });
    game.ps.powerups[Powerup.BATTLESUIT] = 60_000;
    game.run(40, {});

    expect(stand(game, 2000)).toBe(0);
  });

  it('kills, and the kill respawns the player', () => {
    const game = new Game({ world: poolWorld(CONTENTS_LAVA, 200), origin: [0, 0, 30] });
    game.run(40, {});
    // 100hp against 90 a go is two hits, so ~1.4 seconds.
    const frames = game.run(400, {});
    expect(frames.some((f) => f.respawned === 'dead')).toBe(true);
  });

  it('leaves a player standing in plain water alone', () => {
    // The gate is `watertype & (CONTENTS_LAVA|CONTENTS_SLIME)`, so water is not
    // damaging -- only drowning is, and drowning is not ported.
    const game = new Game({ world: poolWorld(CONTENTS_WATER, 200), origin: [0, 0, 30] });
    game.run(40, {});
    expect(stand(game, 2000)).toBe(0);
  });
});

describe('BG_CanItemBeGrabbed', () => {
  const ps = () => createPlayerState();

  it('refuses an ordinary health at full health', () => {
    // The reported bug: at 100 the +25 was still consumed. The effect clamped,
    // so nothing was gained, and the item vanished and began respawning.
    const p = ps();
    p.health = 100;
    expect(canItemBeGrabbed(p, findItem('item_health')!)).toBe(false);
    expect(canItemBeGrabbed(p, findItem('item_health_large')!)).toBe(false);
  });

  it('accepts a health SHARD past 100, up to 200', () => {
    // "small and mega healths will go over the max" -- quantity 5 or 100.
    const p = ps();
    p.health = 100;
    expect(canItemBeGrabbed(p, findItem('item_health_small')!)).toBe(true);
    expect(canItemBeGrabbed(p, findItem('item_health_mega')!)).toBe(true);

    p.health = 200;
    expect(canItemBeGrabbed(p, findItem('item_health_small')!)).toBe(false);
    expect(canItemBeGrabbed(p, findItem('item_health_mega')!)).toBe(false);
  });

  it('takes an ordinary health below 100', () => {
    const p = ps();
    p.health = 99;
    expect(canItemBeGrabbed(p, findItem('item_health')!)).toBe(true);
  });

  it('caps armour at 200 with no shard exception', () => {
    /*
     * The asymmetry that is easy to "fix" wrongly. Health has an over-max route
     * and armour does not: the shard is 5 points but obeys the same 200 ceiling
     * as the red. id wrote it that way; do not symmetrise it.
     */
    const p = ps();
    p.armor = 200;
    expect(canItemBeGrabbed(p, findItem('item_armor_shard')!)).toBe(false);
    expect(canItemBeGrabbed(p, findItem('item_armor_body')!)).toBe(false);

    p.armor = 199;
    expect(canItemBeGrabbed(p, findItem('item_armor_shard')!)).toBe(true);
  });

  it('always takes a weapon', () => {
    // "weapons are always picked up" -- no cap, whatever the ammo count.
    const p = ps();
    const rl = findItem('weapon_rocketlauncher')!;
    p.ammo[rl.tag] = 999;
    expect(canItemBeGrabbed(p, rl)).toBe(true);
  });

  it('stops ammo at 200', () => {
    const p = ps();
    const ammo = findItem('ammo_rockets')!;
    p.ammo[ammo.tag] = 200;
    expect(canItemBeGrabbed(p, ammo)).toBe(false);
    p.ammo[ammo.tag] = 199;
    expect(canItemBeGrabbed(p, ammo)).toBe(true);
  });
});

describe('?selfdamage=0', () => {
  /** Floor to stand on, and a rocket fired straight down into it. */
  const floor = (): CollisionModel =>
    brushListModel([axialBrush([-1024, -1024, -64], [1024, 1024, 0], CONTENTS_SOLID)]);

  /** Rocket-jump and report the peak height reached and the health lost. */
  function rocketJump(selfDamage: boolean): { rise: number; lost: number } {
    const game = new Game({
      world: floor(),
      origin: [0, 0, 30],
      weapon: 1, // Weapon.ROCKET_LAUNCHER
      selfDamage,
    });
    game.run(40, {});
    const startHealth = game.ps.health;
    const startZ = game.ps.origin[2];

    // Look straight down and fire while jumping, which is a rocket jump.
    // `up: 127` is jump; `pitch: 90` is looking straight down, which is where
    // a rocket has to go for the splash to launch you.
    const frames = game.run(120, { attack: true, up: 127, pitch: 90 });
    const peak = Math.max(...frames.map((f) => f.origin[2]));
    return { rise: peak - startZ, lost: startHealth - game.ps.health };
  }

  it('keeps the knockback and drops only the health loss', () => {
    /*
     * The whole point of the mode, and the reason it can be a one-line change:
     * id's own comment says the self-damage halving is "calculated after
     * knockback, so rocket jumping works". Knockback is already applied by the
     * time that line runs, so zeroing the damage cannot touch the movement.
     *
     * A no-damage run therefore has to rise by exactly as much as a normal one.
     * If these two numbers ever diverge, the flag has been moved to the wrong
     * side of the knockback and every jump height in the game just changed.
     */
    const on = rocketJump(true);
    const off = rocketJump(false);

    expect(off.rise).toBeCloseTo(on.rise, 5);
    expect(on.lost).toBeGreaterThan(0);
    expect(off.lost).toBe(0);
  });
});
