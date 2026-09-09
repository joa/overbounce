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
import { buildEntities } from '../../src/game/entities.js';
import type { MapEntity } from '../../src/game/entities.js';
import { axialBrush } from '../../src/collision/brush.js';
import type { CLeaf, CollisionModel } from '../../src/collision/model.js';
import { brushListModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID, CONTENTS_TRIGGER } from '../../src/physics/constants.js';
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

/**
 * A kill volume is the edge of the course, not part of the health budget
 * that `damage: false` switches off. q3dm17's void is a `dmg 9999`
 * trigger_hurt over a sky floor; with the switch swallowing it a player who
 * fell off the map landed on the sky and stood there, alive.
 */
describe('damage off, kill volumes', () => {
  function hurtWorld(dmg: string): { model: CollisionModel; entities: MapEntity[] } {
    const model = brushListModel([
      axialBrush([-2048, -2048, -64], [2048, 2048, 0], CONTENTS_SOLID),
    ]);
    const leafbrushes: number[] = Array.from(model.leafbrushes);
    const submodels: CollisionModel['submodels'] = [
      { mins: [-2048, -2048, -64], maxs: [2048, 2048, 0], leaf: model.leafs[0] },
    ];
    // The trigger volume over the spawn point, as submodel 1.
    model.brushes.push(axialBrush([-64, -64, 0], [64, 64, 128], CONTENTS_TRIGGER));
    const firstLeafBrush = leafbrushes.length;
    leafbrushes.push(model.brushes.length - 1);
    const leaf: CLeaf = {
      cluster: -1,
      area: -1,
      firstLeafBrush,
      numLeafBrushes: 1,
      firstLeafSurface: 0,
      numLeafSurfaces: 0,
    };
    submodels.push({ mins: [-64, -64, 0], maxs: [64, 64, 128], leaf });
    model.leafbrushes = Int32Array.from(leafbrushes);
    model.submodels = submodels;
    return {
      model,
      entities: buildEntities([{ classname: 'trigger_hurt', model: '*1', dmg }]),
    };
  }

  function run(dmg: string): { died: boolean; health: number; before: number } {
    const { model, entities } = hurtWorld(dmg);
    const g = new Game({ world: model, origin: [0, 0, 30], entities, damage: false });
    const before = g.ps.health;
    let died = false;
    for (let i = 0; i < 60; i++) {
      if (g.step({}).respawned === 'dead') {
        died = true;
      }
    }
    return { died, health: g.ps.health, before };
  }

  it('still dies in a volume that would kill in one touch', () => {
    expect(run('9999').died).toBe(true);
  });

  it('is untouched by a volume that only hurts', () => {
    const r = run('30');
    expect(r.died).toBe(false);
    expect(r.health).toBe(r.before);
  });
});
