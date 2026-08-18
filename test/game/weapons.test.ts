/**
 * Weapons as movement tools: rocket jumps, grenade jumps, plasma climbing.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The headline test derives the expected rocket-jump impulse BY HAND from the
 * verified chain, rather than recording whatever the code produces. Working it
 * through for a player standing on a flat floor firing straight down:
 *
 *   muzzle    = origin + (0,0,viewheight 26) + 14 * (0,0,-1), snapped
 *   trDelta   = (0,0,-900), snapped
 *   trTime    = fireTime - MISSILE_PRESTEP_TIME(50)
 *   first run = 50ms of flight, so the rocket travels 45 units down and hits
 *               the floor, stopping SURFACE_CLIP_EPSILON above it
 *   distance  = 0, because splash measures from the EDGE of the player's
 *               bounding box and the impact is directly beneath them
 *   points    = 100 * (1 - 0/120) = 100
 *   dir       = (player - impact) with dir[2] += 24, normalised to (0,0,1)
 *   knockback = min(100, 200) = 100
 *   impulse   = g_knockback(1000) * 100 / mass(200) = 500
 *
 * So a point-blank floor rocket must add an impulse of exactly 500.
 *
 * It is NOT purely vertical, and the reason is worth knowing: PM_UpdateViewAngles
 * clamps pitch to +/-16000 in short units, which is 87.89 degrees, so Quake 3
 * never lets you look perfectly straight down. The rocket therefore leaves the
 * muzzle 2.1 degrees off vertical, lands ~2.3 units in front of the player, and
 * the resulting knockback direction tilts by the same amount. The magnitude is
 * exactly 500; the vertical component is 499.42.
 *
 * That clamp was found BY this test disagreeing with the hand-derived number,
 * which is precisely what it is for.
 */

import { describe, it, expect } from 'vitest';
import { Game } from '../../src/game/game.js';
import { Weapon } from '../../src/game/weapons.js';
import { TRAJECTORY_GRAVITY } from '../../src/game/trajectory.js';
import {
  JUMP_VELOCITY,
  PMF_TIME_KNOCKBACK,
} from '../../src/physics/constants.js';
import { flatWorld, originOnFloor } from '../physics/world.js';

/** Settle a Game onto the ground. */
function settleGame(game: Game, maxTicks = 400): boolean {
  let prevZ = game.ps.origin[2];
  for (let i = 0; i < maxTicks; i++) {
    game.step({});
    const z = game.ps.origin[2];
    if (game.onGround && Math.abs(z - prevZ) < 1e-4 && i > 0) {
      return true;
    }
    prevZ = z;
  }
  return false;
}

function standingRocketeer(): Game {
  const game = new Game({
    world: flatWorld(),
    origin: originOnFloor(0),
    weapon: Weapon.ROCKET_LAUNCHER,
  });
  settleGame(game);
  return game;
}

describe('rocket jump', () => {
  it('adds an impulse of exactly 500 at point blank', () => {
    const game = standingRocketeer();

    const before = [
      game.ps.velocity[0],
      game.ps.velocity[1],
      game.ps.velocity[2],
    ];
    // Asking for pitch 90 gets clamped to 87.89 — Q3 will not look straight down.
    game.step({ pitch: 90, attack: true });

    const dx = game.ps.velocity[0] - before[0];
    const dy = game.ps.velocity[1] - before[1];
    const dz = game.ps.velocity[2] - before[2];

    // g_knockback(1000) * min(damage 100, 200) / mass(200) = 500, exactly.
    expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeCloseTo(500, 4);
  });

  it('tilts the impulse because pitch cannot reach straight down', () => {
    const game = standingRocketeer();
    const before = game.ps.velocity[2];
    game.step({ pitch: 90, attack: true });

    // 16000 short units is 87.890625 degrees.
    expect(game.ps.viewangles[0]).toBeCloseTo(87.890625, 4);

    // Almost all of the 500 goes upward, but not quite all of it.
    expect(game.ps.velocity[2] - before).toBeCloseTo(499.42, 1);
    expect(game.ps.velocity[2] - before).toBeLessThan(500);
  });

  it('opens the knockback window so the impulse is not scrubbed off', () => {
    const game = standingRocketeer();
    game.step({ pitch: 90, attack: true });

    // t = clamp(knockback * 2, 50, 200) = clamp(200, 50, 200) = 200
    expect(game.ps.pm_time).toBe(200);
    expect(game.ps.pm_flags & PMF_TIME_KNOCKBACK).toBeTruthy();
  });

  it('costs half damage, because self-damage is halved after knockback', () => {
    const game = standingRocketeer();
    expect(game.ps.health).toBe(100);

    game.step({ pitch: 90, attack: true });

    // 100 splash at distance 0, halved for hurting yourself.
    expect(game.ps.health).toBe(50);
  });

  it('launches the player higher than a jump can', () => {
    const rocket = standingRocketeer();
    const groundZ = rocket.ps.origin[2];

    rocket.step({ pitch: 90, attack: true });
    let rocketApex = rocket.ps.origin[2];
    for (let i = 0; i < 400; i++) {
      rocket.step({ pitch: 90 });
      rocketApex = Math.max(rocketApex, rocket.ps.origin[2]);
      if (rocket.onGround && i > 10) {
        break;
      }
    }

    const rocketRise = rocketApex - groundZ;

    // A plain jump reaches ~48.5 units at 125Hz. 500ups of impulse must do
    // dramatically better, or the rocket jump is not worth its health cost.
    expect(rocketRise).toBeGreaterThan(140);
  });

  it('does not fire again until the 800ms cooldown expires', () => {
    const game = standingRocketeer();

    let shots = 0;
    // 800ms is 100 ticks at 8ms, so 250 ticks allows exactly three shots.
    for (let i = 0; i < 250; i++) {
      if (game.step({ pitch: 90, attack: true }).fired) {
        shots++;
      }
    }

    expect(shots).toBe(3);
  });

  it('never collides with the player who fired it', () => {
    // G_RunMissile passes the owner as the entity to ignore. Without that a
    // rocket fired downward would detonate against its own shooter's hull
    // instead of the floor, and rocket jumping would be impossible.
    const game = standingRocketeer();
    const before = game.ps.velocity[2];
    game.step({ pitch: 90, attack: true });

    // Reaching the floor at full strength is the observable proof: a rocket
    // stopped by the player's own hull would detonate 20-odd units higher and
    // deliver measurably less.
    expect(game.ps.velocity[2] - before).toBeGreaterThan(495);
  });
});

describe('grenade', () => {
  it('detonates on its 2500ms fuse when it never hits a wall', () => {
    const game = new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      weapon: Weapon.GRENADE_LAUNCHER,
    });
    settleGame(game);

    // Fire straight up so it arcs and lands, rather than hitting anything.
    game.step({ pitch: -89, attack: true });
    expect(game.missiles.length).toBe(1);

    const fuse = game.missiles[0].nextthink - game.time;
    expect(fuse).toBe(2500);
  });

  it('bounces instead of exploding on contact', () => {
    const game = new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      weapon: Weapon.GRENADE_LAUNCHER,
    });
    settleGame(game);

    game.step({ pitch: 45, attack: true });

    // Run well past the point where a rocket would have detonated, but short
    // of the fuse. A grenade must still be alive, having bounced.
    let stillAlive = false;
    for (let i = 0; i < 120; i++) {
      game.step({});
      if (game.missiles.length === 1) {
        stillAlive = true;
      }
    }
    expect(stillAlive).toBe(true);
  });

  it('launches the player when it finally goes off', () => {
    const game = new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      weapon: Weapon.GRENADE_LAUNCHER,
    });
    settleGame(game);

    const startZ = game.ps.origin[2];
    // Drop it at our feet and stand on it.
    game.step({ pitch: 90, attack: true });

    let apex = startZ;
    for (let i = 0; i < 500; i++) {
      game.step({});
      apex = Math.max(apex, game.ps.origin[2]);
    }

    // A plain jump reaches ~48.5 units. The grenade must clearly beat that,
    // though it lands short of a rocket because it bounces away before its
    // fuse runs out.
    expect(apex - startZ).toBeGreaterThan(60);
  });
});

describe('plasma', () => {
  /** Jump, then fall, optionally spamming plasma at the floor on the way down. */
  function jumpAndFall(spam: boolean): {
    ticksAirborne: number;
    impact: number;
    rise: number;
  } {
    const game = new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      weapon: Weapon.PLASMAGUN,
    });
    settleGame(game);

    const floorZ = game.ps.origin[2];
    game.step({ up: 127 });
    let ticks = 0;
    let impact = 0;
    let apex = floorZ;
    for (let i = 0; i < 600; i++) {
      const prevVz = game.ps.velocity[2];
      game.step({ pitch: 90, attack: spam });
      apex = Math.max(apex, game.ps.origin[2]);
      ticks++;
      if (game.onGround && i > 5) {
        impact = prevVz;
        break;
      }
    }
    return { ticksAirborne: ticks, impact, rise: apex - floorZ };
  }

  it('holds the player up while they stay within splash range', () => {
    // Each ball is 15 splash at distance zero: 15 * 5 = 75 of impulse every
    // 100ms, against the 80 that gravity removes in the same time. Plasma does
    // not launch you, it very nearly cancels your weight.
    //
    // But the splash radius is only 20 units, so the moment you are more than
    // 20 above the surface you are shooting, the pushes stop entirely. That is
    // the whole shape of plasma climbing: it is a technique for creeping up
    // something you are hugging, not a jet pack.
    const plain = jumpAndFall(false);
    const spammed = jumpAndFall(true);

    expect(spammed.ticksAirborne).toBeGreaterThan(plain.ticksAirborne * 1.15);
    expect(spammed.rise).toBeGreaterThan(plain.rise + 15);

    // And note it lands HARDER, not softer. The extra height is bought on the
    // way up, inside splash range; once out of range the player is in ordinary
    // free fall from further up. Plasma buys height, not a soft landing.
    expect(Math.abs(spammed.impact)).toBeGreaterThan(Math.abs(plain.impact));
  });

  it('stops helping once the player climbs out of its 20 unit radius', () => {
    const game = new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      weapon: Weapon.PLASMAGUN,
    });
    settleGame(game);
    const floorZ = game.ps.origin[2];

    let apex = floorZ;
    for (let i = 0; i < 600; i++) {
      game.step({ up: 127, pitch: 90, attack: true });
      apex = Math.max(apex, game.ps.origin[2]);
    }

    // Jump apex is ~48.5 and the splash reaches 20, so plasma spam cannot
    // carry the player indefinitely upward however long they hold the trigger.
    expect(apex - floorZ).toBeLessThan(120);
  });

  it('costs health for every ball that lands near the player', () => {
    const game = new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      weapon: Weapon.PLASMAGUN,
    });
    settleGame(game);

    // Measure the drain, not the endpoint. 200 ticks of plasma at your own feet
    // is now fatal, and dying respawns you at 125 -- so asserting on the final
    // health would be reading the health of a *later life*. Stop at the first
    // death instead; the drain up to that point is the thing under test.
    const start = game.ps.health;
    let lowest = start;
    for (let i = 0; i < 200; i++) {
      const frame = game.step({ pitch: 90, attack: true });
      if (frame.respawned) {
        break;
      }
      lowest = Math.min(lowest, game.ps.health);
    }

    expect(lowest).toBeLessThan(start);
  });
});

describe('trajectory', () => {
  it('uses the hardcoded 800 gravity, not the player gravity', () => {
    // id's own "FIXME: local gravity" — a map with altered gravity still
    // throws grenades on 800.
    expect(TRAJECTORY_GRAVITY).toBe(800);
  });

  it('a jump is much weaker than a rocket, which is the whole point', () => {
    expect(JUMP_VELOCITY).toBe(270);
    // 500 impulse vs 270 jump velocity.
    expect(500).toBeGreaterThan(JUMP_VELOCITY);
  });
});
