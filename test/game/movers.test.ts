/**
 * `func_door` and `func_button` — the binary-mover half of `g_mover.c`.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Every expected number here is DERIVED from id's constants, never read off
 * what the code printed. The two formulas everything else hangs from are
 * `SP_func_door` and `InitMover`:
 *
 *     distance   = DotProduct( abs_movedir, size ) - lip
 *     trDuration = distance * 1000 / speed          (an int, so it truncates)
 *
 * with the shipped defaults `speed 400`, `wait 2` (seconds), `lip 8`, `dmg 2`.
 * The test door below is 64 x 12 x 100 and travels along +X, so
 * `distance = 64 - 8 = 56` and `trDuration = 56000 / 400 = 140`ms. Change the
 * door's size and every timing in this file changes with it — which is the
 * point, and is why the sizes are written out rather than hidden in a helper.
 *
 * See `.agent/plans/DOORS.md` for the two places the original task brief was
 * wrong (the trigger expands 120 on ONE axis, and `func_door` has no TOGGLE
 * spawnflag), and `.agent/docs/movers.md` for why shootable movers are absent.
 */

import { describe, it, expect } from 'vitest';
import { axialBrush } from '../../src/collision/brush.js';
import type { CLeaf, CollisionModel } from '../../src/collision/model.js';
import { brushListModel } from '../../src/collision/model.js';
import { Movers, MoverState } from '../../src/game/movers.js';
import type { PushTarget } from '../../src/game/movers.js';
import type { MapEntity } from '../../src/game/entities.js';
import { CONTENTS_SOLID, PMOVE_MSEC } from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';
import { Game } from '../../src/game/game.js';

/** The q3dm7 crusher's shape, which is what drove the port. */
const DOOR_MINS = [-32, -6, 0];
const DOOR_MAXS = [32, 6, 100];

/** `distance = DotProduct(abs_movedir, size) - lip` with movedir +X. */
const DOOR_DISTANCE = DOOR_MAXS[0] - DOOR_MINS[0] - 8; // 56
/** `trDuration = distance * 1000 / speed`, speed 400. */
const DOOR_DURATION = (DOOR_DISTANCE * 1000) / 400; // 140ms

function world(
  slabs: { mins: number[]; maxs: number[] }[],
  walls: { mins: number[]; maxs: number[] }[] = [],
): CollisionModel {
  const floor = axialBrush([-2048, -2048, -64], [2048, 2048, 0], CONTENTS_SOLID);
  // Walls go in the WORLD brush list, so they are reachable through the BSP
  // tree. A slab appended afterwards is only reachable through its own
  // submodel leaf, which is exactly the difference being tested.
  const model = brushListModel([
    floor,
    ...walls.map((w) =>
      axialBrush(
        [w.mins[0], w.mins[1], w.mins[2]],
        [w.maxs[0], w.maxs[1], w.maxs[2]],
        CONTENTS_SOLID,
      ),
    ),
  ]);

  const leafbrushes: number[] = Array.from(model.leafbrushes);
  const submodels: CollisionModel['submodels'] = [
    { mins: [-2048, -2048, -64], maxs: [2048, 2048, 0], leaf: model.leafs[0] },
  ];

  for (const slab of slabs) {
    model.brushes.push(
      axialBrush(
        [slab.mins[0], slab.mins[1], slab.mins[2]],
        [slab.maxs[0], slab.maxs[1], slab.maxs[2]],
        CONTENTS_SOLID,
      ),
    );
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
    submodels.push({
      mins: [slab.mins[0], slab.mins[1], slab.mins[2]],
      maxs: [slab.maxs[0], slab.maxs[1], slab.maxs[2]],
      leaf,
    });
  }

  model.leafbrushes = Int32Array.from(leafbrushes);
  model.submodels = submodels;
  return model;
}

function entity(fields: Partial<MapEntity> & { classname: string }): MapEntity {
  return {
    targetname: null,
    target: null,
    origin: [0, 0, 0],
    // Yaw 0 -> AngleVectors forward is +X, which is the movedir every timing
    // in this file assumes.
    angles: [0, 0, 0],
    submodel: -1,
    spawnflags: 0,
    raw: {},
    ...fields,
  };
}

const doorEntity = (fields: Partial<MapEntity> = {}): MapEntity =>
  entity({ classname: 'func_door', submodel: 1, ...fields });

/** A player standing on the floor, as `G_MoverPush` needs to see them. */
function standingAt(x: number, y: number): PushTarget {
  return {
    entityNum: 0,
    ps: {
      origin: vec3(x, y, 24.125),
      velocity: vec3(),
      groundEntityNum: 1022,
    } as unknown as PushTarget['ps'],
    mins: vec3(-15, -15, -24),
    maxs: vec3(15, 15, 32),
    groundEntityNum: 1022,
  };
}

/** Advance `ms` of level time in 8ms ticks, the way `Game.step` does. */
function tick(movers: Movers, from: number, ms: number, target: PushTarget | null = null): number {
  let time = from;
  for (let elapsed = 0; elapsed < ms; elapsed += PMOVE_MSEC) {
    time += PMOVE_MSEC;
    movers.run(time, PMOVE_MSEC, target);
  }
  return time;
}

describe('SP_func_door', () => {
  it('derives pos2 and trDuration from the brush size, lip and speed', () => {
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity()], 1);
    const door = movers.movers[0];

    expect([...door.pos1]).toEqual([0, 0, 0]);
    expect(door.pos2[0]).toBeCloseTo(DOOR_DISTANCE, 5);
    expect(door.pos.trDuration).toBe(DOOR_DURATION);
    // `ent->wait *= 1000` in the spawn function, so 2 seconds is stored as ms.
    expect(door.wait).toBe(2000);
    // "default damage of 2 points"
    expect(door.damage).toBe(2);
    expect(door.moverState).toBe(MoverState.POS1);
  });

  it('honours an explicit speed and lip', () => {
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity({ raw: { speed: '200', lip: '0' } })], 1);
    const door = movers.movers[0];

    expect(door.pos2[0]).toBeCloseTo(64, 5); // no lip taken off
    expect(door.pos.trDuration).toBe((64 * 1000) / 200); // 320ms
  });

  it('reverses pos1 and pos2 for START_OPEN', () => {
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity({ spawnflags: 1 })], 1);
    const door = movers.movers[0];

    expect(door.pos1[0]).toBeCloseTo(DOOR_DISTANCE, 5);
    expect([...door.pos2]).toEqual([0, 0, 0]);
  });

  it('sends `angle -2` straight down, not along a yaw', () => {
    // F_ANGLEHACK: `angle "-2"` becomes angles {0,-2,0} and means DOWN. The
    // q3dm7 crusher is spawned exactly this way, so getting it wrong would
    // send that door sideways through a wall.
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity({ angles: [0, -2, 0] })], 1);
    const door = movers.movers[0];

    expect([...door.movedir]).toEqual([0, 0, -1]);
    // Now the height is the axis that counts: 100 - 8 = 92 down.
    expect(door.pos2[2]).toBeCloseTo(-92, 5);
  });
});

describe('Use_BinaryMover', () => {
  it('does not start the move until 50ms after being used', () => {
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    // A targetname suppresses the auto trigger, so nothing else can open it.
    const movers = new Movers(model, [doorEntity({ targetname: 't1' })], 1);
    const door = movers.movers[0];

    // Get past the 100ms door-trigger think first, so level time is realistic.
    let t = tick(movers, 0, 200);
    movers.useTargets('t1');

    // id's comment: "start moving 50 msec later, becase if this was player
    // triggered, level.time hasn't been advanced yet". A wall-clock constant;
    // it does NOT scale with the 8ms tick.
    t = tick(movers, t, 48);
    expect(door.currentOrigin[0]).toBe(0);

    tick(movers, t, 16);
    expect(door.currentOrigin[0]).toBeGreaterThan(0);
  });

  it('reaches pos2 after trDuration and waits there', () => {
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity({ targetname: 't1' })], 1);
    const door = movers.movers[0];

    let t = tick(movers, 0, 200);
    movers.useTargets('t1');

    // 50ms of delay plus 140ms of travel, rounded up to a tick boundary.
    t = tick(movers, t, 200);
    expect(door.moverState).toBe(MoverState.POS2);
    expect(door.currentOrigin[0]).toBeCloseTo(DOOR_DISTANCE, 3);

    // `wait` is 2000ms. Well inside it, the door is still open.
    t = tick(movers, t, 1000);
    expect(door.moverState).toBe(MoverState.POS2);

    // Past it, it goes back and arrives.
    tick(movers, t, 1200 + DOOR_DURATION + PMOVE_MSEC);
    expect(door.moverState).toBe(MoverState.POS1);
    expect(door.currentOrigin[0]).toBeCloseTo(0, 3);
  });
});

describe('the auto door trigger', () => {
  it('is not spawned for a door with a targetname', () => {
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity({ targetname: 't1' })], 1);
    tick(movers, 0, 200);
    expect(movers.movers[0].trigger).toBeNull();
  });

  it('is not spawned for a door with health', () => {
    // `G_SpawnInt("health", ...)` is a LOCAL in id's source, so a shootable
    // door never gets a touch field. Shootable movers are not implemented, but
    // this half of the behaviour still has to be, or acc_fuzzle's shoot-only
    // buttons would all become walk-into ones.
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity({ raw: { health: '100' } })], 1);
    tick(movers, 0, 200);
    expect(movers.movers[0].trigger).toBeNull();
  });

  it('expands 120 units on the single THINNEST axis', () => {
    // Not 60, and not on two axes -- 60-on-two is the Quake II shape.
    // The door is 64 x 12 x 100, so Y is thinnest and Y is what grows.
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity()], 1);
    tick(movers, 0, 200);

    const trigger = movers.movers[0].trigger;
    expect(trigger).not.toBeNull();
    expect(trigger?.count).toBe(1); // the Y axis
    expect([...(trigger?.mins ?? [])]).toEqual([-32, -6 - 120, 0]);
    expect([...(trigger?.maxs ?? [])]).toEqual([32, 6 + 120, 100]);
  });

  it('opens the door from inside the trigger and not from outside it', () => {
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);

    // The trigger reaches y = 126, and the player's own box is 15 deep, so the
    // last y that overlaps is 141. Both sides of that line are checked.
    for (const [y, shouldOpen] of [
      [140, true],
      [145, false],
    ] as const) {
      const movers = new Movers(model, [doorEntity()], 1);
      const player = standingAt(0, y);
      const t = tick(movers, 0, 200);

      movers.touchDoorTriggers(player.ps, player.mins, player.maxs);
      tick(movers, t, 200);

      expect(movers.movers[0].currentOrigin[0] > 0).toBe(shouldOpen);
    }
  });

  it('does not re-use a door that is already opening', () => {
    // The `moverState != MOVER_1TO2` guard. Without it, standing in the
    // trigger would restart the move every single tick and the door would
    // never arrive.
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity()], 1);
    const player = standingAt(0, 100);

    let t = tick(movers, 0, 200);
    for (let i = 0; i < 40; i++) {
      movers.touchDoorTriggers(player.ps, player.mins, player.maxs);
      t = tick(movers, t, PMOVE_MSEC);
    }
    expect(movers.movers[0].moverState).toBe(MoverState.POS2);
  });
});

describe('func_button', () => {
  it('fires its target on REACHING pos2, not on being touched', () => {
    const model = world([
      { mins: [-8, -8, 0], maxs: [8, 8, 32] }, // the button, submodel 1
      { mins: DOOR_MINS, maxs: DOOR_MAXS }, // the door it opens, submodel 2
    ]);
    const movers = new Movers(
      model,
      [
        entity({ classname: 'func_button', submodel: 1, target: 't2' }),
        doorEntity({ submodel: 2, targetname: 't2' }),
      ],
      1,
    );
    const [button, door] = movers.movers;

    let t = tick(movers, 0, 200);

    // `ClientImpacts` -- the player bumped into the button. It is a SOLID, not
    // a trigger: this is what `PM_SlideMove` recorded and `clip.ts` stamped.
    movers.touchEntity(button.entityNum);

    // The button's own travel: 16 wide, lip 4 -> 12 units at speed 40 -> 300ms.
    expect(button.pos.trDuration).toBe(300);

    // A tick later the button is moving and the door has NOT been told
    // anything. This is the assertion that matters: touching is not firing.
    t = tick(movers, t, 100);
    expect(button.currentOrigin[0]).toBeGreaterThan(0);
    expect(door.currentOrigin[0]).toBe(0);

    // Past 50 + 300ms the button arrives and only then fires.
    t = tick(movers, t, 300);
    expect(button.moverState).toBe(MoverState.POS2);
    tick(movers, t, 250);
    expect(door.currentOrigin[0]).toBeGreaterThan(0);
  });

  it('is not fired by touching a shootable button', () => {
    const model = world([{ mins: [-8, -8, 0], maxs: [8, 8, 32] }]);
    const movers = new Movers(
      model,
      [entity({ classname: 'func_button', submodel: 1, raw: { health: '1' } })],
      1,
    );
    const t = tick(movers, 0, 200);
    movers.touchEntity(movers.movers[0].entityNum);
    tick(movers, t, 400);
    expect(movers.movers[0].currentOrigin[0]).toBe(0);
  });
});

describe('teams', () => {
  it('opens both halves of a two-part door together', () => {
    // q3dm2's `stephanie` pair: two doors sharing a `team` key and no
    // targetname, so `G_FindTeams` chains them and one trigger drives both.
    const model = world([
      { mins: [-64, -6, 0], maxs: [0, 6, 100] },
      { mins: [0, -6, 0], maxs: [64, 6, 100] },
    ]);
    const movers = new Movers(
      model,
      [
        doorEntity({ submodel: 1, raw: { team: 'stephanie' } }),
        doorEntity({ submodel: 2, raw: { team: 'stephanie', angle: '180' }, angles: [0, 180, 0] }),
      ],
      1,
    );
    const [left, right] = movers.movers;

    expect(right.teamslave).toBe(true);
    expect(right.teammaster).toBe(left);
    // Only the master gets a trigger, and it covers the whole team's bounds.
    expect(left.trigger).toBeNull();

    const player = standingAt(0, 100);
    const t = tick(movers, 0, 200);
    expect(left.trigger).not.toBeNull();

    movers.touchDoorTriggers(player.ps, player.mins, player.maxs);
    tick(movers, t, 400);

    expect(left.currentOrigin[0]).not.toBe(0);
    expect(right.currentOrigin[0]).not.toBe(0);
    // They move in opposite directions -- that is what makes it a pair.
    expect(Math.sign(left.currentOrigin[0])).toBe(-Math.sign(right.currentOrigin[0]));
  });
});

describe('being in the way', () => {
  it('pushes a player standing where the door is going', () => {
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity({ targetname: 't1' })], 1);
    // Just past the door's leading face, inside the 56 units it will travel.
    const player = standingAt(50, 0);
    const startX = player.ps.origin[0];

    const t = tick(movers, 0, 200, player);
    movers.useTargets('t1');
    tick(movers, t, 200, player);

    expect(player.ps.origin[0]).toBeGreaterThan(startX);
  });

  it('is blocked by a player it cannot push clear', () => {
    // The player stands at x = 60, so their box reaches x = 75 and the wall
    // begins at 76: one unit of room. The door covers 56 units in 140ms, which
    // is 3.2 per tick, so it jams on the very first push.
    const model = world(
      [{ mins: DOOR_MINS, maxs: DOOR_MAXS }],
      [{ mins: [76, -64, 0], maxs: [200, 64, 128] }],
    );
    const movers = new Movers(model, [doorEntity({ targetname: 't1' })], 1);
    const door = movers.movers[0];
    const player = standingAt(60, 0); // between the door and the wall

    const t = tick(movers, 0, 200, player);
    movers.useTargets('t1');
    tick(movers, t, 400, player);

    // `moverTeam` backs the whole team out of a blocked move, so the door
    // never reaches pos2 for as long as the player is wedged there.
    expect(door.currentOrigin[0]).toBeLessThan(DOOR_DISTANCE);
    expect(door.moverState).not.toBe(MoverState.POS2);
  });
});

describe('Game integration', () => {
  it('opens a door from a trigger_multiple through the Course', () => {
    // The q3dm7 `t1` path: a trigger volume the player walks into, targeting a
    // door by name. The Course does not own movers, so it reports a `use`
    // event and the Game routes it -- three modules, one behaviour.
    // The door sits well away from the spawn point. A door ON the spawn point
    // would swallow the player, respawn them, and reset the movers every tick
    // -- which is a real behaviour, and a useless test.
    const model = world([
      { mins: [268, -6, 0], maxs: [332, 6, 100] }, // submodel 1: the door
      { mins: [-64, -64, 0], maxs: [64, 64, 128] }, // submodel 2: the trigger
    ]);
    const game = new Game({
      world: model,
      origin: [0, 0, 30],
      entities: [
        doorEntity({ submodel: 1, targetname: 't1' }),
        entity({ classname: 'trigger_multiple', submodel: 2, target: 't1' }),
      ],
    });

    const door = game.movers?.movers[0];
    expect(door).toBeDefined();
    expect(door?.currentOrigin[0]).toBe(0);

    game.run(60, {}); // 480ms: past the trigger, the 50ms delay and the travel
    expect(door?.currentOrigin[0]).toBeCloseTo(DOOR_DISTANCE, 3);
  });

  it('makes a closed door solid to the player', () => {
    const model = world([{ mins: [100, -64, 0], maxs: [132, 64, 128] }]);
    const game = new Game({
      world: model,
      origin: [0, 0, 30],
      // A targetname means no trigger, so it stays shut for the whole run.
      entities: [doorEntity({ targetname: 'never' })],
    });

    // Run straight at it at full speed for two seconds.
    game.run(250, { forward: 127, yaw: 0 });

    // Stopped by the door's near face at x = 100, minus the player's own half
    // width, minus the trace epsilon.
    expect(game.ps.origin[0]).toBeLessThan(86);
    expect(game.ps.origin[0]).toBeGreaterThan(80);
  });

  it('puts every mover back at pos1 on a course restart', () => {
    const model = world([{ mins: [268, -6, 0], maxs: [332, 6, 100] }]);
    const game = new Game({
      world: model,
      origin: [0, 0, 30],
      entities: [doorEntity({ targetname: 't1' })],
    });

    game.run(30, {});
    game.movers?.useTargets('t1');
    game.run(40, {});
    expect(game.movers?.movers[0].currentOrigin[0]).toBeGreaterThan(0);

    // Dying restarts the run. A door left half open would make two attempts at
    // the same course incomparable.
    game.hurt(1000);
    game.run(2, {});
    expect(game.movers?.movers[0].currentOrigin[0]).toBe(0);
    expect(game.movers?.movers[0].moverState).toBe(MoverState.POS1);
  });
});

describe('sounds', () => {
  it('names id`s own wavs, and a button gets a start sound only', () => {
    const model = world([
      { mins: DOOR_MINS, maxs: DOOR_MAXS },
      { mins: [-8, -8, 0], maxs: [8, 8, 32] },
    ]);
    const movers = new Movers(
      model,
      [doorEntity({ targetname: 't1' }), entity({ classname: 'func_button', submodel: 2 })],
      1,
    );
    const [door, button] = movers.movers;

    // g_mover.c:952 -- one start sound for both directions, one end sound for
    // both ends.
    expect(door.sound1to2).toBe('sound/movers/doors/dr1_strt.wav');
    expect(door.sound2to1).toBe(door.sound1to2);
    expect(door.soundPos1).toBe('sound/movers/doors/dr1_end.wav');
    expect(door.soundPos2).toBe(door.soundPos1);

    // g_mover.c:1204 sets sound1to2 and NOTHING else. A button clicks going in
    // and is silent coming back out; giving it an end sound would be invention.
    expect(button.sound1to2).toBe('sound/movers/switches/butn2.wav');
    expect(button.sound2to1).toBeNull();
    expect(button.soundPos1).toBeNull();
    expect(button.soundPos2).toBeNull();
  });

  it('reports a start sound on use and an end sound on arrival', () => {
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity({ targetname: 't1' })], 1);

    const t = tick(movers, 0, 200);

    movers.useTargets('t1');
    const onUse = movers.events.filter((e) => e.kind === 'sound');
    expect(onUse.map((e) => e.sound)).toEqual(['sound/movers/doors/dr1_strt.wav']);
    // It carries the mover's position, because that is where the client plays
    // it -- a door across the map has to be able to come out quieter.
    expect(onUse[0].origin).toEqual([0, 0, 0]);

    // Nothing more until it arrives, 50 + 140ms later.
    const sounds: (string | undefined)[] = [];
    let time = t;
    for (let i = 0; i < 60; i++) {
      time += PMOVE_MSEC;
      movers.run(time, PMOVE_MSEC, null);
      for (const e of movers.events) {
        if (e.kind === 'sound') {
          sounds.push(e.sound);
        }
      }
    }
    expect(sounds).toContain('sound/movers/doors/dr1_end.wav');
  });
});

describe('shooting a mover', () => {
  /*
   * `G_Damage`'s `ET_MOVER` branch (g_combat.c:859):
   *
   *   // shootable doors / buttons don't actually have any health
   *   if ( targ->s.eType == ET_MOVER ) {
   *       if ( targ->use && targ->moverState == MOVER_POS1 ) {
   *           targ->use( targ, inflictor, attacker );
   *       }
   *       return;
   *   }
   *
   * That early return is why no mover ever needing a `die` function is not the
   * hole it looks like: damage on a mover becomes a USE and leaves before the
   * `die` path is ever consulted.
   */
  it('marks an auto-trigger door shootable without the mapper asking', () => {
    // `Think_SpawnNewDoorTrigger`: "set all of the slaves as shootable". Every
    // ordinary door in every map, not a rare opt-in.
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity()], 1);
    expect(movers.movers[0].takedamage).toBe(false); // not until the think runs
    tick(movers, 0, 200);
    expect(movers.movers[0].takedamage).toBe(true);
  });

  it('opens a closed door when a weapon hits it', () => {
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity()], 1);
    const door = movers.movers[0];
    const t = tick(movers, 0, 200);

    movers.damage(door.entityNum);
    tick(movers, t, 300);
    expect(door.currentOrigin[0]).toBeCloseTo(DOOR_DISTANCE, 3);
  });

  it('does nothing to a door that is already open or moving', () => {
    // The `MOVER_POS1` test. A door cannot be held open, or slammed shut, with
    // gunfire -- only a CLOSED one responds.
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity()], 1);
    const door = movers.movers[0];
    let t = tick(movers, 0, 200);

    movers.damage(door.entityNum);
    t = tick(movers, t, 300);
    expect(door.moverState).toBe(MoverState.POS2);

    // Shooting it again must not restart it or reset its wait.
    const openAt = door.currentOrigin[0];
    movers.damage(door.entityNum);
    t = tick(movers, t, 100);
    expect(door.currentOrigin[0]).toBe(openAt);
    expect(door.moverState).toBe(MoverState.POS2);
  });

  it('leaves a targetname door alone until it is shootable', () => {
    // A door with a targetname gets `Think_MatchTeam` rather than
    // `Think_SpawnNewDoorTrigger`, so nothing ever sets `takedamage` on it --
    // it opens from its trigger and not from gunfire.
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity({ targetname: 't1' })], 1);
    const door = movers.movers[0];
    const t = tick(movers, 0, 200);

    expect(door.takedamage).toBe(false);
    movers.damage(door.entityNum);
    tick(movers, t, 300);
    expect(door.currentOrigin[0]).toBe(0);
  });

  it('makes a health button shootable and NOT walk-into', () => {
    // acc_fuzzle's eighteen. `SP_func_button`'s two branches are exclusive:
    // `if (ent->health) takedamage else touch = Touch_Button`.
    const model = world([{ mins: [-8, -8, 0], maxs: [8, 8, 32] }]);
    const movers = new Movers(
      model,
      [entity({ classname: 'func_button', submodel: 1, raw: { health: '1' } })],
      1,
    );
    const button = movers.movers[0];
    let t = tick(movers, 0, 200);

    expect(button.takedamage).toBe(true);

    // Walking into it does nothing...
    movers.touchEntity(button.entityNum);
    t = tick(movers, t, 200);
    expect(button.currentOrigin[0]).toBe(0);

    // ...but shooting it works.
    movers.damage(button.entityNum);
    tick(movers, t, 200);
    expect(button.currentOrigin[0]).toBeGreaterThan(0);
  });

  it('opens a door from splash damage nearby', () => {
    /*
     * `G_RadiusDamage` reaches movers too. Quake computes falloff points and
     * `G_Damage` throws them away for a mover, so the only surviving question
     * is whether it is inside the radius -- a rocket landing NEAR a door opens
     * it just as a direct hit does.
     */
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity()], 1);
    const door = movers.movers[0];
    const t = tick(movers, 0, 200);

    // 60 units off the door's face, well inside a rocket's 120 splash.
    movers.splash(vec3(0, 66, 50), 120);
    tick(movers, t, 300);
    expect(door.currentOrigin[0]).toBeCloseTo(DOOR_DISTANCE, 3);
  });

  it('leaves a door outside the splash radius shut', () => {
    const model = world([{ mins: DOOR_MINS, maxs: DOOR_MAXS }]);
    const movers = new Movers(model, [doorEntity()], 1);
    const door = movers.movers[0];
    const t = tick(movers, 0, 200);

    movers.splash(vec3(0, 400, 50), 120);
    tick(movers, t, 300);
    expect(door.currentOrigin[0]).toBe(0);
  });
});
