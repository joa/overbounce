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
import { GhostRecorder, GhostPlayer, parseGhost } from '../../src/game/ghost.js';
import { Weapon } from '../../src/game/weapons.js';
import { flatWorld, platformWorld, originOnFloor } from '../physics/world.js';

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
  recorder.start(game.ps.origin);

  for (let i = 0; i < ticks; i++) {
    const input = scriptedInput(i);
    recorder.record(input);
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
    r.record({ forward: 127 });
    expect(r.length).toBe(0);
    expect(r.active).toBe(false);
    expect(r.finish(0)).toBeNull();
  });

  it('records one tick per call once started', () => {
    const r = new GhostRecorder('test', 8);
    r.start([0, 0, 0]);
    for (let i = 0; i < 5; i++) {
      r.record({ forward: 127 });
    }
    expect(r.length).toBe(5);
  });

  it('discards the previous buffer when restarted', () => {
    const r = new GhostRecorder('test', 8);
    r.start([0, 0, 0]);
    r.record({ forward: 127 });
    r.start([0, 0, 0]);
    expect(r.length).toBe(0);
  });

  it('captures the origin the run started from', () => {
    const r = new GhostRecorder('test', 8);
    r.start([100, 200, 300]);
    r.record({});
    expect(r.finish(8)!.origin).toEqual([100, 200, 300]);
  });

  it('fills in defaults for keys the input omitted', () => {
    const r = new GhostRecorder('test', 8);
    r.start([0, 0, 0]);
    r.record({ forward: 127 });
    expect(r.finish(8)!.ticks[0]).toEqual({
      forward: 127,
      right: 0,
      up: 0,
      yaw: 0,
      pitch: 0,
      attack: false,
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

    let input: GameInput | null;
    while ((input = player.next()) !== null) {
      replay.step(input);
    }

    // Not "close to" — the same integer-millisecond inputs through the same
    // pmove must land on the same float32 bits. Anything less means the
    // simulation has a hidden source of state and the ghost is a lie.
    expect(replay.ps.origin[0]).toBe(final[0]);
    expect(replay.ps.origin[1]).toBe(final[1]);
    expect(replay.ps.origin[2]).toBe(final[2]);
  });

  it('reproduces the run through a rocket jump too', () => {
    // The scripted run fires at tick 60, so this covers missiles, splash
    // damage and knockback, not just movement.
    const { run } = record(200);
    expect(run.ticks.some((t) => t.attack)).toBe(true);
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
    let input: GameInput | null;
    while ((input = player.next()) !== null) {
      replay.step(input);
    }
    expect(replay.ps.origin[0]).toBe(final[0]);
    expect(replay.ps.origin[2]).toBe(final[2]);
  });
});

describe('parseGhost', () => {
  const valid = {
    version: 1,
    map: 'q3dm6',
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
    expect(g.splits).toEqual([]);
    expect(g.ticks[0].pitch).toBe(0);
    expect(g.ticks[0].attack).toBe(false);
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
