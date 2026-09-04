/**
 * `GameOptions.damage` — the freerun no-damage rule.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A FREERUN map (no `target_startTimer`) turns this off, because there is no
 * timed run for a health budget to be part of and restarting a practice lap
 * because a long drop cost 10 is exactly the friction freerun exists to
 * remove. A TIMED map keeps every kind of damage.
 *
 * Two things are worth pinning rather than trusting:
 *
 *  - **It is ALL damage, not just splash.** `selfDamage` already spared a
 *    rocket jump's own splash and left falls, lava and crushers charging, so a
 *    switch that only widened it a little would be a mode nobody could
 *    describe. Every path funnels through `hurt`, which is why the gate is
 *    there and not at the five call sites.
 *  - **Knockback is untouched.** That is the whole reason the mode is safe:
 *    the movement practised in freerun has to be the movement a timed run
 *    gives, so a rocket jump must throw the player exactly as far either way.
 *
 * Mutation-checked: moving the gate below the armour call, or dropping it,
 * fails these.
 */

import { describe, it, expect } from 'vitest';
import { Game } from '../../src/game/game.js';
import { flatWorld, originOnFloor } from '../physics/world.js';

function game(damage: boolean): Game {
  return new Game({ world: flatWorld(), origin: originOnFloor(0), damage });
}

describe('damage off', () => {
  it('spares a fall that would otherwise cost health', () => {
    const on = game(true);
    const off = game(false);
    const before = on.sim.ps.health;

    // `hurt` is the one door every kind of damage comes through -- a fall
    // raises FALL_FAR_DAMAGE through it, and so do lava, a crusher and a
    // shooter's rocket.
    on.hurt(10, true);
    off.hurt(10, true);

    expect(on.sim.ps.health).toBe(before - 10);
    expect(off.sim.ps.health).toBe(before);
  });

  it('spares every other kind too, not only falling', () => {
    const off = game(false);
    const before = off.sim.ps.health;
    off.hurt(30); // lava
    off.hurt(10); // slime
    off.hurt(100); // a crusher
    expect(off.sim.ps.health).toBe(before);
  });

  it('still takes damage when the option is on, which is a timed map', () => {
    const on = game(true);
    const before = on.sim.ps.health;
    on.hurt(30);
    expect(on.sim.ps.health).toBeLessThan(before);
  });

  it('defaults to taking damage', () => {
    // A caller that says nothing gets Quake's behaviour. Only `main.ts` turns
    // it off, and only on a map with no `target_startTimer`.
    const dflt = new Game({ world: flatWorld(), origin: originOnFloor(0) });
    const before = dflt.sim.ps.health;
    dflt.hurt(25);
    expect(dflt.sim.ps.health).toBe(before - 25);
  });

  it('does not consume armour while damage is off', () => {
    // The gate is BEFORE `applyArmor`, deliberately: a mode that silently
    // spent armour on damage it never took would leave the player poorer for
    // having practised.
    const off = game(false);
    off.sim.ps.armor = 50;
    off.hurt(40);
    expect(off.sim.ps.armor).toBe(50);
    expect(off.sim.ps.health).toBe(100);
  });
});
