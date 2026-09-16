/**
 * A teleporter back to the spawn point calls off the run in progress.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Defrag maps put the fail routes on teleporters that lead back to the start —
 * flow's spawn has four of them, all aimed at a `target_teleporter` sitting on
 * its `info_player_start`. The walk back from there is nobody's run, so the
 * clock goes back to idle and the next crossing of the start gate times a
 * fresh attempt.
 *
 * The signal is the DESTINATION, not `target_init`: where a map puts one of
 * those relative to its start gate is the author's choice, and a map using one
 * mid-run for a known loadout would have its run cancelled by it.
 */

import { describe, it, expect } from 'vitest';
import { Game } from '../../src/game/game.js';
import { buildEntities } from '../../src/game/entities.js';
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import type { CollisionModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID } from '../../src/physics/constants.js';

const SPAWN = { origin: [0, 0, 24] as [number, number, number], yaw: 0 };

/**
 * A floor plus three trigger volumes, each its own submodel.
 *
 * `brushListModel` writes an identity `leafbrushes`, so a submodel's leaf
 * selects its own brush by index — which is what keeps the trigger boxes out
 * of submodel 0, the world hull the player actually collides with.
 */
function triggerWorld(): CollisionModel {
  const model = brushListModel([
    axialBrush([-8192, -8192, -64], [8192, 8192, 0], CONTENTS_SOLID),
    axialBrush([224, -32, 0], [288, 32, 96], CONTENTS_SOLID),
    axialBrush([992, -32, 0], [1056, 32, 96], CONTENTS_SOLID),
    axialBrush([2016, -32, 0], [2080, 32, 96], CONTENTS_SOLID),
  ]);
  const leaf = (first: number) => ({
    cluster: 0,
    area: 0,
    firstLeafBrush: first,
    numLeafBrushes: 1,
    firstLeafSurface: 0,
    numLeafSurfaces: 0,
  });
  model.submodels = [
    { mins: [-8192, -8192, -8192], maxs: [8192, 8192, 8192], leaf: leaf(0) },
    { mins: [224, -32, 0], maxs: [288, 32, 96], leaf: leaf(1) },
    { mins: [992, -32, 0], maxs: [1056, 32, 96], leaf: leaf(2) },
    { mins: [2016, -32, 0], maxs: [2080, 32, 96], leaf: leaf(3) },
  ];
  return model;
}

/** The start gate, a teleporter home, and a teleporter somewhere else. */
function newGame(): Game {
  const entities = buildEntities([
    { classname: 'trigger_multiple', model: '*1', target: 'gate' },
    { classname: 'target_startTimer', targetname: 'gate' },
    { classname: 'trigger_teleport', model: '*2', target: 'home' },
    // 8 units under the spawn, the way flow's own one sits under its
    // `info_player_start`.
    { classname: 'target_teleporter', targetname: 'home', origin: '0 0 16' },
    { classname: 'trigger_teleport', model: '*3', target: 'away' },
    { classname: 'target_teleporter', targetname: 'away', origin: '4096 0 24' },
  ]);
  return new Game({
    world: triggerWorld(),
    entities,
    origin: [...SPAWN.origin] as [number, number, number],
    spawn: SPAWN,
  });
}

/** Stand in a volume and let the tick's `G_TouchTriggers` find you there. */
function stepAt(game: Game, x: number, y: number, z: number) {
  game.ps.origin[0] = x;
  game.ps.origin[1] = y;
  game.ps.origin[2] = z;
  game.ps.velocity.fill(0);
  return game.step({});
}

const GATE: [number, number, number] = [256, 0, 24];
const HOME: [number, number, number] = [1024, 0, 24];
const AWAY: [number, number, number] = [2048, 0, 24];

describe('a teleporter back to the spawn', () => {
  it('sends the clock back to idle, and says so', () => {
    const game = newGame();
    stepAt(game, ...GATE);
    expect(game.course?.runState).toBe('running');

    const frame = stepAt(game, ...HOME);
    expect(frame.restarted).toBe(true);
    expect(game.course?.runState).toBe('idle');
    // And the player really is back at the spawn, not just re-clocked.
    expect(game.ps.origin[0]).toBeCloseTo(SPAWN.origin[0], 0);
    expect(game.ps.origin[1]).toBeCloseTo(SPAWN.origin[1], 0);
  });

  it('leaves an ordinary mid-route teleporter alone', () => {
    const game = newGame();
    stepAt(game, ...GATE);
    const startTime = game.course?.startTime;

    const frame = stepAt(game, ...AWAY);
    expect(frame.restarted).toBe(false);
    expect(game.course?.runState).toBe('running');
    // Same attempt: the clock never moved.
    expect(game.course?.startTime).toBe(startTime);
    expect(game.ps.origin[0]).toBeCloseTo(4096, 0);
  });

  it('does not erase a finished run', () => {
    // flow has one of these teleporters just past its own finish line. A
    // player who walks into it after finishing must keep the time they just
    // set -- it is still on screen, and still on its way to the results.
    const game = newGame();
    stepAt(game, ...GATE);
    game.course?.stopTimer(game.time);
    const elapsed = game.course?.elapsed(game.time);

    const frame = stepAt(game, ...HOME);
    expect(frame.restarted).toBe(false);
    expect(game.course?.runState).toBe('finished');
    expect(game.course?.elapsed(game.time)).toBe(elapsed);
  });

  it('does nothing when no run is in flight', () => {
    const game = newGame();
    const frame = stepAt(game, ...HOME);
    expect(frame.restarted).toBe(false);
    expect(game.course?.runState).toBe('idle');
  });
});
