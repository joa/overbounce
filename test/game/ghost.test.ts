/**
 * Ghost recording and playback.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The load-bearing test here is `reproduces the run bit-exactly`. A ghost is a
 * usercmd stream rather than a path, so replaying it is only a ghost if the
 * simulation is deterministic — which makes this test do double duty as the
 * determinism check the plan's risk list asks for.
 */

import { describe, it, expect } from 'vitest';
import { Game } from '../../src/game/game.js';
import type { GameInput } from '../../src/game/game.js';
import { GhostRecorder, GhostPlayer, GhostStore, parseGhost, applyPlayerSnapshot } from '../../src/game/ghost.js';
import type { GhostRun, PlayerSnapshot } from '../../src/game/ghost.js';
import { Weapon } from '../../src/game/weapons.js';
import { WeaponTag, addAmmo } from '../../src/game/items.js';
import { flatWorld, platformWorld, originOnFloor } from '../physics/world.js';
import type { RecordStore } from '../../src/game/records.js';
import { createPlayerState } from '../../src/physics/types.js';
import type { PlayerState } from '../../src/physics/types.js';
import { ENTITYNUM_NONE } from '../../src/physics/constants.js';

function memoryStore(): RecordStore {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

/** A fixture start snapshot -- see `PlayerSnapshot`/`legacySnapshot` in ghost.ts. */
function snapshot(origin: [number, number, number] = [0, 0, 0]): PlayerSnapshot {
  return {
    origin,
    velocity: [0, 0, 0],
    viewangles: [0, 0, 0],
    deltaAngles: [0, 0, 0],
    pmFlags: 0,
    pmTime: 0,
    pmType: 0,
    groundEntityNum: ENTITYNUM_NONE,
    gravity: 800,
    speed: 320,
    jumppadFrame: 0,
    doubleJumpTime: 0,
    jumppadEnt: 0,
    health: 125,
    armor: 0,
    ammo: [],
    powerups: [],
  };
}

/** A fresh `PlayerState` at the given origin, for exercising `GhostRecorder.start`. */
function psAt(origin: [number, number, number]): PlayerState {
  const ps = createPlayerState();
  ps.origin[0] = origin[0];
  ps.origin[1] = origin[1];
  ps.origin[2] = origin[2];
  return ps;
}

function ghostRun(overrides: Partial<GhostRun> = {}): GhostRun {
  return {
    version: 1,
    map: 'q3dm6',
    physics: 'vq3',
    camera: 'chase',
    time: 1000,
    msec: 8,
    start: snapshot(),
    ticks: [{ forward: 127, right: 0, up: 0, yaw: 0, pitch: 0, attack: false, weapon: Weapon.NONE }],
    splits: [500],
    date: '2026-01-01',
    ...overrides,
  };
}

/** A varied run: strafe jumping, a turn, a rocket, and a landing. */
function scriptedInput(tick: number): GameInput {
  return {
    forward: 127,
    right: tick % 40 < 20 ? 127 : -127,
    up: tick % 20 === 0 ? 127 : 0,
    yaw: (tick % 40 < 20 ? 12 : -12) + tick * 0.35,
    pitch: -20,
    attack: tick === 60,
  };
}

function record(ticks: number): { run: NonNullable<ReturnType<GhostRecorder['finish']>>; final: number[] } {
  const game = new Game({
    world: platformWorld(96),
    origin: originOnFloor(0),
    weapon: Weapon.ROCKET_LAUNCHER,
  });
  const recorder = new GhostRecorder('test', 8);
  recorder.start(game.ps);

  for (let i = 0; i < ticks; i++) {
    const input = scriptedInput(i);
    recorder.record(input, game.weapon);
    game.step(input);
  }

  const run = recorder.finish(ticks * 8)!;
  return {
    run,
    final: [game.ps.origin[0], game.ps.origin[1], game.ps.origin[2]],
  };
}

describe('GhostRecorder', () => {
  it('records nothing until started', () => {
    const r = new GhostRecorder('test', 8);
    r.record({ forward: 127 }, Weapon.NONE);
    expect(r.length).toBe(0);
    expect(r.active).toBe(false);
    expect(r.finish(0)).toBeNull();
  });

  it('records one tick per call once started', () => {
    const r = new GhostRecorder('test', 8);
    r.start(psAt([0, 0, 0]));
    for (let i = 0; i < 5; i++) {
      r.record({ forward: 127 }, Weapon.NONE);
    }
    expect(r.length).toBe(5);
  });

  it('discards the previous buffer when restarted', () => {
    const r = new GhostRecorder('test', 8);
    r.start(psAt([0, 0, 0]));
    r.record({ forward: 127 }, Weapon.NONE);
    r.start(psAt([0, 0, 0]));
    expect(r.length).toBe(0);
  });

  it('captures the full player state the run started from, not just origin', () => {
    const r = new GhostRecorder('test', 8);
    const ps = psAt([100, 200, 300]);
    ps.velocity[0] = 350;
    ps.velocity[2] = 180;
    ps.groundEntityNum = ENTITYNUM_NONE;
    r.start(ps);
    r.record({}, Weapon.NONE);
    const start = r.finish(8)!.start;
    expect(start.origin).toEqual([100, 200, 300]);
    // Mid-air with real velocity -- exactly the strafe-jump-start-gate case
    // `applyPlayerSnapshot` exists for. See ghost.ts's file header.
    expect(start.velocity).toEqual([350, 0, 180]);
    expect(start.groundEntityNum).toBe(ENTITYNUM_NONE);
  });

  it('fills in defaults for keys the input omitted', () => {
    const r = new GhostRecorder('test', 8);
    r.start(psAt([0, 0, 0]));
    r.record({ forward: 127 }, Weapon.ROCKET_LAUNCHER);
    expect(r.finish(8)!.ticks[0]).toEqual({
      forward: 127,
      right: 0,
      up: 0,
      yaw: 0,
      pitch: 0,
      attack: false,
      weapon: Weapon.ROCKET_LAUNCHER,
    });
  });
});

describe('GhostPlayer', () => {
  it('reproduces the run bit-exactly', () => {
    const { run, final } = record(200);

    const replay = new Game({
      world: platformWorld(96),
      origin: originOnFloor(0),
      weapon: Weapon.ROCKET_LAUNCHER,
    });
    const player = new GhostPlayer(run);

    let tick: { input: GameInput; weapon: Weapon } | null;
    while ((tick = player.next()) !== null) {
      replay.selectWeapon(tick.weapon);
      replay.step(tick.input);
    }

    // Not "close to" — the same integer-millisecond inputs through the same
    // pmove must land on the same float32 bits. Anything less means the
    // simulation has a hidden source of state and the ghost is a lie.
    expect(replay.ps.origin[0]).toBe(final[0]);
    expect(replay.ps.origin[1]).toBe(final[1]);
    expect(replay.ps.origin[2]).toBe(final[2]);
  });

  it('reproduces a run that starts the gate already moving, mid-air -- the strafe-jump case', () => {
    // A start gate is routinely crossed mid-strafe-jump, not from a dead
    // stop. Recording only `origin` (the old shape) meant `ghostGame` always
    // began grounded with zero velocity regardless of what the original run
    // was actually doing at that instant -- pmove branches entirely
    // differently airborne vs grounded, and every tick's acceleration is
    // relative to whatever velocity already exists, so replaying the exact
    // same inputs from the wrong starting state reliably steers off course
    // within a few ticks. This is the reported symptom on a straight
    // strafe-jump corridor: the ghost runs into a wall almost immediately.
    const game = new Game({
      world: platformWorld(96),
      origin: originOnFloor(0),
      weapon: Weapon.ROCKET_LAUNCHER,
    });
    // Simulate crossing the start line already airborne and moving fast.
    game.ps.velocity[0] = 380;
    game.ps.velocity[1] = 120;
    game.ps.velocity[2] = 220;
    game.ps.groundEntityNum = ENTITYNUM_NONE;

    const recorder = new GhostRecorder('test', 8);
    recorder.start(game.ps);
    for (let i = 0; i < 100; i++) {
      const input = scriptedInput(i);
      recorder.record(input, game.weapon);
      game.step(input);
    }
    const run = recorder.finish(800)!;
    const final = [game.ps.origin[0], game.ps.origin[1], game.ps.origin[2]];

    expect(run.start.velocity).toEqual([380, 120, 220]);
    expect(run.start.groundEntityNum).toBe(ENTITYNUM_NONE);

    // Replayed WITH the captured start state: bit-exact, same as any other
    // replay in this file.
    const fixed = new Game({ world: platformWorld(96), origin: originOnFloor(0), weapon: Weapon.ROCKET_LAUNCHER });
    applyPlayerSnapshot(fixed.ps, run.start);
    const fixedPlayer = new GhostPlayer(run);
    let tick: { input: GameInput; weapon: Weapon } | null;
    while ((tick = fixedPlayer.next()) !== null) {
      fixed.selectWeapon(tick.weapon);
      fixed.step(tick.input);
    }
    expect(fixed.ps.origin[0]).toBe(final[0]);
    expect(fixed.ps.origin[1]).toBe(final[1]);
    expect(fixed.ps.origin[2]).toBe(final[2]);

    // Replayed WITHOUT it (the pre-fix shape -- grounded, zero velocity):
    // proves the bug is real, not just theoretical.
    const broken = new Game({ world: platformWorld(96), origin: originOnFloor(0), weapon: Weapon.ROCKET_LAUNCHER });
    const brokenPlayer = new GhostPlayer(run);
    while ((tick = brokenPlayer.next()) !== null) {
      broken.selectWeapon(tick.weapon);
      broken.step(tick.input);
    }
    expect(
      broken.ps.origin[0] !== final[0] ||
        broken.ps.origin[1] !== final[1] ||
        broken.ps.origin[2] !== final[2],
    ).toBe(true);
  });

  it('reproduces the run through a rocket jump too', () => {
    // The scripted run fires at tick 60, so this covers missiles, splash
    // damage and knockback, not just movement.
    const { run } = record(200);
    expect(run.ticks.some((t) => t.attack)).toBe(true);
  });

  it('reproduces a mid-run weapon switch, not just the usercmd stream', () => {
    // Weapon switches happen outside `usercmd` entirely (`main.ts`'s
    // hotkeys/wheel call `Game.selectWeapon` directly), so this is the case
    // that catches a ghost silently firing the wrong weapon.
    const game = new Game({
      world: platformWorld(96),
      origin: originOnFloor(0),
      weapon: Weapon.ROCKET_LAUNCHER,
    });
    addAmmo(game.ps, WeaponTag.GRENADE_LAUNCHER, 10);
    const recorder = new GhostRecorder('test', 8);
    recorder.start(game.ps);

    for (let i = 0; i < 100; i++) {
      if (i === 50) {
        expect(game.selectWeapon(Weapon.GRENADE_LAUNCHER)).toBe(true);
      }
      const input = scriptedInput(i);
      recorder.record(input, game.weapon);
      game.step(input);
    }
    const run = recorder.finish(800)!;

    expect(run.ticks[49].weapon).toBe(Weapon.ROCKET_LAUNCHER);
    expect(run.ticks[50].weapon).toBe(Weapon.GRENADE_LAUNCHER);

    const replay = new Game({
      world: platformWorld(96),
      origin: originOnFloor(0),
      weapon: Weapon.ROCKET_LAUNCHER,
    });
    addAmmo(replay.ps, WeaponTag.GRENADE_LAUNCHER, 10);
    const player = new GhostPlayer(run);

    let tick: { input: GameInput; weapon: Weapon } | null;
    while ((tick = player.next()) !== null) {
      replay.selectWeapon(tick.weapon);
      replay.step(tick.input);
    }

    expect(replay.weapon).toBe(Weapon.GRENADE_LAUNCHER);
    expect(replay.ps.origin[0]).toBe(game.ps.origin[0]);
    expect(replay.ps.origin[1]).toBe(game.ps.origin[1]);
    expect(replay.ps.origin[2]).toBe(game.ps.origin[2]);
  });

  it('runs out rather than looping', () => {
    const { run } = record(20);
    const player = new GhostPlayer(run);
    for (let i = 0; i < 20; i++) {
      expect(player.next()).not.toBeNull();
    }
    expect(player.next()).toBeNull();
    expect(player.finished).toBe(true);
  });

  it('replays again after a reset', () => {
    const { run } = record(10);
    const player = new GhostPlayer(run);
    while (player.next() !== null) {
      /* drain */
    }
    player.reset();
    expect(player.finished).toBe(false);
    expect(player.next()).not.toBeNull();
  });

  it('reports progress through the recording', () => {
    const { run } = record(10);
    const player = new GhostPlayer(run);
    expect(player.progress).toBe(0);
    for (let i = 0; i < 5; i++) {
      player.next();
    }
    expect(player.progress).toBeCloseTo(0.5, 6);
  });

  it('survives a round trip through JSON', () => {
    const { run, final } = record(120);
    const revived = parseGhost(JSON.parse(JSON.stringify(run)))!;
    expect(revived).not.toBeNull();

    const replay = new Game({
      world: platformWorld(96),
      origin: originOnFloor(0),
      weapon: Weapon.ROCKET_LAUNCHER,
    });
    const player = new GhostPlayer(revived);
    let tick: { input: GameInput; weapon: Weapon } | null;
    while ((tick = player.next()) !== null) {
      replay.selectWeapon(tick.weapon);
      replay.step(tick.input);
    }
    expect(replay.ps.origin[0]).toBe(final[0]);
    expect(replay.ps.origin[2]).toBe(final[2]);
  });
});

describe('GhostStore', () => {
  it('round-trips a saved ghost', () => {
    const store = new GhostStore(memoryStore());
    const run = ghostRun();
    expect(store.save(run)).toBe(true);
    expect(store.load('q3dm6', 'vq3', 8, 'chase')).toEqual(run);
  });

  it('has nothing for a map that was never saved', () => {
    const store = new GhostStore(memoryStore());
    expect(store.load('q3dm6', 'vq3', 8, 'chase')).toBeNull();
  });

  it('delete() removes exactly the ghost course select\'s "Reset PR" targets', () => {
    const store = new GhostStore(memoryStore());
    const vq3Run = ghostRun({ physics: 'vq3', time: 9000 });
    const cpmRun = ghostRun({ physics: 'cpm', time: 7000 });
    store.save(vq3Run);
    store.save(cpmRun);

    store.delete('q3dm6', 'vq3', 8, 'chase');

    expect(store.load('q3dm6', 'vq3', 8, 'chase')).toBeNull();
    expect(store.load('q3dm6', 'cpm', 8, 'chase')).toEqual(cpmRun);
  });

  it('keeps VQ3 and CPM ghosts on the same map apart', () => {
    // THE bug this store used to have: keyed on map alone, so finishing a
    // map in CPM after already holding a VQ3 ghost there clobbered it --
    // and the next VQ3 attempt raced a ghost recorded under different
    // physics, which `ghostGame` cannot legitimately replay. See ghost.ts's
    // file header.
    const store = new GhostStore(memoryStore());
    const vq3Run = ghostRun({ physics: 'vq3', time: 9000 });
    const cpmRun = ghostRun({ physics: 'cpm', time: 7000 });

    store.save(vq3Run);
    store.save(cpmRun);

    expect(store.load('q3dm6', 'vq3', 8, 'chase')).toEqual(vq3Run);
    expect(store.load('q3dm6', 'cpm', 8, 'chase')).toEqual(cpmRun);
  });

  it('keeps chase/side/fpv ghosts on the same map and physics apart', () => {
    // The camera half of the same bug: a `side` PR was set without the aim
    // laser's information, an `fpv` one without seeing your own body against
    // the geometry -- racing a `chase` ghost while playing `side` is racing
    // an opponent that had it easier. See ghost.ts's file header.
    const store = new GhostStore(memoryStore());
    const chaseRun = ghostRun({ camera: 'chase', time: 9000 });
    const sideRun = ghostRun({ camera: 'side', time: 8000 });
    const fpvRun = ghostRun({ camera: 'fpv', time: 7000 });

    store.save(chaseRun);
    store.save(sideRun);
    store.save(fpvRun);

    expect(store.load('q3dm6', 'vq3', 8, 'chase')).toEqual(chaseRun);
    expect(store.load('q3dm6', 'vq3', 8, 'side')).toEqual(sideRun);
    expect(store.load('q3dm6', 'vq3', 8, 'fpv')).toEqual(fpvRun);
  });

  it('adopts a ghost saved under the pre-camera (map, physics, msec) key, tagged with whichever camera asks', () => {
    // Generation 1: after physics/msec joined the key but before camera did.
    // THE regression this guards: an earlier version only adopted this for a
    // `chase` request, reasoning `chase` was the safe historical default --
    // which silently broke every ghost on ob_basics/ob_rockets, since both
    // ship a `.cam` script and have ALWAYS auto-resolved to `side`, never
    // `chase`. See the file header.
    const backing = memoryStore();
    const mid = ghostRun({ physics: 'vq3', camera: 'chase' });
    backing.setItem('overbounce.ghost.v1.q3dm6|vq3|8', JSON.stringify(mid));

    const store = new GhostStore(backing);
    const loaded = store.load('q3dm6', 'vq3', 8, 'side');
    // Re-tagged with the REQUESTING camera, not whatever the stale JSON said.
    expect(loaded).toEqual({ ...mid, camera: 'side' });

    // Adopted under the new (side-tagged) key so this lookup only ever runs
    // once -- the pre-camera source key is left in place, untouched.
    expect(backing.getItem('overbounce.ghost.v1.q3dm6|vq3|8|side')).not.toBeNull();
    expect(backing.getItem('overbounce.ghost.v1.q3dm6|vq3|8')).not.toBeNull();
  });

  it('never hands the pre-camera ghost back for a different physics mode', () => {
    // Camera is unrestricted now, but physics still has to match -- the mid
    // key is built from the REQUESTED physics, so a cpm request simply never
    // finds an entry saved under the vq3-built key.
    const backing = memoryStore();
    backing.setItem('overbounce.ghost.v1.q3dm6|vq3|8', JSON.stringify(ghostRun({ physics: 'vq3' })));

    const store = new GhostStore(backing);
    expect(store.load('q3dm6', 'cpm', 8, 'chase')).toBeNull();
  });

  it('adopts a ghost saved under the original map-only key, tagged with whichever camera asks', () => {
    // Generation 0: before this store carried anything but the map in its
    // key at all. Only vq3 ever existed under it -- CPM did not exist yet --
    // same "only mode that ever ran" reasoning records.ts's own v1 migration
    // uses. Camera is unrestricted for the same reason generation 1 is.
    const backing = memoryStore();
    const legacy = ghostRun({ physics: 'vq3', camera: 'chase' });
    backing.setItem('overbounce.ghost.v1.q3dm6', JSON.stringify(legacy));

    const store = new GhostStore(backing);
    const loaded = store.load('q3dm6', 'vq3', 8, 'fpv');
    expect(loaded).toEqual({ ...legacy, camera: 'fpv' });

    // Adopted under the new key so the legacy lookup only ever runs once.
    expect(backing.getItem('overbounce.ghost.v1.q3dm6|vq3|8|fpv')).not.toBeNull();
  });

  it('never hands the original map-only ghost back for a CPM request', () => {
    const backing = memoryStore();
    backing.setItem('overbounce.ghost.v1.q3dm6', JSON.stringify(ghostRun({ physics: 'vq3' })));

    const store = new GhostStore(backing);
    expect(store.load('q3dm6', 'cpm', 8, 'chase')).toBeNull();
  });
});

describe('parseGhost', () => {
  const valid = {
    version: 1,
    map: 'q3dm6',
    physics: 'vq3',
    camera: 'chase',
    time: 1000,
    msec: 8,
    origin: [0, 0, 0],
    ticks: [{ forward: 127, right: 0, up: 0, yaw: 0, pitch: 0, attack: false }],
    splits: [500],
    date: '2026-01-01',
  };

  it('accepts a well-formed ghost', () => {
    expect(parseGhost(valid)).not.toBeNull();
  });

  it('rejects anything that is not a ghost', () => {
    for (const bad of [null, undefined, 42, 'str', [], {}]) {
      expect(parseGhost(bad)).toBeNull();
    }
  });

  it('rejects a version it does not understand', () => {
    expect(parseGhost({ ...valid, version: 2 })).toBeNull();
  });

  it('rejects missing or malformed core fields', () => {
    expect(parseGhost({ ...valid, map: 7 })).toBeNull();
    expect(parseGhost({ ...valid, ticks: 'nope' })).toBeNull();
    expect(parseGhost({ ...valid, time: 'soon' })).toBeNull();
    expect(parseGhost({ ...valid, origin: [0, 0] })).toBeNull();
  });

  it('rejects the whole ghost when a single tick is malformed', () => {
    // Replaying a partially-repaired stream would diverge silently, which is
    // worse than refusing it outright.
    expect(
      parseGhost({ ...valid, ticks: [valid.ticks[0], { forward: 'fast' }] }),
    ).toBeNull();
  });

  it('fills in optional fields it can safely default', () => {
    const g = parseGhost({
      version: 1,
      map: 'x',
      time: 1,
      origin: [0, 0, 0],
      ticks: [{ forward: 0, right: 0, up: 0, yaw: 0 }],
    })!;
    expect(g.msec).toBe(8);
    expect(g.physics).toBe('vq3');
    expect(g.splits).toEqual([]);
    expect(g.ticks[0].pitch).toBe(0);
    expect(g.ticks[0].attack).toBe(false);
  });

  it('defaults a ghost saved before physics existed on it to vq3, and never invents cpm', () => {
    expect(parseGhost({ ...valid, physics: undefined })!.physics).toBe('vq3');
    expect(parseGhost({ ...valid, physics: 'nonsense' })!.physics).toBe('vq3');
    expect(parseGhost({ ...valid, physics: 'cpm' })!.physics).toBe('cpm');
  });

  it('defaults a ghost saved before camera existed on it to chase, and never invents side/fpv', () => {
    expect(parseGhost({ ...valid, camera: undefined })!.camera).toBe('chase');
    expect(parseGhost({ ...valid, camera: 'nonsense' })!.camera).toBe('chase');
    expect(parseGhost({ ...valid, camera: 'side' })!.camera).toBe('side');
    expect(parseGhost({ ...valid, camera: 'fpv' })!.camera).toBe('fpv');
  });

  it('defaults a ghost saved before weapon existed on its ticks to unarmed, and never invents one', () => {
    const withoutWeapon = {
      ...valid,
      ticks: [{ forward: 127, right: 0, up: 0, yaw: 0, pitch: 0, attack: false }],
    };
    expect(parseGhost(withoutWeapon)!.ticks[0].weapon).toBe(Weapon.NONE);
    expect(
      parseGhost({ ...valid, ticks: [{ ...valid.ticks[0], weapon: Weapon.PLASMAGUN }] })!.ticks[0]
        .weapon,
    ).toBe(Weapon.PLASMAGUN);
    expect(
      parseGhost({ ...valid, ticks: [{ ...valid.ticks[0], weapon: 99 }] })!.ticks[0].weapon,
    ).toBe(Weapon.NONE);
  });
});

describe('determinism', () => {
  it('gives identical results for two runs of the same stream', () => {
    // The plan's risk list calls for this explicitly: a missed Math.fround in
    // a hot path degrades overbounce accuracy silently, and a long replay
    // diverging between runs is how that would show up.
    const play = (): number[] => {
      const g = new Game({ world: flatWorld(), origin: originOnFloor(0) });
      for (let i = 0; i < 500; i++) {
        g.step(scriptedInput(i));
      }
      return [g.ps.origin[0], g.ps.origin[1], g.ps.origin[2], g.speed];
    };
    expect(play()).toEqual(play());
  });
});
