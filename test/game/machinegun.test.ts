/**
 * The machine gun: hitscan, spread, and the determinism a ghost depends on.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The interesting assertions here are not "does it shoot". They are:
 *
 *  - the spread is a FIXED CONE, because `Bullet_Fire` displaces the far end
 *    of a 131072-unit ray rather than jittering the angle at the muzzle. The
 *    half-angle works out to `atan(200 * 16 / 131072)` = 1.398 degrees, and a
 *    port that got this wrong by treating `spread` as an angle would miss by
 *    two orders of magnitude and still look plausible on screen.
 *  - the same input fires the same bullets. Everything else this project
 *    simulates is a pure function of the usercmd stream, and a bullet can open
 *    a shootable button, so a ghost that re-ran with a different spread could
 *    miss a door its own run went through.
 */

import { describe, it, expect } from 'vitest';
import { Game } from '../../src/game/game.js';
import { Weapon, FIRE_TIME, WEAPON_START_AMMO, WEAPON_TAG } from '../../src/game/weapons.js';
import {
  MACHINEGUN_SPREAD,
  MACHINEGUN_DAMAGE,
  snapVectorTowards,
} from '../../src/game/bullets.js';
import { calcMuzzlePoint } from '../../src/game/weapons.js';
import { vec3 } from '../../src/math/vec3.js';
import { angleVectors } from '../../src/math/angles.js';
import { flatWorld, originOnFloor } from '../physics/world.js';

/**
 * Fired at a shallow 5 degrees down, so every round reaches the floor ~300
 * units out. Far enough that the cone is several units wide and the integer
 * snap is not the whole signal; near enough that a flat world is all the
 * geometry the test needs.
 */
const PITCH = 5;

function gunner(): Game {
  const game = new Game({
    world: flatWorld(),
    origin: originOnFloor(0),
    weapon: Weapon.MACHINEGUN,
  });
  // Settle onto the floor before anything is fired.
  for (let i = 0; i < 200; i++) {
    game.step({});
  }
  return game;
}

/** Fire `n` rounds, holding the trigger, and collect every impact. */
function burst(game: Game, n: number): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  // 100ms between shots at an 8ms tick is 12-13 ticks, so 20 iterations per
  // round is comfortable without assuming the exact cadence.
  for (let i = 0; i < n * 20; i++) {
    const f = game.step({ attack: true, pitch: PITCH });
    for (const hit of f.impacts) {
      out.push({ x: hit.origin[0], y: hit.origin[1], z: hit.origin[2] });
    }
    if (out.length >= n) {
      break;
    }
  }
  return out;
}

/** Exactly where the shots left from, and where they were aimed. */
function aim(game: Game): { muzzle: number[]; forward: number[] } {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  angleVectors(game.ps.viewangles, forward, right, up);
  const muzzle = vec3();
  calcMuzzlePoint(game.ps, forward, muzzle);
  return { muzzle: [...muzzle], forward: [...forward] };
}

describe('the constants', () => {
  it('are id’s', () => {
    // g_weapon.c:155-156.
    expect(MACHINEGUN_SPREAD).toBe(200);
    expect(MACHINEGUN_DAMAGE).toBe(7);
    // bg_pmove.c, PM_Weapon: `case WP_MACHINEGUN: addTime = 100`.
    expect(FIRE_TIME[Weapon.MACHINEGUN]).toBe(100);
    // g_client.c:1183.
    expect(WEAPON_START_AMMO[Weapon.MACHINEGUN]).toBe(100);
  });
});

/**
 * These three are worked out from the C, not from what the port returns:
 *
 *     if ( to[i] <= v[i] ) v[i] = (int)v[i];
 *     else                 v[i] = (int)v[i] + 1;
 *
 * and C's `(int)` cast truncates TOWARDS ZERO, which `Math.trunc` matches and
 * `Math.floor` does not. The distinction only shows on negative coordinates,
 * which is most of a Quake map.
 */
describe('SnapVectorTowards', () => {
  it('truncates towards zero where the shooter is behind the impact', () => {
    const v = vec3(10.7, -3.2, 40.9);
    snapVectorTowards(v, vec3(0, -20, 0));
    // y: to(-20) <= v(-3.2), so (int)(-3.2) = -3. NOT -4: flooring here would
    // push the decal a unit further from the shooter, into the wall.
    expect([v[0], v[1], v[2]]).toEqual([10, -3, 40]);
  });

  it('adds one where the shooter is beyond the impact', () => {
    const v = vec3(10.7, -3.2, 40.9);
    snapVectorTowards(v, vec3(100, 100, 100));
    expect([v[0], v[1], v[2]]).toEqual([11, -2, 41]);
  });

  it('moves an EXACT integer too, which is a real quirk of the C', () => {
    // There is no equality case: `to[i] <= v[i]` decides it, so an impact
    // already sitting on -8 becomes -7 when the shooter is above it. id does
    // this, the offset is always towards the shooter, and it is never more
    // than a unit -- so it is left alone rather than "fixed".
    const v = vec3(12, -8, 40);
    snapVectorTowards(v, vec3(0, 0, 0));
    expect([v[0], v[1], v[2]]).toEqual([12, -7, 40]);
  });
});

describe('firing', () => {
  it('lands a bullet somewhere', () => {
    const hits = burst(gunner(), 1);
    expect(hits.length).toBe(1);
  });

  it('fires no faster than every 100ms', () => {
    const game = gunner();
    const shotTicks: number[] = [];
    for (let i = 0; i < 130; i++) {
      const f = game.step({ attack: true });
      if (f.fired) {
        shotTicks.push(i);
      }
    }
    expect(shotTicks.length).toBeGreaterThan(2);
    for (let i = 1; i < shotTicks.length; i++) {
      // 100ms at an 8ms tick cannot land on a tick boundary, so the cadence
      // alternates 12 and 13 ticks -- which is exactly what `weaponTime += `
      // rather than `=` is for. Never faster than 12.
      expect((shotTicks[i] - shotTicks[i - 1]) * 8).toBeGreaterThanOrEqual(96);
    }
  });

  it('spends ammo', () => {
    const game = gunner();
    const tag = WEAPON_TAG[Weapon.MACHINEGUN];
    const before = game.ps.ammo[tag];
    burst(game, 3);
    expect(game.ps.ammo[tag]).toBe(before - 3);
  });
});

describe('spread', () => {
  it('stays inside id’s 1.4-degree cone', () => {
    // The cone's half-angle is atan(spread * 16 / (8192 * 16)) -- 1.398
    // degrees. Measured from the real muzzle against the real aim direction,
    // so nothing here is approximated. A port that read `spread` as an angle
    // in degrees would miss this by two orders of magnitude.
    const game = gunner();
    const hits = burst(game, 24);
    expect(hits.length).toBe(24);
    const { muzzle, forward } = aim(game);
    const halfAngle = Math.atan((MACHINEGUN_SPREAD * 16) / (8192 * 16));

    for (const hit of hits) {
      const d = [hit.x - muzzle[0], hit.y - muzzle[1], hit.z - muzzle[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      const dot = (d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2]) / len;
      const off = Math.acos(Math.min(1, Math.max(-1, dot)));
      // Slack for the integer snap, which moves a 300-unit-away impact by up
      // to a unit and therefore by up to 0.2 degrees.
      expect(off).toBeLessThan(halfAngle + (1.5 / len));
    }
  });

  it('actually scatters -- it is not a laser', () => {
    const hits = burst(gunner(), 16);
    const spreadY = Math.max(...hits.map((h) => h.y)) - Math.min(...hits.map((h) => h.y));
    const spreadZ = Math.max(...hits.map((h) => h.z)) - Math.min(...hits.map((h) => h.z));
    expect(spreadY + spreadZ).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('fires identical bullets from identical input', () => {
    // The property a ghost replay depends on: same usercmd stream, same
    // impacts, down to the snapped integer.
    expect(burst(gunner(), 12)).toEqual(burst(gunner(), 12));
  });

  it('reseeds per attempt, so a restart repeats the first run', () => {
    const a = burst(gunner(), 6);

    const game = gunner();
    burst(game, 6);
    // Kill the player: `Game.step` respawns synchronously and resets the
    // course, which is where the generator is reseeded.
    game.ps.health = 0;
    game.step({});
    for (let i = 0; i < 200; i++) {
      game.step({});
    }
    // A respawn takes the weapon away with everything else the life owned
    // (`this.weapon = Weapon.NONE` in the reset block), so the second attempt
    // has to be re-armed before it can shoot at all.
    game.giveWeapon(Weapon.MACHINEGUN);
    game.weapon = Weapon.MACHINEGUN;
    expect(burst(game, 6)).toEqual(a);
  });
});
