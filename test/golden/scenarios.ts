/**
 * The golden scenarios: scripted runs whose per-tick output must never change.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * These are the phase 0.1 gate from `.agent/plans/PERFORMANCE.md`. They are not
 * unit tests and they assert nothing about what Quake *should* do — the rest of
 * `test/physics/` does that, against id's constants, and it stays the authority
 * on correctness. These assert only that the output has not MOVED, which is the
 * property an optimization pass has to preserve and the one a unit test with a
 * tolerance cannot check.
 *
 * That difference dictates how they are written:
 *
 *  - **Broad, not deep.** The point is coverage of code paths (slidemove bumps,
 *    stepSlideMove, PM_CorrectAllSolid, ramp clipping, the CPM branch, missile
 *    tracing, mover pushing), because those are what the pooling work in phase 1
 *    touches. A scenario that never leaves flat ground gates nothing.
 *  - **Two worlds per scenario where possible.** See `Scenario.runBsp`. A flat
 *    brush list never enters `traceThroughTree` at all, so half the collision
 *    code would otherwise be left untested behind a wall of green.
 *  - **Deterministic.** No `Math.random` that can change an outcome, no wall
 *    clock. See the `teleporter` scenario for the one place that needed care.
 *  - **Long enough to diverge.** Floating-point drift compounds. A scenario that
 *    runs 800 ticks catches a one-ulp change that a 20-tick one would not.
 *
 * If a change here is intentional, regenerate with `npm run golden` and explain
 * the diff in the commit message. Regenerating to make a red test go green is
 * exactly the inversion CLAUDE.md's testing section prohibits.
 */

import { axialBrush, rampBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import type { CLeaf, CollisionModel } from '../../src/collision/model.js';
import { loadCollisionModel } from '../../src/collision/cm-load.js';
import type { BoxSpec } from '../collision/bsp-writer.js';
import { writeBsp } from '../collision/bsp-writer.js';
import { CONTENTS_SOLID, PMOVE_MSEC, SURF_SLICK } from '../../src/physics/constants.js';
import { Simulation } from '../../src/physics/simulate.js';
import type { Input, SimulationOptions } from '../../src/physics/simulate.js';
import { PhysicsMode } from '../../src/physics/types.js';
import { Game } from '../../src/game/game.js';
import type { GameInput } from '../../src/game/game.js';
import { Weapon } from '../../src/game/weapons.js';
import type { MapEntity } from '../../src/game/entities.js';
import {
  GAME_COLUMNS,
  PHYSICS_COLUMNS,
  physicsRow,
  snapshotText,
} from './record.js';

export interface Scenario {
  name: string;
  /** One line per tick, plus the header. */
  run(): string;
  /**
   * The same run against a compiled BSP instead of a flat brush list, or null
   * when the geometry cannot be expressed as one.
   *
   * This is not an extra scenario — it must produce the *same* snapshot. The
   * tree is an acceleration structure and is never allowed to change a result
   * (see `test/collision/bsp-physics.test.ts`), so one file gates both.
   *
   * It exists because `brushListModel` sets `nodes: []`, and `traceInternal`
   * then jumps straight to `traceThroughLeaf`. **`traceThroughTree` is never
   * entered at all against a flat list** — so without this, the single hottest
   * allocation site in the project (phase 1.2's two `vec3`s per node visited)
   * would have had no coverage whatsoever while appearing to be covered by a
   * wall of green scenarios. Null only where a scenario needs geometry the
   * writer cannot express: `writeBsp` compiles axis-aligned boxes into model 0.
   */
  runBsp(): string | null;
}

const FRAMETIME = PMOVE_MSEC / 1000;
const RAD2DEG = 180 / Math.PI;

/* ------------------------------------------------------------------ worlds */

/**
 * A scenario's geometry, described once and built two ways.
 *
 * `boxes` is the whole of it for most scenarios, and axis-aligned boxes are
 * exactly what `writeBsp` can compile — so those scenarios get both worlds and
 * their one snapshot gates both. `ramps` is the escape hatch for the non-axial
 * brushes `rampBrush` makes, which the writer cannot express; a spec with any
 * of those has no BSP variant.
 */
interface WorldSpec {
  boxes: BoxSpec[];
  ramps?: readonly {
    mins: [number, number, number];
    maxs: [number, number, number];
    slope: number;
  }[];
  /**
   * Where to cut the tree, in x. `writeBsp` splits on that axis only, so these
   * are placed through the span the player actually travels — a split the
   * sweep never crosses adds a node that is never descended and gates nothing.
   */
  splits?: number[];
}

const SOLID = CONTENTS_SOLID;
const FLOOR_MIN: [number, number, number] = [-8192, -8192, -512];

/** Cuts across the region every scenario below moves through. */
const SPLITS = [-1024, -512, -256, -128, -64, 0, 64, 128, 256, 384, 512, 768, 1024, 1536];

function box(
  mins: [number, number, number],
  maxs: [number, number, number],
  surfaceFlags = 0,
): BoxSpec {
  return { mins, maxs, contents: SOLID, surfaceFlags };
}

function listWorld(spec: WorldSpec): CollisionModel {
  const brushes = spec.boxes.map((b) =>
    axialBrush(b.mins, b.maxs, b.contents, b.surfaceFlags ?? 0),
  );
  for (const r of spec.ramps ?? []) {
    brushes.push(rampBrush(r.mins, r.maxs, r.slope, SOLID));
  }
  return brushListModel(brushes);
}

function bspWorld(spec: WorldSpec): CollisionModel | null {
  if (spec.ramps?.length) {
    return null;
  }
  return loadCollisionModel(writeBsp(spec.boxes, spec.splits ?? SPLITS));
}

/* -------------------------------------------------------------- geometries */

const FLAT: WorldSpec = { boxes: [box(FLOOR_MIN, [8192, 8192, 0])] };

const SLICK: WorldSpec = { boxes: [box(FLOOR_MIN, [8192, 8192, 0], SURF_SLICK)] };

/** Ground plus a ramp rising along +X from x = 0. Flat-list only. */
const RAMP: WorldSpec = {
  boxes: [box(FLOOR_MIN, [0, 8192, 0])],
  ramps: [{ mins: [0, -8192, -512], maxs: [512, 8192, 0], slope: 1 }],
};

/** A staircase of `count` treads: `stepSlideMove`'s STEPSIZE path, one per tread. */
function stairs(riser: number, tread: number, count: number): WorldSpec {
  const boxes = [box(FLOOR_MIN, [0, 8192, 0])];
  for (let i = 0; i < count; i++) {
    const x0 = i * tread;
    boxes.push(box([x0, -8192, -512], [x0 + tread, 8192, (i + 1) * riser]));
  }
  return { boxes };
}

/** A ledge to walk off, so the fall is long enough to land hard. */
function ledge(top: number): WorldSpec {
  return {
    boxes: [box(FLOOR_MIN, [8192, 8192, 0]), box([-8192, -8192, -512], [0, 8192, top])],
  };
}

/** A corridor with a pillar in it, so slidemove has something to bump along. */
const CORRIDOR: WorldSpec = {
  boxes: [
    box(FLOOR_MIN, [8192, 8192, 0]),
    // Two walls 192 apart, and a pillar off-centre between them.
    box([-8192, 96, -512], [8192, 8192, 256]),
    box([-8192, -8192, -512], [8192, -96, 256]),
    box([200, -40, -512], [264, 40, 256]),
  ],
};

/**
 * A floor with small, ISOLATED blocks scattered along +X, and a tree split
 * between every one of them.
 *
 * This exists because the other geometries cannot detect a leaf-selection bug.
 * In `FLAT`, `SLICK`, `CORRIDOR` and the rest, the floor brush spans the whole
 * map, so it lands in *every* leaf — a tree walk that descends the wrong child
 * still finds the floor and still returns the right answer. That was measured,
 * not assumed: with a deliberately aliased mid-point buffer (the exact bug
 * phase 1.2's depth-indexed stack has to avoid), every scenario built on those
 * worlds stayed green while visiting demonstrably different nodes.
 *
 * Here each block lives in one leaf and nowhere else, and the player runs into
 * them at speed. Skip a leaf and a collision is silently missed, which moves
 * the origin immediately. The blocks alternate high and low so some are stepped
 * onto (`stepSlideMove`) and some are struck flat.
 */
function obstacles(): WorldSpec {
  const boxes = [box(FLOOR_MIN, [8192, 8192, 0])];
  const splits: number[] = [];
  for (let i = 0; i < 10; i++) {
    const x = 64 + i * 160;
    // Alternating: a low kerb to step over, then a tall block to slide along.
    const top = i % 2 === 0 ? 14 : 96;
    boxes.push(box([x, -80, 0], [x + 48, 24 + (i % 3) * 26, top]));
    // Cuts either side of each block, so it is alone in its own leaf.
    splits.push(x - 8, x + 56);
  }
  return { boxes, splits };
}

/**
 * A world with brush submodels appended, for trigger and mover entities.
 *
 * The shape follows `test/game/movers.test.ts`: the brush goes in the model's
 * own list and gets a one-brush leaf of its own, which is what a real `.bsp`
 * submodel looks like after `cm-load.ts` is done with it.
 */
function withSubmodels(
  base: CollisionModel,
  boxes: readonly { mins: [number, number, number]; maxs: [number, number, number] }[],
): CollisionModel {
  const leafbrushes: number[] = Array.from(base.leafbrushes);
  const submodels: CollisionModel['submodels'] = [
    { mins: [-8192, -8192, -512], maxs: [8192, 8192, 8192], leaf: base.leafs[0] },
  ];

  for (const b of boxes) {
    base.brushes.push(axialBrush(b.mins, b.maxs, SOLID));
    const firstLeafBrush = leafbrushes.length;
    leafbrushes.push(base.brushes.length - 1);
    const leaf: CLeaf = {
      cluster: -1,
      area: -1,
      firstLeafBrush,
      numLeafBrushes: 1,
      firstLeafSurface: 0,
      numLeafSurfaces: 0,
    };
    submodels.push({ mins: [...b.mins], maxs: [...b.maxs], leaf });
  }

  base.leafbrushes = Int32Array.from(leafbrushes);
  base.submodels = submodels;
  return base;
}

function entity(fields: Partial<MapEntity> & { classname: string }): MapEntity {
  return {
    targetname: null,
    target: null,
    origin: [0, 0, 0],
    angles: [0, 0, 0],
    submodel: -1,
    spawnflags: 0,
    raw: {},
    ...fields,
  };
}

/* ----------------------------------------------------------------- drivers */

/**
 * Feet at `z`, plus the eighth of a unit every Q3 trace stops short by.
 * See `test/physics/world.ts`'s `originOnFloor` for why the epsilon is not
 * optional — spawning flush reports `allsolid` and burns the first tick in
 * `PM_CorrectAllSolid`, which is a different code path from resting.
 */
function onFloor(z: number): [number, number, number] {
  return [0, 0, z + 24 + 0.125];
}

/** The optimal strafe angle for this tick, the way `tools/replay.ts` solves it. */
function strafeYaw(sim: Simulation): number {
  const v = sim.ps.velocity;
  const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  const wishspeed = sim.ps.speed;
  const accelPerFrame = 1 * FRAMETIME * wishspeed;
  let theta = 0;
  if (speed > wishspeed - accelPerFrame) {
    theta = Math.acos((wishspeed - accelPerFrame) / speed) * RAD2DEG;
  }
  return Math.atan2(v[1], v[0]) * RAD2DEG - theta + 45;
}

function physicsRun(
  world: CollisionModel,
  options: Omit<SimulationOptions, 'world'>,
  ticks: number,
  input: (tick: number, sim: Simulation) => Input,
): string {
  const sim = new Simulation({ ...options, world });
  const rows: string[] = [];
  for (let i = 0; i < ticks; i++) {
    const frame = sim.step(input(i, sim));
    rows.push(physicsRow(i, sim.ps, frame.events));
  }
  return snapshotText(PHYSICS_COLUMNS, rows);
}

/** A movement-only scenario, run against both worlds its spec can build. */
function physics(
  name: string,
  spec: WorldSpec,
  options: Omit<SimulationOptions, 'world'>,
  ticks: number,
  input: (tick: number, sim: Simulation) => Input,
): Scenario {
  return {
    name,
    run: () => physicsRun(listWorld(spec), options, ticks, input),
    runBsp: () => {
      const world = bspWorld(spec);
      return world ? physicsRun(world, options, ticks, input) : null;
    },
  };
}

function gameRun(
  g: Game,
  ticks: number,
  input: (tick: number, g: Game) => GameInput,
): string {
  const rows: string[] = [];
  for (let i = 0; i < ticks; i++) {
    const f = g.step(input(i, g));
    rows.push(
      [
        physicsRow(i, g.ps, f.events),
        String(f.health),
        String(g.ps.armor),
        String(f.weapon),
        String(f.weaponTime),
        String(f.missiles),
        f.fired ? '1' : '0',
        f.explosions.length
          ? f.explosions
              .map((e) => `${e.classname}@${e.origin.map((c) => String(c)).join(',')}`)
              .join('|')
          : '-',
        f.course.length ? f.course.map((e) => e.kind).join('|') : '-',
      ].join('\t'),
    );
  }
  return snapshotText([...PHYSICS_COLUMNS, ...GAME_COLUMNS], rows);
}

/**
 * A `Game` scenario. `build` is called once per world rather than a prebuilt
 * `Game` being reused, because the two runs must not share mutable state —
 * `Movers` writes each door's `currentOrigin` in place, and `Game` carries the
 * whole of the player state.
 */
function gameScenario(
  name: string,
  spec: WorldSpec,
  build: (world: CollisionModel) => Game,
  ticks: number,
  input: (tick: number, g: Game) => GameInput,
): Scenario {
  return {
    name,
    run: () => gameRun(build(listWorld(spec)), ticks, input),
    runBsp: () => {
      const world = bspWorld(spec);
      return world ? gameRun(build(world), ticks, input) : null;
    },
  };
}

/* --------------------------------------------------------------- scenarios */

export const SCENARIOS: readonly Scenario[] = [
  /*
   * The single most valuable row in the table.
   *
   * Strafe jumping runs `PM_Accelerate`'s q2-style branch, `PM_AirMove`,
   * `PM_JumpMove`, the whole of `PM_SlideMove` and `SnapVector`, 800 times,
   * with the result of each tick feeding the next tick's aim. Any arithmetic
   * change anywhere in that path diverges here within a handful of ticks and
   * then diverges spectacularly.
   */
  physics('strafejump', FLAT, { origin: onFloor(0) }, 800, (tick, sim) =>
    tick < 60
      ? { forward: 127, yaw: 0 }
      : {
          forward: 127,
          right: 127,
          yaw: strafeYaw(sim),
          up: sim.onGround ? 127 : 0,
        },
  ),

  /*
   * The mechanic the game is named after: a tuned fall height that `PM_WalkMove`
   * converts into horizontal speed on landing, because `PM_GroundTrace` leaves
   * `velocity[2]` alone. Guards the commented-out line, `OVERCLIP`, and the
   * clip-renormalise-rescale sequence in one run.
   */
  physics(
    'overbounce',
    FLAT,
    { origin: [0, 0, 24 + 312.25], velocity: [100, 0, 0] },
    160,
    () => ({ forward: 127, yaw: 0 }),
  ),

  /* Friction decay from rest, then acceleration up to — and capped at — 320. */
  physics('walk-flat', FLAT, { origin: onFloor(0), velocity: [600, 0, 0] }, 300, (tick) =>
    tick < 100 ? {} : { forward: 127, yaw: tick < 200 ? 0 : (tick - 200) * 0.7 },
  ),

  /* No friction and air acceleration on the ground: a different `PM_Friction` path. */
  physics(
    'slick',
    SLICK,
    { origin: onFloor(0), velocity: [400, 60, 0] },
    300,
    (tick) => (tick < 150 ? {} : { forward: 127, right: 60, yaw: 20 }),
  ),

  /*
   * A 45-degree ramp. Non-axial planes, so this is the scenario that exercises
   * the `plane.type >= 3` branch and id's "this is silly" constant offset.
   * Flat-list only: `writeBsp` compiles boxes, not wedges.
   */
  physics(
    'ramp',
    RAMP,
    { origin: [-256, 0, 24.125], velocity: [400, 0, 0] },
    400,
    (tick, sim) => ({ forward: 127, yaw: 0, up: sim.onGround && tick > 60 ? 127 : 0 }),
  ),

  /* `stepSlideMove`'s STEPSIZE path, one retrace per tread. */
  physics(
    'stairs',
    stairs(12, 32, 24),
    { origin: [-128, 0, 24.125], velocity: [280, 0, 0] },
    400,
    () => ({ forward: 127, yaw: 0 }),
  ),

  /* Walking off a ledge: a long fall, then a landing hard enough to raise events. */
  physics('ledge-drop', ledge(512), { origin: [-128, 0, 512 + 24.125] }, 420, () => ({
    forward: 127,
    yaw: 0,
  })),

  /*
   * Sliding along walls and around a pillar. Every tick here spends its whole
   * budget in `PM_SlideMove`'s bump loop with two and three planes live, which
   * is the `planes[5]` array phase 1.4 pools.
   */
  physics('wall-slide', CORRIDOR, { origin: [-256, 0, 24.125] }, 400, (tick) => ({
    forward: 127,
    right: 90,
    yaw: Math.sin(tick / 40) * 55,
  })),

  /*
   * Running through a field of isolated blocks. See `obstacles()` for why this
   * scenario is load-bearing and the flat-floor ones are not: it is the only
   * geometry in the set where descending the wrong child of a BSP node changes
   * the answer rather than merely doing more work.
   */
  physics(
    'obstacles',
    obstacles(),
    { origin: [-128, 0, 24.125], velocity: [420, 0, 0] },
    500,
    (tick, sim) => ({
      forward: 127,
      right: 60,
      yaw: Math.sin(tick / 55) * 25,
      up: sim.onGround && tick % 47 === 0 ? 127 : 0,
    }),
  ),

  /*
   * CPM. Air control, the strafe-only clamp, and the double-jump window, none
   * of which VQ3 ever reaches. `cpm.ts` is not a verified port (see CLAUDE.md),
   * which makes a byte-identical gate *more* useful here, not less: there is no
   * upstream C to diff against if it drifts.
   */
  physics(
    'cpm-air',
    FLAT,
    { origin: onFloor(0), physicsMode: PhysicsMode.CPM },
    600,
    (tick, sim) =>
      tick < 40
        ? { forward: 127, yaw: 0 }
        : {
            forward: 127,
            right: tick % 120 < 60 ? 127 : -127,
            yaw: Math.sin(tick / 30) * 80,
            up: sim.onGround ? 127 : 0,
          },
  ),

  physics(
    'cpm-ramp',
    RAMP,
    { origin: [-256, 0, 24.125], velocity: [500, 0, 0], physicsMode: PhysicsMode.CPM },
    400,
    (tick, sim) => ({
      forward: 127,
      right: 40,
      yaw: 0,
      up: sim.onGround && tick > 40 ? 127 : 0,
    }),
  ),

  /*
   * A rocket jump. This is the only scenario that runs missiles, so it is the
   * gate on `missiles.ts`'s per-tick tracing, `damage.ts`'s knockback (full
   * damage) and health (halved) split, and `Game.step`'s explosion list —
   * which phase 1.5 proposes to pool.
   *
   * It is also the only scenario that makes a POINT trace (mins == maxs == 0):
   * instrumenting the whole set found exactly one, the missile's, against 905
   * box traces here and none at all anywhere else. That asymmetry is why
   * `test/collision/trace-isolation.test.ts` exists — see its header.
   */
  gameScenario(
    'rocketjump',
    FLAT,
    (world) => new Game({ world, origin: onFloor(0), weapon: Weapon.ROCKET_LAUNCHER }),
    300,
    (tick, g) => ({
      forward: 127,
      yaw: 0,
      // Look at the floor, jump and fire on the same tick, the way a real
      // rocket jump is performed.
      pitch: 80,
      up: tick === 40 && g.onGround ? 127 : 0,
      attack: tick === 40,
    }),
  ),

  /*
   * A jump pad. `AimAtTarget` solves the launch velocity at load, so this gates
   * both that solve and `touchJumpPad`'s `pm_time`/`PMF_TIME_KNOCKBACK` write.
   *
   * No BSP variant: the trigger is a brush submodel bolted on by
   * `withSubmodels`, and `writeBsp` emits model 0 only. Same for the two below.
   */
  {
    name: 'jumppad',
    run: () => {
      const world = withSubmodels(listWorld(FLAT), [
        { mins: [96, -64, 0], maxs: [160, 64, 16] },
      ]);
      const entities: MapEntity[] = [
        entity({ classname: 'trigger_push', submodel: 1, target: 'pad_dest' }),
        entity({
          classname: 'target_position',
          targetname: 'pad_dest',
          origin: [640, 0, 320],
        }),
      ];
      return gameRun(new Game({ world, entities, origin: onFloor(0) }), 400, () => ({
        forward: 127,
        yaw: 0,
      }));
    },
    runBsp: () => null,
  },

  /*
   * A teleporter. `teleportPlayer` rewrites `delta_angles`, which is why the
   * record carries them: a change there shows up as the view snapping to the
   * wrong place, and nothing about origin or velocity would reveal it.
   *
   * ONE destination, deliberately. `Game` does not expose `Course`'s injectable
   * RNG, so the course layer here runs on `Math.random` — and `pickTarget` does
   * `choices[Math.floor(rng() * choices.length)]`, which is index 0 for any
   * `rng()` in [0,1) when there is a single choice. Adding a second destination
   * would make this snapshot nondeterministic; if that is ever wanted, plumb an
   * `rng` option through `GameOptions` first.
   *
   * The yaw is fed back from `ps.viewangles` rather than held at a constant,
   * and that is not a detail. `teleportPlayer` clears `delta_angles` and relies
   * on the caller resyncing its input accumulator to the new view — that is the
   * whole contract, and `main.ts` implements it with `input.setView` on the
   * `teleport` event. A scenario that keeps sending its original yaw models a
   * caller that FORGOT to, so it would snapshot the view snapping straight back
   * and call that correct. Reading the view back each tick is what a player
   * holding the mouse still actually produces.
   */
  {
    name: 'teleporter',
    run: () => {
      const world = withSubmodels(listWorld(FLAT), [
        { mins: [96, -64, 0], maxs: [160, 64, 96] },
      ]);
      const entities: MapEntity[] = [
        entity({ classname: 'trigger_teleport', submodel: 1, target: 'tp_dest' }),
        entity({
          classname: 'misc_teleporter_dest',
          targetname: 'tp_dest',
          origin: [-512, 256, 40],
          angles: [0, 135, 0],
        }),
      ];
      return gameRun(new Game({ world, entities, origin: onFloor(0) }), 300, (_tick, g) => ({
        forward: 127,
        yaw: g.ps.viewangles[1],
      }));
    },
    runBsp: () => null,
  },

  /*
   * Riding a `func_door`. The door is a live `clipEntity`, so every trace this
   * scenario makes goes through `traceWithEntities` -> `clipMoveToEntities`
   * rather than the plain `boxTrace` fast path — which is the reentrancy
   * question phase 1.1's module-level `TraceWork` depends on. If a shared
   * `TraceWork` were unsafe across the world/entity trace pair, this is the
   * scenario that would show it.
   */
  {
    name: 'door-ride',
    run: () => {
      const world = withSubmodels(listWorld(FLAT), [
        { mins: [128, -32, 0], maxs: [192, 32, 16] },
      ]);
      const entities: MapEntity[] = [
        entity({
          classname: 'func_door',
          submodel: 1,
          // `[0, -1, 0]` is `G_SetMovedir`'s literal sentinel for STRAIGHT UP —
          // it is the `angle "-1"` F_ANGLEHACK, so it lives in the yaw slot, not
          // the pitch one. Writing `[-1, 0, 0]` instead does not fail: it falls
          // through to `angleVectors` and yields a near-horizontal movedir, so
          // the door slides sideways and merely drags the rider a fraction of a
          // unit. Worth knowing, because the scenario still *runs*.
          angles: [0, -1, 0],
          // `distance = DotProduct(abs_movedir, size) - lip` = 16 - 0, and
          // `trDuration = 16 * 1000 / 20` = 800ms, i.e. 100 ticks of being
          // carried — slow enough that the carry is a real span of ticks rather
          // than a couple, which is the point of the scenario.
          raw: { speed: '20', wait: '3', lip: '0' },
        }),
      ];
      // Spawned ON the door rather than walked onto it. The door's own touch
      // trigger fires as the player approaches, so a player who walks over
      // arrives at a slab that has already risen out of STEPSIZE range — and
      // whether they made it aboard would then depend on the door's speed,
      // which is exactly the kind of coupling a gate should not have.
      return gameRun(
        new Game({ world, entities, origin: [160, 0, 16 + 24.125] }),
        // 100 ticks of being carried up, then held. The door never comes back
        // down, and that is correct rather than a short script: `wait 3` only
        // starts counting once nobody is in the trigger, and the rider is in
        // it. `Touch_DoorTrigger` re-uses an OPEN door every tick someone
        // stands there — see `movers.ts`'s `MOVER_1TO2` note — so the tail of
        // this run gates that re-trigger path, which is worth as much as a
        // descent would have been.
        700,
        () => ({}),
      );
    },
    runBsp: () => null,
  },
];
