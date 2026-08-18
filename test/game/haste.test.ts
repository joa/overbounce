/**
 * Haste: the two things it does, and the integers it does them with.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Quake III splits haste across two files, and implementing only one of them
 * gives a powerup that half works and reads as "not properly implemented":
 *
 *   - `g_active.c :: ClientThink_real` scales `ps.speed` by 1.3 before Pmove.
 *   - `bg_pmove.c :: PM_Weapon` divides `addTime` by 1.3 after a shot.
 *
 * Both operands are `int` in the C -- `playerState_t::speed` at q_shared.h:1159
 * and `addTime` at bg_pmove.c:1539 -- so both results TRUNCATE. That is where
 * the golden numbers in this file come from: 320 -> 416, 800 -> 615, 100 -> 76.
 * A naive float implementation gives 416.0000000000001, 615.38 and 76.92, and
 * every one of those silently moves the tick a haste route is timed against.
 */

import { describe, it, expect } from 'vitest';
import { Game } from '../../src/game/game.js';
import { Weapon, FIRE_TIME } from '../../src/game/weapons.js';
import { HASTE_FACTOR, Powerup } from '../../src/game/items.js';
import { DEFAULT_SPEED } from '../../src/physics/constants.js';
import { flatWorld, originOnFloor } from '../physics/world.js';

function game(weapon = Weapon.ROCKET_LAUNCHER): Game {
  return new Game({
    world: flatWorld(),
    origin: originOnFloor(0),
    weapon,
    spawn: { origin: originOnFloor(0), yaw: 0 },
  });
}

describe('the haste constant', () => {
  it('is 1.3, the divisor and multiplier the C uses for both halves', () => {
    expect(HASTE_FACTOR).toBe(1.3);
  });
});

describe('haste: movement speed', () => {
  it('scales ps.speed to 416 while it is running', () => {
    // client->ps.speed = g_speed.value;  ->  320
    // client->ps.speed *= 1.3;           ->  416 (int, truncated)
    const g = game();
    g.ps.powerups[Powerup.HASTE] = 999_999;
    g.step({});
    expect(g.ps.speed).toBe(416);
    expect(Number.isInteger(g.ps.speed)).toBe(true);
  });

  it('leaves ps.speed at g_speed without it', () => {
    const g = game();
    g.step({});
    expect(g.ps.speed).toBe(DEFAULT_SPEED);
  });

  it('puts ps.speed back the tick haste expires, with no cleanup step', () => {
    // ClientThink_real rebuilds ps.speed from the cvar EVERY frame and only
    // then scales it, so expiry needs no code of its own. If this regresses,
    // the symptom is a player who keeps running at 416 forever -- which is
    // exactly what a "haste that never wears off" bug looks like.
    const g = game();
    // 8ms per tick, so an expiry at 12ms covers the first step and not the
    // second.
    g.ps.powerups[Powerup.HASTE] = 12;
    g.step({});
    expect(g.ps.speed).toBe(416);
    g.step({});
    expect(g.ps.speed).toBe(DEFAULT_SPEED);
  });

  it('actually makes the player run faster on the ground', () => {
    // The end-to-end check: ps.speed is PM_Accelerate's wishspeed cap, so a
    // higher cap has to show up as a higher ground speed. Long enough to reach
    // the cap, straight ahead, no strafing -- so this measures the cap and not
    // the strafe-jump bug.
    const plain = game();
    plain.run(150, { forward: 127 });

    const hasted = game();
    hasted.ps.powerups[Powerup.HASTE] = 999_999;
    hasted.run(150, { forward: 127 });

    expect(plain.speed).toBeCloseTo(DEFAULT_SPEED, 0);
    expect(hasted.speed).toBeCloseTo(416, 0);
  });
});

describe('haste: weapon fire rate', () => {
  /** weaponTime immediately after the tick a shot goes out. */
  function fireOnce(g: Game): number {
    const frame = g.step({ attack: true, pitch: -89 });
    expect(frame.fired).toBe(true);
    return g.weaponTime;
  }

  it('leaves the rocket launcher at 800ms without haste', () => {
    expect(FIRE_TIME[Weapon.ROCKET_LAUNCHER]).toBe(800);
    expect(fireOnce(game())).toBe(800);
  });

  it('divides the rocket launcher to 615ms, not 615.38', () => {
    // `int addTime; ... addTime /= 1.3;` -- 800 / 1.3 is 615.3846, and C
    // truncates it on the way back into the int.
    const g = game();
    g.ps.powerups[Powerup.HASTE] = 999_999;
    expect(fireOnce(g)).toBe(615);
  });

  it('divides the plasma gun to 76ms, not 76.92', () => {
    const g = game(Weapon.PLASMAGUN);
    g.ps.powerups[Powerup.HASTE] = 999_999;
    expect(FIRE_TIME[Weapon.PLASMAGUN]).toBe(100);
    expect(fireOnce(g)).toBe(76);
  });

  it('fires more often over a fixed window', () => {
    // 5 seconds of held fire. Plasma has 50 rounds, which at 100ms is exactly
    // the window -- so ammo is topped up to keep this a rate measurement.
    const shots = (haste: boolean): number => {
      const g = game(Weapon.PLASMAGUN);
      if (haste) {
        g.ps.powerups[Powerup.HASTE] = 999_999;
      }
      let n = 0;
      for (let i = 0; i < 625; i++) {
        g.giveWeapon(Weapon.PLASMAGUN, 200);
        if (g.step({ attack: true, pitch: -89 }).fired) {
          n++;
        }
      }
      return n;
    };

    // The first shot goes out on tick 1, leaving 624 ticks (4992ms) of
    // cooldowns: 1 + floor(4992 / 100) = 50 plain, 1 + floor(4992 / 76) = 66
    // hasted. A third more shots for the same trigger hold, which is what
    // haste is supposed to feel like.
    expect(shots(false)).toBe(50);
    expect(shots(true)).toBe(66);
  });

  it('pays the sub-tick remainder back on the next shot', () => {
    // `pm->ps->weaponTime += addTime`, not `=`. 615 is not a whole number of
    // 8ms ticks, so weaponTime lands on -1 rather than 0 before the second
    // shot and the second cooldown is 614. Writing `=` would round every shot
    // up to a tick boundary and make a hasted weapon slower than the C's.
    const g = game();
    g.ps.powerups[Powerup.HASTE] = 999_999;
    expect(fireOnce(g)).toBe(615);

    // 615 / 8 = 76.875, so the 77th tick after the shot is the one that fires.
    let second = 0;
    for (let i = 0; i < 200; i++) {
      if (g.step({ attack: true, pitch: -89 }).fired) {
        second = g.weaponTime;
        break;
      }
    }
    expect(second).toBe(614);
  });

  it('drops the remainder when the trigger is released', () => {
    // PM_Weapon: `if (!(pm->cmd.buttons & BUTTON_ATTACK)) { weaponTime = 0; }`
    // Without it the `+=` above would accumulate a negative residual for the
    // rest of the life, and cooldowns would drift shorter and shorter.
    const g = game(Weapon.PLASMAGUN);
    g.step({ attack: true, pitch: -89 });
    expect(g.weaponTime).toBe(100);

    // 100ms is 12.5 ticks, so the tick that takes weaponTime to zero
    // overshoots to -4. With the trigger released that residual is dropped...
    g.run(13, {});
    expect(g.weaponTime).toBe(0);

    // ...so the next shot's cooldown is a clean 100 and not 96.
    expect(g.step({ attack: true, pitch: -89 }).fired).toBe(true);
    expect(g.weaponTime).toBe(100);
  });
});
