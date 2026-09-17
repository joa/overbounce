/**
 * ob_basics: replay what the tutorial course's geometry has to do, headlessly
 * against the compiled BSP. Added with the 2026-09-17 round (the strafe
 * rescue returns to the spawn, the lid's top is textured, the first pad wears
 * a real pad shader); the course predates the per-course checks, so this is
 * deliberately small and covers only what that round touched plus the timers.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * What is asserted:
 *
 *  1. The first launch pad (a `trigger_push` walked onto from the start
 *     floor) lands the player on the first strafe island.
 *  2. A miss on the strafe islands is a restart: the rescue lands at the
 *     spawn, before the start gate, and running through the gate again fires
 *     `target_startTimer`, which resets the clock.
 *  3. Every rescue teleporter is a void catch: below every standing surface
 *     in reach with the step-up and a margin (`side-locked-courses.md`).
 *  4. The lid over the plasma and overbounce section (kept on purpose: it
 *     stops jumps there, and skipping the section is allowed) has no caulk
 *     on a face the side camera can see.
 *  5. The timer gates fire, and the `.cam` parses.
 */

import type { Brush } from '../../src/collision/brush.js';
import type { Game } from '../../src/game/game.js';
import { CONTENTS_PLAYERCLIP, CONTENTS_SOLID, SURF_NODRAW } from '../../src/physics/constants.js';
import type { World } from './harness.js';
import { NONE, cameraScript, check, feet, newGame, settle, walkOntoPad, x } from './harness.js';

interface Platform {
  name: string;
  x0: number;
  x1: number;
  top: number;
}

// ---------------------------------------------------------------------------
// Layout (maps/ob_basics.map). Change both together.
// ---------------------------------------------------------------------------

const SPAWN: [number, number, number] = [-224, 0, 40];
/** The start gate's near face; the strafe rescue lands before it. */
const START_GATE_X0 = 128;
const START: Platform = { name: 'the start floor', x0: -384, x1: 1600, top: 0 };
const PAD_X0 = 768;
const ISLANDS: readonly Platform[] = [
  { name: 'island 1', x0: 1600, x1: 1856, top: 0 },
  { name: 'island 2', x0: 1984, x1: 2240, top: 0 },
  { name: 'island 3', x0: 2416, x1: 2672, top: 0 },
  { name: 'island 4', x0: 2896, x1: 3152, top: 0 },
  { name: 'the rocket floor', x0: 3408, x1: 4032, top: 0 },
];
/** The lid over the plasma and overbounce section. */
const LID: { x0: number; x1: number; z0: number; z1: number } = { x0: 4928, x1: 5992, z0: 420, z1: 492 };
const STOP_X = 6568;
const FINISH_TOP = 304;

function restingOn(game: Game, p: Platform): boolean {
  return x(game) >= p.x0 - 15 && x(game) <= p.x1 + 15 && Math.abs(feet(game) - (p.top + 0.125)) < 0.5;
}

function teleported(frame: ReturnType<Game['step']>): boolean {
  return frame.course.some((e) => e.kind === 'teleport');
}

// ---------------------------------------------------------------------------
// 1: the first pad
// ---------------------------------------------------------------------------

function pad(world: World): void {
  console.log('\nthe first launch pad');
  const game = newGame(world, [PAD_X0 - 200, 0, START.top + 25]);
  settle(game);
  walkOntoPad(game);
  let apex = feet(game);
  let landed: Platform | undefined;
  for (let i = 0; i < 600; i++) {
    game.step({ forward: 127, yaw: 0 });
    apex = Math.max(apex, feet(game));
    if (i > 5 && game.onGround) {
      landed = ISLANDS.find((p) => restingOn(game, p));
      break;
    }
  }
  check(landed === ISLANDS[0], 'walking onto the pad from the start floor lands on the first island', `apex ${apex.toFixed(0)}, down at x ${x(game).toFixed(0)} on ${landed?.name ?? 'nothing'}`);
}

// ---------------------------------------------------------------------------
// 2: a miss on the islands is a restart
// ---------------------------------------------------------------------------

function restart(world: World): void {
  console.log('\nthe strafe rescue: back to the spawn, and the clock restarts');
  const game = newGame(world, SPAWN);
  settle(game);
  let started = false;
  for (let i = 0; i < 400 && !started; i++) {
    started = game.step({ forward: 127, yaw: 0 }).course.some((e) => e.kind === 'start');
  }
  // Fall into the first gap with the run going.
  game.ps.origin[0] = ISLANDS[0]!.x1 + 64;
  game.ps.origin[2] = -20;
  game.ps.velocity[0] = 0;
  game.ps.velocity[2] = -200;
  let rescued = false;
  for (let i = 0; i < 300 && !rescued; i++) {
    rescued = teleported(game.step(NONE));
  }
  const rescuedX = x(game);
  let restarted = false;
  let elapsed = -1;
  for (let i = 0; i < 400 && !restarted; i++) {
    const start = game.step({ forward: 127, yaw: 0 }).course.find((e) => e.kind === 'start');
    if (start) {
      restarted = true;
      elapsed = start.elapsed ?? -1;
    }
  }
  check(
    started && rescued && rescuedX < START_GATE_X0 && restarted && elapsed === 0,
    'a fall between the islands returns to the spawn, before the start gate, and running through the gate again restarts the timer',
    `rescued to x ${rescuedX.toFixed(0)}, restart ${restarted ? `fired with elapsed ${elapsed}` : 'never fired'}`,
  );
}

// ---------------------------------------------------------------------------
// 3: rescue teleporters are void catches (the rule from side-locked-courses.md)
// ---------------------------------------------------------------------------

function lineBrushes(world: World): Brush[] {
  const m = world.model;
  const owned = new Set<number>();
  for (let i = 1; i < m.submodels.length; i++) {
    const leaf = m.submodels[i]!.leaf;
    for (let j = 0; j < leaf.numLeafBrushes; j++) {
      owned.add(m.leafbrushes[leaf.firstLeafBrush + j]!);
    }
  }
  return m.brushes.filter(
    (b, i) => !owned.has(i) && (b.contents & (CONTENTS_SOLID | CONTENTS_PLAYERCLIP)) !== 0 && b.bounds[0][1] < 15 && b.bounds[1][1] > -15,
  );
}

const TP_STEP = 18;
const TP_MARGIN = 64;
const TP_REACH = 16;
/** The overbounce section's retry passage (x 5736..5800 under the ledge block), exempt from the rule. */
const RETRY_DOOR_TARGET = 'mcp_teleport_tp_ob';

function teleporters(world: World): void {
  console.log('\nteleporters: void catches only, below every standing surface in reach');
  const bs = lineBrushes(world);
  const m = world.model;
  for (const e of world.entities) {
    if (e.classname !== 'trigger_teleport' || e.submodel < 1) {
      continue;
    }
    if (e.target === RETRY_DOOR_TARGET) {
      // The overbounce section's return: a recess under the block at the
      // ledge's foot, walked into from the lower floor after a bounce that
      // did not happen. A visible way out of a softlock, not a catch.
      console.log(`  info  the retry passage under the ledge block (-> ${e.target}) is a visible return out of the overbounce section, exempt`);
      continue;
    }
    const leaf = m.submodels[e.submodel]!.leaf;
    let worst = Infinity;
    let worstAt = '';
    let floor = -Infinity;
    for (let j = 0; j < leaf.numLeafBrushes; j++) {
      const t = m.brushes[m.leafbrushes[leaf.firstLeafBrush + j]!]!;
      const x0 = t.bounds[0][0];
      const z0 = t.bounds[0][2];
      const x1 = t.bounds[1][0];
      const z1 = t.bounds[1][2];
      for (const b of bs) {
        if (b.bounds[0][0] > x1 + TP_REACH || b.bounds[1][0] < x0 - TP_REACH) {
          continue;
        }
        const top = b.bounds[1][2];
        if (bs.some((d) => d !== b && d.bounds[0][2] <= top && d.bounds[1][2] > top && d.bounds[0][0] <= b.bounds[0][0] + 0.5 && d.bounds[1][0] >= b.bounds[1][0] - 0.5)) {
          continue; // a body under its own top slab: not a standing surface
        }
        if (top <= z0) {
          floor = Math.max(floor, top);
          continue;
        }
        const margin = top - TP_STEP - z1;
        if (margin < worst) {
          worst = margin;
          worstAt = `slab x ${x0}..${x1} z ${z0}..${z1}: surface top ${top} over x ${Math.max(b.bounds[0][0], x0 - TP_REACH)}..${Math.min(b.bounds[1][0], x1 + TP_REACH)}`;
        }
      }
    }
    check(
      worst >= TP_MARGIN,
      `void catch -> ${e.target} (${leaf.numLeafBrushes} slab${leaf.numLeafBrushes === 1 ? '' : 's'}) is at least ${TP_MARGIN} below every standing surface in reach (step-up ${TP_STEP} counted)`,
      `lowest ${worstAt}, margin ${worst.toFixed(0)}; the floor it protects ${floor}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4: the lid has no invisible face
// ---------------------------------------------------------------------------

function lid(world: World): void {
  console.log('\nthe lid over the plasma and overbounce section');
  const m = world.model;
  const lidBrushes = m.brushes.filter(
    (b) => b.bounds[0][0] <= LID.x0 + 1 && b.bounds[1][0] >= LID.x1 - 1 && Math.abs(b.bounds[0][2] - LID.z0) < 1 && Math.abs(b.bounds[1][2] - LID.z1) < 1,
  );
  check(lidBrushes.length === 1, 'the lid is where the layout says', `${lidBrushes.length} brush(es) at x ${LID.x0}..${LID.x1} z ${LID.z0}..${LID.z1}`);
  // Caulk compiles to a side with SURF_NODRAW and no drawn surface; the
  // collision model keeps each side's surface flags.
  const caulk: string[] = [];
  for (const b of lidBrushes) {
    b.sides.forEach((side, i) => {
      if ((side.surfaceFlags & SURF_NODRAW) !== 0) {
        caulk.push(`side ${i} nodraw (normal ${Array.from(side.plane.normal).map((n) => n.toFixed(0)).join(',')})`);
      }
    });
  }
  check(caulk.length === 0, 'no face of the lid is caulk (the camera sees its top from a jump after the plasma climb)', caulk.length ? caulk.join(', ') : 'all six sides drawn');
  console.log(`  info  the lid is ${LID.z0 - 340} over the 340 floor and ${LID.z0 - 356} over the step: a walk, not a jump, is the way under it, and skipping the section is allowed`);
}

// ---------------------------------------------------------------------------
// 5: timers and the camera
// ---------------------------------------------------------------------------

function timers(world: World): void {
  console.log('\ntimer gates');
  const game = newGame(world, SPAWN);
  settle(game);
  let started = false;
  for (let i = 0; i < 400 && !started; i++) {
    started = game.step({ forward: 127, yaw: 0 }).course.some((e) => e.kind === 'start');
  }
  check(started, 'walking from the spawn fires the start timer');
  const end = newGame(world, [STOP_X - 200, 0, FINISH_TOP + 25]);
  settle(end);
  end.course?.startTimer(end.time);
  let finished = false;
  for (let i = 0; i < 400 && !finished; i++) {
    finished = end.step({ forward: 127, yaw: 0 }).course.some((e) => e.kind === 'finish');
  }
  check(finished, 'walking on the finish floor fires the stop timer');
}

export function run(world: World, camPath: string): void {
  pad(world);
  restart(world);
  teleporters(world);
  lid(world);
  timers(world);
  cameraScript(
    camPath,
    [
      [-200, 0, 24],
      [2000, 0, 24],
      [5300, 0, 364],
      [6400, 0, 328],
    ],
    0,
  );
}
