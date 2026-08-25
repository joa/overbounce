/**
 * Respawning, and the view freeze it fixes.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The first describe block is the regression test for the reported bug: the
 * mouse appearing to die after a few minutes of play. It was not an input bug —
 * PM_UpdateViewAngles refuses to touch viewangles at zero health, exactly as
 * Quake does, and nothing ever brought health back.
 */

import { describe, it, expect } from 'vitest';
import { Game } from '../../src/game/game.js';
import { Simulation } from '../../src/physics/simulate.js';
import { Weapon } from '../../src/game/weapons.js';
import { SPAWN_HEALTH, needsRespawn, respawn } from '../../src/game/respawn.js';
import { createPlayerState } from '../../src/physics/types.js';
import { PMF_RESPAWNED, PMF_TIME_KNOCKBACK, PmType, ENTITYNUM_NONE } from '../../src/physics/constants.js';
import { flatWorld, originOnFloor } from '../physics/world.js';
import { buildEntities } from '../../src/game/entities.js';

const SPAWN = { origin: [64, 0, 24] as [number, number, number], yaw: 90 };

describe('the frozen-view bug', () => {
  it('stops updating view angles at zero health, as Quake does', () => {
    // This is the faithful behaviour, and it must stay. The bug was never this
    // line; it was that nothing restored health.
    const sim = new Simulation({ world: flatWorld(), origin: originOnFloor(0) });
    sim.step({ yaw: 90 });
    expect(sim.ps.viewangles[1]).toBeCloseTo(90, 1);

    sim.ps.health = 0;
    sim.step({ yaw: 0 });
    // The view is stuck where it was; the requested angle is discarded.
    expect(sim.ps.viewangles[1]).toBeCloseTo(90, 1);
  });

  it('is undone by a respawn, which restores the mouse', () => {
    const game = new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      spawn: SPAWN,
    });
    game.step({ yaw: 45 });

    game.ps.health = 0;
    const frame = game.step({ yaw: 45 });
    expect(frame.respawned).toBe('dead');
    expect(game.ps.viewangles[1]).toBeCloseTo(SPAWN.yaw, 1);

    // The view responds to the mouse again. It is deliberately NOT asserted to
    // equal the requested angle: respawn sets delta_angles, and Quake never
    // clears that -- IN_CenterView is the only thing in the client that even
    // reads it. The player's view snapped to the spawn facing and their mouse
    // now moves relative to it, which is exactly what a Q3 teleport feels like.
    const before = game.ps.viewangles[1];
    game.step({ yaw: 200 });
    expect(game.ps.viewangles[1]).not.toBeCloseTo(before, 1);
  });
});

describe('needsRespawn', () => {
  const mins = [-1000, -1000, -1000];
  const maxs = [1000, 1000, 1000];

  it('says nothing for a healthy player inside the world', () => {
    const ps = createPlayerState();
    expect(needsRespawn(ps, mins, maxs)).toBeNull();
  });

  it('reports death at zero health and below', () => {
    const ps = createPlayerState();
    ps.health = 0;
    expect(needsRespawn(ps, mins, maxs)).toBe('dead');
    ps.health = -50;
    expect(needsRespawn(ps, mins, maxs)).toBe('dead');
  });

  it('reports the void well outside the world bounds', () => {
    const ps = createPlayerState();
    ps.origin[2] = -5000;
    expect(needsRespawn(ps, mins, maxs)).toBe('void');
  });

  it('tolerates a player just outside the hull', () => {
    // Standing on the edge of the world can put the origin slightly outside it,
    // and a false respawn mid-run is far worse than falling a moment longer.
    const ps = createPlayerState();
    ps.origin[2] = -1500;
    expect(needsRespawn(ps, mins, maxs)).toBeNull();
  });

  it('prefers death over the void when both are true', () => {
    const ps = createPlayerState();
    ps.health = 0;
    ps.origin[2] = -99999;
    expect(needsRespawn(ps, mins, maxs)).toBe('dead');
  });
});

describe('respawn', () => {
  it('spawns at 125 health, as ClientSpawn does', () => {
    const ps = createPlayerState();
    ps.health = 0;
    respawn(ps, SPAWN);
    // STAT_MAX_HEALTH + 25. Not 100.
    expect(ps.health).toBe(125);
    expect(SPAWN_HEALTH).toBe(125);
  });

  it('puts the player at the spawn point with no velocity', () => {
    const ps = createPlayerState();
    ps.origin[0] = 9999;
    ps.velocity[0] = 1200;
    ps.velocity[2] = -800;

    respawn(ps, SPAWN);
    expect(Array.from(ps.origin)).toEqual([64, 0, 24]);
    expect(Array.from(ps.velocity)).toEqual([0, 0, 0]);
  });

  it('clears movement timers that would outlive the death', () => {
    // A player who died mid-knockback would otherwise respawn unable to steer.
    const ps = createPlayerState();
    ps.pm_flags = PMF_TIME_KNOCKBACK;
    ps.pm_time = 200;
    ps.pm_type = PmType.DEAD;
    ps.groundEntityNum = 5;

    respawn(ps, SPAWN);
    expect(ps.pm_flags & PMF_TIME_KNOCKBACK).toBe(0);
    expect(ps.pm_flags).toBe(PMF_RESPAWNED);
    expect(ps.pm_time).toBe(0);
    expect(ps.pm_type).toBe(PmType.NORMAL);
    expect(ps.groundEntityNum).toBe(ENTITYNUM_NONE);
  });

  it('forgets the last jump pad, so the next one still announces itself', () => {
    const ps = createPlayerState();
    ps.jumppad_ent = 4;
    ps.jumppad_frame = 9;
    respawn(ps, SPAWN);
    expect(ps.jumppad_ent).toBe(0);
    expect(ps.jumppad_frame).toBe(0);
  });

  it('clears delta_angles rather than setting them', () => {
    // The opposite of SetClientViewAngle, on purpose. This input layer sends
    // absolute angles every tick, so a non-zero delta is a PERMANENT offset,
    // not a one-time snap -- and on pitch that means never being able to aim
    // at your own feet again.
    const ps = createPlayerState();
    ps.delta_angles[0] = 1234;
    ps.delta_angles[1] = 5678;

    respawn(ps, SPAWN);
    expect(Array.from(ps.delta_angles)).toEqual([0, 0, 0]);
    expect(ps.viewangles[1]).toBe(90);
  });

  it('leaves pitch fully aimable after respawning while looking down', () => {
    // The reported bug. Respawn mid-look and the old code offset pitch forever.
    const sim = new Simulation({ world: flatWorld(), origin: originOnFloor(0) });
    sim.run(3, { pitch: 45, yaw: 10 });

    respawn(sim.ps, SPAWN);
    sim.step({ pitch: 85, yaw: 10 });
    // Straight down must still mean straight down. PM_UpdateViewAngles clamps
    // at 16000 short units (87.89 degrees), so 85 arrives intact.
    expect(sim.ps.viewangles[0]).toBeCloseTo(85, 0);
  });
});

describe('respawn in the game loop', () => {
  function game(): Game {
    return new Game({
      world: flatWorld(),
      origin: originOnFloor(0),
      weapon: Weapon.ROCKET_LAUNCHER,
      spawn: SPAWN,
    });
  }

  it('reports the respawn on the tick it happens, and only then', () => {
    const g = game();
    expect(g.step({}).respawned).toBeNull();

    g.ps.health = 0;
    expect(g.step({}).respawned).toBe('dead');
    // Health is back, so the next tick is quiet.
    expect(g.step({}).respawned).toBeNull();
  });

  it('discards missiles from the previous life', () => {
    const g = game();
    g.run(4, { attack: true, pitch: -80 });
    expect(g.missiles.length).toBeGreaterThan(0);

    g.ps.health = 0;
    g.step({});
    expect(g.missiles.length).toBe(0);
  });

  it('rescues a player who has fallen out of the world', () => {
    const g = game();
    // Past MIN_WORLD_COORD. A synthetic brush-list world has no submodel hull,
    // so the fallback is Quake's absolute coordinate limit of +/-128k -- which
    // is why this has to be genuinely enormous rather than merely a long fall.
    g.ps.origin[2] = -200000;
    expect(g.step({}).respawned).toBe('void');
    expect(g.ps.origin[2]).toBe(24);
  });

  it('loses the weapon on death, the same as ammo/armour/powerups', () => {
    const g = game();
    g.ps.health = 0;
    g.step({});
    expect(g.weapon).toBe(Weapon.NONE);
  });

  it('resets picked-up items on a void fall too, not just on death', () => {
    // Previously gated on reason === 'dead' only, which let a void respawn
    // keep whatever the player had already picked up -- a different
    // environment than a normal death would leave, and than a fresh run
    // starts with.
    const g = new Game({
      world: flatWorld(),
      origin: [0, 0, 40],
      weapon: Weapon.ROCKET_LAUNCHER,
      entities: buildEntities([{ classname: 'item_health_small', origin: '0 0 40' }]),
      spawn: SPAWN,
    });

    g.step({});
    const item = g.itemWorld!.items[0];
    expect(item.present).toBe(false);

    g.ps.origin[2] = -200000;
    expect(g.step({}).respawned).toBe('void');
    expect(item.present).toBe(true);
  });

  it('survives a rocket-jump health drain without freezing the view', () => {
    // The actual reported scenario: use the launcher for movement until the
    // health runs out, and check the player is still playable afterwards.
    const g = game();
    for (let i = 0; i < 900; i++) {
      g.step({ attack: true, pitch: 89, yaw: 0 });
    }
    expect(g.ps.health).toBeGreaterThan(0);

    // The reported symptom was that the mouse stopped doing anything at all.
    // Two different requested angles must now give two different views.
    g.step({ yaw: 0 });
    const a = g.ps.viewangles[1];
    g.step({ yaw: 123 });
    const b = g.ps.viewangles[1];
    expect(a).not.toBeCloseTo(b, 1);
  });
});
