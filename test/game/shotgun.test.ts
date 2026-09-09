/**
 * The shotgun: eleven seeded pellets, a basis rebuilt from one vector, and
 * no snap.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The assertions that matter are the ones a port-by-analogy with the machine
 * gun or the rail would get wrong:
 *
 *  - the randomness is `Q_crandom`, a seeded LCG in a 32-bit int, checked
 *    here against values worked out from the C by hand and against a BigInt
 *    oracle -- never against the port itself.
 *  - the pattern's `right`/`up` come from `PerpendicularVector` on the
 *    snapped `forward * 4096`, not from the view. Aimed down +X that basis
 *    is `(0,1,0)` / `(0,0,1)`, and seed 0's first pellet lands where the
 *    hand calculation says.
 *  - a pellet's impact is NOT snapped: a wall at 4000 reads 3999.875, where
 *    the rail's reads 3999.
 *  - `SURF_NOIMPACT` precedes damage, the bullet's order and the rail's
 *    opposite: a no-impact door is not used.
 *  - 1000ms is exactly 125 ticks; haste truncates it to 769.
 */

import { describe, it, expect } from 'vitest';
import { Game } from '../../src/game/game.js';
import {
  Weapon,
  FIRE_TIME,
  FLASH_DLIGHT_COLOR,
  WEAPON_START_AMMO,
  WEAPON_TAG,
  calcMuzzlePoint,
  weaponFromTag,
} from '../../src/game/weapons.js';
import {
  DEFAULT_SHOTGUN_COUNT,
  DEFAULT_SHOTGUN_DAMAGE,
  DEFAULT_SHOTGUN_SPREAD,
  SHOTGUN_ORIGIN2_SCALE,
  shotgunBasis,
  shotgunPattern,
} from '../../src/game/shotgun.js';
import { qCrandom, qRand, qRandom } from '../../src/math/random.js';
import type { Seed } from '../../src/math/random.js';
import { Powerup, WeaponTag } from '../../src/game/items.js';
import { MoverState } from '../../src/game/movers.js';
import type { MapEntity } from '../../src/game/entities.js';
import { axialBrush } from '../../src/collision/brush.js';
import type { CLeaf, CollisionModel } from '../../src/collision/model.js';
import { brushListModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID, ENTITYNUM_WORLD, SURF_NOIMPACT } from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';
import { angleVectors } from '../../src/math/angles.js';
import { flatWorld, originOnFloor } from '../physics/world.js';

/**
 * Aimed 30 degrees down. The cone is +-4.9 degrees per axis, so every pellet
 * leaves at between 25 and 35 degrees below level and reaches the floor
 * within ~100 units -- all eleven land, on a flat world, every time. At the
 * machine gun test's 5 degrees the flattest pellet would skim out past the
 * floor's edge.
 */
const PITCH = 30;

/** Flat ground plus a wall at `x` across the whole +X view, `flags` on it. */
function wallWorld(x: number, flags = 0): CollisionModel {
  return brushListModel([
    axialBrush([-8192, -8192, -512], [16384, 8192, 0], CONTENTS_SOLID),
    axialBrush([x, -8192, 0], [x + 64, 8192, 4096], CONTENTS_SOLID, flags),
  ]);
}

function gunner(world: CollisionModel = flatWorld()): Game {
  const game = new Game({
    world,
    origin: originOnFloor(0),
    weapon: Weapon.SHOTGUN,
  });
  for (let i = 0; i < 200; i++) {
    game.step({});
  }
  return game;
}

/** Hold the trigger until one blast leaves, and return it. */
function oneBlast(game: Game, input: { pitch?: number; yaw?: number } = {}) {
  for (let i = 0; i < 400; i++) {
    const f = game.step({ attack: true, ...input });
    if (f.shotgun.length) {
      return { blast: f.shotgun[0], frame: f };
    }
  }
  throw new Error('no blast fired');
}

function aim(game: Game): { muzzle: number[]; forward: number[] } {
  const forward = vec3();
  angleVectors(game.ps.viewangles, forward, null, null);
  const muzzle = vec3();
  calcMuzzlePoint(game.ps, forward, muzzle);
  return { muzzle: [...muzzle], forward: [...forward] };
}

describe('the constants', () => {
  it('are id’s', () => {
    // bg_public.h:38-39, g_weapon.c:263, 358.
    expect(DEFAULT_SHOTGUN_SPREAD).toBe(700);
    expect(DEFAULT_SHOTGUN_COUNT).toBe(11);
    expect(DEFAULT_SHOTGUN_DAMAGE).toBe(10);
    expect(SHOTGUN_ORIGIN2_SCALE).toBe(4096);
    // bg_pmove.c:1654-1655.
    expect(FIRE_TIME[Weapon.SHOTGUN]).toBe(1000);
    // bg_misc.c:215.
    expect(WEAPON_START_AMMO[Weapon.SHOTGUN]).toBe(10);
    // cg_weapons.c:737.
    expect(FLASH_DLIGHT_COLOR[Weapon.SHOTGUN]).toEqual([1, 1, 0]);
    // The item system's tag is Quake's WP_SHOTGUN (3), ours is 6. Both
    // directions of the crossing.
    expect(WEAPON_TAG[Weapon.SHOTGUN]).toBe(WeaponTag.SHOTGUN);
    expect(weaponFromTag(WeaponTag.SHOTGUN)).toBe(Weapon.SHOTGUN);
  });
});

/**
 * Worked out from the C, not from what the port returns:
 *
 *     *seed = (69069 * *seed + 1);                      // int: wraps at 2^32
 *     return ( Q_rand( seed ) & 0xffff ) / (float)0x10000;
 *     return 2.0 * ( Q_random( seed ) - 0.5 );
 */
describe('Q_rand / Q_random / Q_crandom', () => {
  it('match hand-computed values from seed 0', () => {
    const s: Seed = { seed: 0 };
    // 69069 * 0 + 1 = 1; 1 & 0xffff = 1; 1 / 65536.
    expect(qRandom(s)).toBe(1 / 65536);
    expect(s.seed).toBe(1);
    // 69069 * 1 + 1 = 69070; & 0xffff = 3534; 3534 / 65536.
    expect(qRandom(s)).toBe(3534 / 65536);
    expect(s.seed).toBe(69070);
    // 69069 * 69070 + 1 = 4770595831, which is past 2^32: wraps to
    // 475628535; & 0xffff = 33783.
    expect(qRand(s)).toBe(475628535);
    expect(33783 / 65536).toBe(0.5154876708984375);
  });

  it('crandom maps 0..1 onto -1..1', () => {
    const s: Seed = { seed: 0 };
    // 2 * (1/65536 - 0.5) = 2/65536 - 1.
    expect(qCrandom(s)).toBe(2 / 65536 - 1);
    // 2 * (3534/65536 - 0.5).
    expect(qCrandom(s)).toBe(2 * (3534 / 65536 - 0.5));
  });

  it('wraps at 32 bits like a C int, for a thousand steps', () => {
    // An independent oracle: the same recurrence in BigInt, reduced mod 2^32
    // and reinterpreted as a signed 32-bit int the way `*seed` is stored.
    const s: Seed = { seed: 0x7fffffff };
    let oracle = 0x7fffffffn;
    for (let i = 0; i < 1000; i++) {
      oracle = (69069n * oracle + 1n) & 0xffffffffn;
      const signed = oracle >= 0x80000000n ? oracle - 0x100000000n : oracle;
      expect(qRand(s)).toBe(Number(signed));
    }
    // And the first step from that seed, by hand: 69069 * (2^31 - 1) + 1 =
    // 69069 * 2^31 - 69068; 69069 is odd so 69069 * 2^31 = 2^31 (mod 2^32);
    // 2^31 - 69068 = 2147414580.
    const t: Seed = { seed: 0x7fffffff };
    expect(qRand(t)).toBe(2147414580);
  });
});

describe('the pattern', () => {
  it('rebuilds right and up from origin2 with PerpendicularVector', () => {
    // Aimed straight down +X: `PerpendicularVector` picks the axis the
    // direction leans on least -- the first zero component, Y -- so right is
    // +Y and up = forward x right = +Z. Note right is +Y where the view's
    // `right` for yaw 0 is -Y: the pattern is mirrored relative to the
    // player's own axes, and that is id's.
    const { forward, right, up } = shotgunBasis(vec3(4096, 0, 0));
    expect([...forward]).toEqual([1, 0, 0]);
    expect([...right]).toEqual([0, 1, 0]);
    expect([...up]).toEqual([0, 0, 1]);
  });

  it('puts seed 0’s first pellet where the hand calculation says', () => {
    const ends = shotgunPattern(vec3(0, 0, 0), vec3(4096, 0, 0), { seed: 0 });
    expect(ends).toHaveLength(DEFAULT_SHOTGUN_COUNT);
    // r = crandom0 * 700 * 16, crandom0 = 2/65536 - 1 = -0.999969482421875:
    //   -0.999969482421875 * 700 = -699.9786376953125 (exact in float),
    //   * 16 = -11199.658203125.
    // u = crandom1 * 700 * 16, crandom1 = 2 * (3534/65536 - 0.5) =
    //   -0.89215087890625; * 700 = -624.505615234375 (exact); * 16 =
    //   -9992.08984375.
    // end = origin + 131072 * forward + r * right + u * up.
    expect([...ends[0]]).toEqual([131072, -11199.658203125, -9992.08984375]);
  });

  it('is a pure function of the seed: same seed, same eleven; different seed, different', () => {
    const o = vec3(100, -200, 30);
    const o2 = vec3(4000, 800, -300);
    const a = shotgunPattern(o, o2, { seed: 77 }).map((e) => [...e]);
    const b = shotgunPattern(o, o2, { seed: 77 }).map((e) => [...e]);
    const c = shotgunPattern(o, o2, { seed: 78 }).map((e) => [...e]);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('keeps every pellet inside the cone', () => {
    // The offset at the far end is at most 700 * 16 per axis, so the
    // perpendicular distance from the aim line is at most sqrt(2) * 11200 at
    // 131072 out.
    const limit = Math.SQRT2 * DEFAULT_SHOTGUN_SPREAD * 16;
    for (let seed = 0; seed < 256; seed++) {
      const ends = shotgunPattern(vec3(0, 0, 0), vec3(4096, 0, 0), { seed });
      for (const e of ends) {
        expect(e[0]).toBe(131072);
        expect(Math.hypot(e[1], e[2])).toBeLessThanOrEqual(limit);
      }
    }
  });
});

describe('firing', () => {
  it('fires exactly every 125 ticks, and every 769ms under haste', () => {
    const game = gunner();
    const ticks: number[] = [];
    for (let i = 0; i < 700; i++) {
      if (game.step({ attack: true }).fired) {
        ticks.push(i);
      }
    }
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < ticks.length; i++) {
      // 1000 / 8 is a whole number; nothing carries.
      expect(ticks[i] - ticks[i - 1]).toBe(125);
    }

    // `addTime /= 1.3` on an int: trunc(1000 / 1.3) = 769, not 769.23.
    const hasted = gunner();
    hasted.ps.powerups[Powerup.HASTE] = 999_999;
    const hastedTicks: number[] = [];
    for (let i = 0; i < 700; i++) {
      if (hasted.step({ attack: true }).fired) {
        hastedTicks.push(i);
      }
    }
    expect(hastedTicks.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < hastedTicks.length; i++) {
      const gap = (hastedTicks[i] - hastedTicks[i - 1]) * 8;
      // 769 / 8 = 96.125 ticks: 96 or 97.
      expect(gap).toBeGreaterThanOrEqual(768);
      expect(gap).toBeLessThanOrEqual(776);
    }
  });

  it('spends one shell of ten', () => {
    const game = gunner();
    const tag = WEAPON_TAG[Weapon.SHOTGUN];
    expect(game.ps.ammo[tag]).toBe(10);
    oneBlast(game);
    expect(game.ps.ammo[tag]).toBe(9);
  });

  it('lands all eleven pellets on the floor, inside the cone', () => {
    const game = gunner();
    const { blast } = oneBlast(game, { pitch: PITCH });
    const { muzzle, forward } = aim(game);

    expect(blast.seed).toBeGreaterThanOrEqual(0);
    expect(blast.seed).toBeLessThanOrEqual(255);
    expect(blast.pellets).toHaveLength(DEFAULT_SHOTGUN_COUNT);
    expect(blast.muzzleInWater).toBe(false);
    expect([...blast.muzzle]).toEqual(muzzle);
    // origin2 is forward * 4096, snapped to integers by the q_shared.h
    // MACRO -- a `(int)` cast, so truncated toward zero, not rounded. 4096
    // is a power of two so the product is exact and the truncation is
    // checkable to the unit.
    for (let i = 0; i < 3; i++) {
      expect(blast.origin2[i]).toBe(Math.trunc(Math.fround(forward[i]) * 4096));
    }

    // tan of the per-axis half-angle, plus the diagonal.
    const tanLimit = (Math.SQRT2 * DEFAULT_SHOTGUN_SPREAD * 16) / (8192 * 16);
    let spread = 0;
    for (const p of blast.pellets) {
      expect(p.entityNum).toBe(ENTITYNUM_WORLD);
      expect([...p.normal]).toEqual([0, 0, 1]);
      expect(p.origin[2]).toBeCloseTo(0, 0);
      const d = [p.origin[0] - muzzle[0], p.origin[1] - muzzle[1], p.origin[2] - muzzle[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      const along = (d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2]) / len;
      const off = Math.sqrt(Math.max(0, 1 - along * along)) / along;
      expect(off).toBeLessThanOrEqual(tanLimit * 1.01);
      spread = Math.max(spread, off);
    }
    // And it IS a scatter: eleven pellets do not all sit on the aim line.
    expect(spread).toBeGreaterThan(0.005);
  });

  it('fires the same pellets from the same input, in two games', () => {
    const collect = (g: Game): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 500; i++) {
        for (const b of g.step({ attack: true, pitch: PITCH }).shotgun) {
          out.push(b.seed);
          for (const p of b.pellets) {
            out.push(p.origin[0], p.origin[1], p.origin[2]);
          }
        }
      }
      return out;
    };
    const a = collect(gunner());
    const b = collect(gunner());
    // 500 ticks at 125 apiece is exactly four blasts, all eleven pellets
    // landing each time: enough that the seed sequence is being exercised,
    // not just its first byte.
    expect(a.length).toBe(4 * (1 + 3 * DEFAULT_SHOTGUN_COUNT));
    expect(a).toEqual(b);
  });

  it('draws exactly one number from the bullet generator per blast: the seed byte', () => {
    // `rand() & 255` is one draw. The twenty-two per-pellet draws come from
    // `Q_crandom`'s own LCG, not from here -- a port that scattered the
    // pellets with `bulletRandom` would advance it 22 extra times and shift
    // every machine gun bullet fired afterwards.
    //
    // Reach into the generator so the count is checked, not just guessed
    // from a burst matching another burst.
    const draw = (g: Game): number =>
      (g as unknown as { bulletRandom: () => number }).bulletRandom();
    const burst = (g: Game): number[] => {
      g.giveWeapon(Weapon.MACHINEGUN);
      g.selectWeapon(Weapon.MACHINEGUN);
      for (let i = 0; i < 200; i++) {
        g.step({});
      }
      const out: number[] = [];
      for (let i = 0; i < 60; i++) {
        for (const hit of g.step({ attack: true, pitch: 5 }).impacts) {
          out.push(hit.origin[0], hit.origin[1], hit.origin[2]);
        }
      }
      return out;
    };

    // The seed byte is the draw itself, scaled: what a fresh generator would
    // hand out first.
    const fresh = gunner();
    const first = draw(fresh);
    const shooter = gunner();
    const { blast } = oneBlast(shooter, { pitch: PITCH });
    expect(blast.seed).toBe(Math.floor(first * 256));

    // One blast == one draw: the machine gun bursts agree.
    const one = gunner();
    draw(one);
    expect(burst(shooter)).toEqual(burst(one));

    // ...and not two.
    const two = gunner();
    draw(two);
    draw(two);
    const twoShooter = gunner();
    oneBlast(twoShooter, { pitch: PITCH });
    expect(burst(twoShooter)).not.toEqual(burst(two));
  });
});

describe('the pellets', () => {
  it('reach a wall at 4000, unsnapped: 3999.875, not the rail’s 3999', () => {
    // Aimed 6 degrees UP: level, the pellets with a downward offset drop
    // their 26 units onto the floor long before 4000. Every pellet rises
    // here, and the wall is 4096 tall.
    const game = gunner(wallWorld(4000));
    const { blast } = oneBlast(game, { pitch: -6 });
    expect(blast.pellets).toHaveLength(DEFAULT_SHOTGUN_COUNT);
    for (const p of blast.pellets) {
      expect([...p.normal]).toEqual([-1, 0, 0]);
      // The trace stops SURFACE_CLIP_EPSILON (0.125) short of the face and
      // nothing rounds it: `ShotgunPellet` has no `SnapVectorTowards`.
      expect(p.origin[0]).toBeCloseTo(3999.875, 1);
      expect(p.origin[0]).not.toBe(3999);
    }
  });

  it('leave nothing on a SURF_NOIMPACT surface', () => {
    const game = gunner(wallWorld(4000, SURF_NOIMPACT));
    const { blast } = oneBlast(game, { pitch: -6 });
    expect(blast.pellets).toEqual([]);
  });

  it('leave nothing on a clean miss', () => {
    // Aimed 30 degrees UP over a flat world: every pellet flies the full
    // 131072 and hits nothing. (Level is not a miss here -- the muzzle is
    // 26 units off the floor and a pellet with any downward offset finds it
    // inside 8192.) Quake would mark the far end, invisibly; see
    // `shotgunPellet`.
    const game = gunner();
    const { blast } = oneBlast(game, { pitch: -30 });
    expect(blast.pellets).toEqual([]);
  });
});

/**
 * A door with no targetname is an auto-trigger door, and
 * `Think_SpawnNewDoorTrigger` gives every one of those `takedamage`. Hit by a
 * pellet, `G_Damage`'s `ET_MOVER` branch USES it. The rail test's fixture,
 * widened: a 12-unit door would catch only some of a pattern 22 units wide
 * at this range, and the test wants every pellet accounted for.
 */
function doorWorld(doorFlags = 0): { model: CollisionModel; entities: MapEntity[] } {
  const model = brushListModel([
    axialBrush([-2048, -2048, -64], [2048, 2048, 0], CONTENTS_SOLID),
  ]);
  const leafbrushes: number[] = Array.from(model.leafbrushes);
  const submodels: CollisionModel['submodels'] = [
    { mins: [-2048, -2048, -64], maxs: [2048, 2048, 0], leaf: model.leafs[0] },
  ];
  model.brushes.push(axialBrush([268, -128, 0], [332, 128, 160], CONTENTS_SOLID, doorFlags));
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
  submodels.push({ mins: [268, -128, 0], maxs: [332, 128, 160], leaf });
  model.leafbrushes = Int32Array.from(leafbrushes);
  model.submodels = submodels;

  const entities: MapEntity[] = [
    {
      classname: 'func_door',
      targetname: null,
      target: null,
      origin: [0, 0, 0],
      angles: [0, 0, 0],
      submodel: 1,
      spawnflags: 0,
      raw: {},
    },
  ];
  return { model, entities };
}

describe('what they hit', () => {
  it('use a shootable door, every pellet that lands on it', () => {
    const { model, entities } = doorWorld();
    const game = new Game({ world: model, origin: [0, 0, 30], entities, weapon: Weapon.SHOTGUN });
    for (let i = 0; i < 100; i++) {
      game.step({});
    }
    const door = game.movers?.movers[0];
    expect(door?.moverState).toBe(MoverState.POS1);

    const { blast } = oneBlast(game, { pitch: 0, yaw: 0 });
    expect(blast.pellets).toHaveLength(DEFAULT_SHOTGUN_COUNT);
    for (const p of blast.pellets) {
      expect(p.entityNum).toBe(door?.entityNum);
      expect(p.origin[0]).toBeCloseTo(267.875, 1);
    }
    expect(door?.moverState).toBe(MoverState.ONETOTWO);
  });

  it('do NOT use a door faced with SURF_NOIMPACT: the flag test precedes damage', () => {
    // `ShotgunPellet` returns on `SURF_NOIMPACT` before it looks at
    // `takedamage` (g_weapon.c:279-281) -- `Bullet_Fire`'s order, and the
    // opposite of `weapon_railgun_fire`'s, which is why `railgun.test.ts`
    // asserts the reverse of this.
    const { model, entities } = doorWorld(SURF_NOIMPACT);
    const game = new Game({ world: model, origin: [0, 0, 30], entities, weapon: Weapon.SHOTGUN });
    for (let i = 0; i < 100; i++) {
      game.step({});
    }
    const door = game.movers?.movers[0];
    const { blast } = oneBlast(game, { pitch: 0, yaw: 0 });
    expect(blast.pellets).toEqual([]);
    expect(door?.moverState).toBe(MoverState.POS1);
  });
});
