/**
 * ob_grounds: replay the course headlessly against the compiled BSP and report
 * whether the geometry does what `.agent/plans/OB-GROUNDS.md` says it does.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Round 4 (the user's ruling: no lids, no from-rest stone, no hidden
 * teleporters, exploits stay) changed what is ASSERTED:
 *
 *  - Structure: no solid brush in the player's y band sits closer than
 *    `CLEARANCE` above any walking surface; every `trigger_teleport` is a void
 *    catch below every standing surface in reach (`ob_circuit`'s rule).
 *  - Whole runs from the spawn, one `Game` each, start timer to stop timer:
 *    a jump line (the turned-view run and a strafed jump at every edge), a
 *    greedy bunny-hop chain and a moderate constant-yaw chain, each doing the HOB as the technique (walk up the step, walk off,
 *    jump N frames after landing). All must finish without a teleport.
 *  - The HOB technique itself: walk-offs from any approach speed land on the
 *    lower floor and bounce; the jump window after landing reaches P4.
 *  - The fog's camera rule: a failed fog jump is caught before the side
 *    camera's eye drops below the fog's top plane.
 *  - The timers fire and the .cam parses.
 *
 * Everything round 3 asserted as a FAILURE ("plain falls short and is
 * rescued", "from rest on the stone is rescued", "no overbounce is rescued")
 * is now information: the line is run and where it ends printed. Skips that
 * reach the finish are printed as EXPERT with their time.
 *
 * Input models are `tools/strafe-gaps.ts`'s ("greedy": the per-frame view yaw
 * of the largest snapped x gain, a very good player, not a proven optimum).
 */

import type { Brush } from '../../src/collision/brush.js';
import type { Game, GameInput } from '../../src/game/game.js';
import { CONTENTS_PLAYERCLIP, CONTENTS_SOLID } from '../../src/physics/constants.js';
import { greedyYaw } from '../strafe-gaps.js';
import type { World } from './harness.js';
import { NONE, cameraScript, check, feet, newGame, settle, x } from './harness.js';

/** A walkable top along y = 0: x range and height. */
export interface Platform {
  name: string;
  x0: number;
  x1: number;
  top: number;
}

/** The running line, in x order, and the pieces the controllers key on. */
export interface Layout {
  label: string;
  platforms: readonly Platform[];
  p2: Platform;
  p3: Platform;
  step: Platform;
  lower: Platform;
  p4: Platform;
  /** Round 3 only (the fog gap rose 32): where the jump line takes the fog hint's one hop on P2. */
  fogHopAt?: number;
  /**
   * Round 3 only: air frames strafed on the flight onto a platform shorter
   * than 64 (the stepping stone), after which the view goes straight.
   */
  stoneAirFrames?: number;
}

// ---------------------------------------------------------------------------
// Layout, from the plan's table. Change both together.
// ---------------------------------------------------------------------------

const START: Platform = { name: 'the start courtyard', x0: -1264, x1: 640, top: 0 };
const P1: Platform = { name: 'P1', x0: 960, x1: 1312, top: 0 };
const P2: Platform = { name: 'P2', x0: 1680, x1: 2448, top: 0 };
const P3: Platform = { name: 'P3', x0: 2800, x1: 3312, top: 0 };
/** The 8-unit step onto the ledge: walking up it resets the resting height. */
const STEP: Platform = { name: 'the step', x0: 3312, x1: 3440, top: 8 };
const HOB_DROP = 260;
const LOWER: Platform = { name: 'the lower floor', x0: 3616, x1: 3856, top: STEP.top - HOB_DROP };
const P4: Platform = { name: 'P4 (the finish)', x0: 4256, x1: 5520, top: -220 };

export const LAYOUT: Layout = {
  label: 'round 4',
  platforms: [START, P1, P2, P3, STEP, LOWER, P4],
  p2: P2,
  p3: P3,
  step: STEP,
  lower: LOWER,
  p4: P4,
};

const R3_P2: Platform = { ...P2, x0: 1400 };
const R3_P3: Platform = { ...P3, top: 32 };
const R3_STEP: Platform = { ...STEP, top: 40 };
const R3_LOWER: Platform = { ...LOWER, top: -220 };
const R3_P4: Platform = { ...P4, top: -188 };

/** Round 3's line, for the before/after run times (the committed round-3 BSP). */
export const LAYOUT_R3: Layout = {
  label: 'round 3',
  platforms: [START, { name: 'the stone', x0: 960, x1: 992, top: 0 }, R3_P2, R3_P3, R3_STEP, R3_LOWER, R3_P4],
  p2: R3_P2,
  p3: R3_P3,
  step: R3_STEP,
  lower: R3_LOWER,
  p4: R3_P4,
  fogHopAt: P2.x1 - 480,
  stoneAirFrames: 44,
};

const SPAWN: [number, number, number] = [-1024, 0, 24];
/** The fog garden's volume top: 16 under P2 and P3 (both top 0 since round 4). */
const FOG_TOP = -16;
/** The side camera's height in the fog zone of scripts/ob_grounds.cam. */
const FOG_CAM_HEIGHT = 150;
const START_GATE_X = -752;
const STOP_GATE_X = 4528;
/**
 * The least clear height over any walking surface on the line. A standing
 * jump's box top reaches 48.6 + 56 = 104.6 above the feet; 128 leaves every
 * jump and chain under it untouched.
 */
const CLEARANCE = 128;

const MS = 8;
const fmtS = (frames: number): string => `${((frames * MS) / 1000).toFixed(2)}s`;

// ---------------------------------------------------------------------------

function on(p: Platform, atX: number): [number, number, number] {
  return [atX, 0, p.top + 26];
}

function restingOn(game: Game, p: Platform): boolean {
  return x(game) >= p.x0 - 15 && x(game) <= p.x1 + 15 && Math.abs(feet(game) - (p.top + 0.125)) < 0.5;
}

function where(game: Game, L: Layout = LAYOUT): string {
  const p = L.platforms.find((q) => restingOn(game, q));
  return p ? `${p.name} at x ${x(game).toFixed(0)}` : `x=${x(game).toFixed(0)} feet=${feet(game).toFixed(2)}`;
}

const runGreedy = (g: Game): GameInput => ({ forward: 127, yaw: greedyYaw(g.ps.velocity[0], g.onGround) });
const airGreedy = (g: Game): GameInput => ({ forward: 127, yaw: greedyYaw(g.ps.velocity[0], false) });

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/** World brushes (not owned by any brush entity), solid to the player, crossing the player's y band. */
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

/**
 * Round 4's ruling: nothing over the running line stops a jump. For every
 * exposed brush top along y = 0 (not buried under a brush resting on it), no
 * brush may hang above it, over the same x (widened by the box's 15), closer
 * than CLEARANCE. Every lintel is axial, so bounds are exact.
 */
function ceilings(world: World): void {
  console.log(`\nclearance: nothing within ${CLEARANCE} above any walking surface along y 0`);
  const bs = lineBrushes(world);
  let worst = Infinity;
  let worstAt = '';
  let surfaces = 0;
  for (const s of bs) {
    const top = s.bounds[1][2];
    const [sx0, sx1] = [s.bounds[0][0], s.bounds[1][0]];
    for (const c of bs) {
      if (c === s || c.bounds[0][2] <= top || c.bounds[0][0] >= sx1 + 15 || c.bounds[1][0] <= sx0 - 15) {
        continue;
      }
      // Is the part of s's top under c actually exposed? Buried if a brush
      // rests on it across that whole overlap.
      const ox0 = Math.max(sx0, c.bounds[0][0] - 15);
      const ox1 = Math.min(sx1, c.bounds[1][0] + 15);
      const buried = bs.some((d) => d !== s && d.bounds[0][2] <= top && d.bounds[1][2] > top && d.bounds[0][0] <= ox0 && d.bounds[1][0] >= ox1);
      if (buried) {
        continue;
      }
      surfaces++;
      const gap = c.bounds[0][2] - top;
      if (gap < worst) {
        worst = gap;
        worstAt = `surface top ${top} over x ${ox0.toFixed(0)}..${ox1.toFixed(0)}, brush above at z ${c.bounds[0][2]}..${c.bounds[1][2]} x ${c.bounds[0][0]}..${c.bounds[1][0]}`;
      }
    }
  }
  check(worst >= CLEARANCE, `no brush hangs within ${CLEARANCE} of a walking surface on the line`, `${surfaces} surface/overhang pairs; lowest clearance ${worst} (${worstAt})`);
}

/**
 * Every `trigger_teleport` must sit below every surface a player could still
 * stand on over its x range (widened by 16), counting the 18-unit step-up, by
 * 64 -- `tools/course-checks/ob_circuit.ts`'s `teleporterPlanes`, with one
 * addition its comment already describes: a surface whose top is below the
 * trigger's BOTTOM is the floor the catch protects (you cannot reach it
 * without passing through the trigger) and does not count.
 */
const TP_STEP = 18;
const TP_MARGIN = 64;
const TP_REACH = 16;

function teleporters(world: World): void {
  console.log('\nteleporters: void catches only, below every standing surface in reach');
  const bs = lineBrushes(world);
  const m = world.model;
  let count = 0;
  for (const e of world.entities) {
    if (e.classname !== 'trigger_teleport' || e.submodel < 1) {
      continue;
    }
    count++;
    const leaf = m.submodels[e.submodel]!.leaf;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let j = 0; j < leaf.numLeafBrushes; j++) {
      const b = m.brushes[m.leafbrushes[leaf.firstLeafBrush + j]!]!;
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, b.bounds[0][k]!);
        hi[k] = Math.max(hi[k]!, b.bounds[1][k]!);
      }
    }
    const [x0, , z0] = lo as [number, number, number];
    const [x1, , z1] = hi as [number, number, number];
    let worst = Infinity;
    let worstAt = '';
    let floor = -Infinity;
    for (const b of bs) {
      if (b.bounds[0][0] > x1 + TP_REACH || b.bounds[1][0] < x0 - TP_REACH) {
        continue;
      }
      const top = b.bounds[1][2];
      if (bs.some((d) => d !== b && d.bounds[0][2] <= top && d.bounds[1][2] > top && d.bounds[0][0] <= b.bounds[0][0] && d.bounds[1][0] >= b.bounds[1][0])) {
        continue; // a body under its own top slab, or a floor under a platform: not a standing surface
      }
      if (top < z0) {
        floor = Math.max(floor, top);
        continue;
      }
      const margin = top - TP_STEP - z1;
      if (margin < worst) {
        worst = margin;
        worstAt = `surface top ${top} over x ${Math.max(b.bounds[0][0], x0 - TP_REACH)}..${Math.min(b.bounds[1][0], x1 + TP_REACH)}`;
      }
    }
    check(
      worst >= TP_MARGIN,
      `void catch -> ${e.target} is at least ${TP_MARGIN} below every standing surface in reach (step-up ${TP_STEP} counted)`,
      `x ${x0}..${x1} z ${z0}..${z1}; lowest ${worstAt}, margin ${worst.toFixed(0)}; the floor it protects ${floor}`,
    );
  }
  console.log(`  info  ${count} trigger_teleport entities`);
}

// ---------------------------------------------------------------------------
// Whole runs
// ---------------------------------------------------------------------------

interface Line {
  name: string;
  /** 'jump': run to each edge and jump there; 'chain': also hop whenever the hop lands safely. */
  style: 'jump' | 'chain';
  /** Air view: the greedy strafe, or a constant yaw held with forward. */
  air: 'greedy' | number;
  /**
   * The HOB: 'walk' is the technique; 'glide' hops off P3 or the step straight
   * for P4; 'skip' also takes a hop that lands on the lower floor without the
   * bounce and jumps again at once (both skips).
   */
  hob: 'walk' | 'glide' | 'skip';
  /** Frames after the lower-floor landing to press jump (0 = the landing frame's own PM_CheckJump). */
  n: number;
}

export interface RouteResult {
  finished: boolean;
  /** Start timer to stop timer, in frames. */
  frames: number;
  why: string;
  /** Where the walk-off landed and the horizontal speed on the frame after (0 if never). */
  landX: number;
  launch: number;
}

function gapAfter(L: Layout, p: Platform): Platform | null {
  const i = L.platforms.indexOf(p);
  const next = L.platforms[i + 1];
  return next && next.x0 > p.x1 + 1 ? next : null;
}

function platformUnder(L: Layout, g: Game): Platform | null {
  if (!g.onGround) {
    return null;
  }
  const f = feet(g);
  return L.platforms.find((p) => x(g) >= p.x0 - 15 && x(g) <= p.x1 + 15 && Math.abs(f - p.top) < 2) ?? null;
}

/**
 * Where a jump pressed now comes down, as a range: no air gain at the near
 * end, a generous ~320 ups/s of air gain at the far end. A controller hops
 * only when the whole range is safely on the platform it is on, or on the
 * next one; otherwise it runs on and jumps at the edge.
 */
function hopRange(px: number, vx: number, dh: number): [number, number] {
  const disc = 270 * 270 - 1500 * dh;
  if (disc < 0) {
    return [NaN, NaN];
  }
  const t = (270 + Math.sqrt(disc)) / 750;
  return [px + vx * t, px + vx * t + 160 * t * t];
}

export function route(world: World, L: Layout, line: Line, limit = 9000): RouteResult {
  const g = newGame(world, SPAWN);
  settle(g);
  let phase: 'course' | 'fall' | 'landed' | 'flight' = 'course';
  let startFrame = -1;
  let landFrame = -1;
  let landX = 0;
  let launch = 0;
  let lastPlat: Platform | null = null;
  let hoppedForFog = false;
  let airFrames = 0;
  let towardStone = false;
  const air = (): GameInput => (line.air === 'greedy' ? airGreedy(g) : { forward: 127, yaw: line.air });
  const jump = (): GameInput => ({ ...runGreedy(g), up: 127 });
  for (let i = 0; i < limit; i++) {
    const vx = g.ps.velocity[0];
    const px = x(g);
    const plat = platformUnder(L, g);
    let input: GameInput;
    if (phase === 'fall') {
      input = NONE;
    } else if (phase === 'landed') {
      if (i - landFrame - 1 >= line.n) {
        input = { forward: 127, up: 127, yaw: 0 };
        phase = 'flight';
      } else {
        input = runGreedy(g);
      }
    } else if (!g.onGround) {
      if (phase === 'flight') {
        input = air();
      } else if (towardStone && L.stoneAirFrames !== undefined) {
        input = airFrames++ < L.stoneAirFrames ? air() : { forward: 127, yaw: 0 };
      } else {
        input = air();
      }
      if (line.hob === 'walk' && phase === 'course' && lastPlat === L.step && px > L.step.x1 - 20 && feet(g) < L.step.top - 4) {
        phase = 'fall';
        input = NONE;
      }
    } else if (!plat) {
      input = runGreedy(g);
    } else {
      if (phase === 'flight') {
        phase = 'course';
      }
      lastPlat = plat;
      const next = gapAfter(L, plat);
      const isStone = plat.x1 - plat.x0 < 64;
      const hobWalk = line.hob === 'walk' && (plat === L.p3 || plat === L.step);
      const edge = plat === L.step ? (line.hob !== 'walk' ? L.step.x1 : null) : next ? plat.x1 : null;
      const atEdge = edge !== null && px + vx * 0.008 >= edge + 15 - 0.5;
      let hop = false;
      if (line.style === 'chain' && !isStone) {
        const [a, b] = hopRange(px, vx, 0);
        if (hobWalk) {
          hop = plat === L.p3 && b <= L.step.x0 - 32;
        } else if (line.hob !== 'walk' && (plat === L.p3 || plat === L.step)) {
          const [c, d] = hopRange(px, vx, L.p4.top - plat.top);
          const [e, f] = hopRange(px, vx, L.lower.top - plat.top);
          hop = b <= L.step.x1 - 16 || (c >= L.p4.x0 + 8 && d <= L.p4.x1 - 16) || (line.hob === 'skip' && e >= L.lower.x0 + 8 && f <= L.lower.x1 - 16);
        } else if (line.hob === 'skip' && plat === L.lower) {
          hop = true;
        } else if (b <= plat.x1 - 16) {
          hop = true;
        } else if (next) {
          const [c, d] = hopRange(px, vx, next.top - plat.top);
          hop = c >= next.x0 + 8 && d <= next.x1 - 16;
        }
        void a;
      }
      if (line.style === 'jump' && plat === L.p2 && !hoppedForFog && L.fogHopAt !== undefined && px >= L.fogHopAt) {
        hoppedForFog = true;
        hop = true;
      }
      if (isStone || atEdge || hop) {
        towardStone = !!next && next.x1 - next.x0 < 64 && atEdge;
        airFrames = 0;
        input = jump();
      } else {
        input = runGreedy(g);
      }
    }
    const frame = g.step(input);
    if (phase === 'fall' && g.onGround) {
      phase = 'landed';
      landFrame = i;
      landX = x(g);
    }
    if (landFrame >= 0 && i === landFrame + 1) {
      launch = Math.abs(g.ps.velocity[0]);
    }
    for (const e of frame.course) {
      if (e.kind === 'start' && startFrame < 0) {
        startFrame = i;
      }
      if (e.kind === 'finish') {
        return { finished: true, frames: i - startFrame, why: 'finished', landX, launch };
      }
      if (e.kind === 'teleport') {
        return { finished: false, frames: i - startFrame, why: `teleported from x ${px.toFixed(0)} feet ${feet(g).toFixed(0)} after ${fmtS(i - startFrame)}`, landX, launch };
      }
    }
  }
  return { finished: false, frames: limit, why: `timed out at ${where(g, L)}`, landX, launch };
}

export const LINES: readonly Line[] = [
  { name: 'jump line: turned-view run, strafed jump at every edge, HOB N=3', style: 'jump', air: 'greedy', hob: 'walk', n: 3 },
  { name: 'greedy bunny-hop chain, HOB N=3', style: 'chain', air: 'greedy', hob: 'walk', n: 3 },
  { name: 'moderate chain: air view held at 50, HOB N=3', style: 'chain', air: 50, hob: 'walk', n: 3 },
];

/** Run the lines on a layout; returns [line name, result]. Exported for a before/after run on another BSP. */
export function routeTimes(world: World, L: Layout, lines: readonly Line[] = LINES): [string, RouteResult][] {
  return lines.map((l) => [l.name, route(world, L, l)]);
}

function routes(world: World): void {
  console.log('\nwhole runs from the spawn, one Game each (start timer to stop timer, no teleport allowed)');
  for (const [name, r] of routeTimes(world, LAYOUT)) {
    check(r.finished, name, r.finished ? `${fmtS(r.frames)}; walk-off landed x ${r.landX.toFixed(0)}, launch ${r.launch}` : r.why);
  }
  const variants: Line[] = [
    { name: 'moderate chain, air view held at 45', style: 'chain', air: 45, hob: 'walk', n: 3 },
    { name: 'moderate chain, air view held at 60', style: 'chain', air: 60, hob: 'walk', n: 3 },
    { name: 'jump line, air view held at 54', style: 'jump', air: 54, hob: 'walk', n: 3 },
    { name: 'jump line, HOB N=2', style: 'jump', air: 'greedy', hob: 'walk', n: 2 },
    { name: 'jump line, HOB N=6', style: 'jump', air: 'greedy', hob: 'walk', n: 6 },
  ];
  for (const [name, r] of routeTimes(world, LAYOUT, variants)) {
    console.log(`  info  ${name}: ${r.finished ? `finishes in ${fmtS(r.frames)}` : r.why}`);
  }
  const glide: Line[] = [
    { name: 'greedy chain, no walk-off: jump off the ledge edge straight for P4', style: 'chain', air: 'greedy', hob: 'glide', n: 3 },
    { name: 'jump line, no walk-off: strafe jump off the ledge edge', style: 'jump', air: 'greedy', hob: 'glide', n: 3 },
    { name: 'greedy chain, no bounce: hop from P3 onto the lower floor and straight off it', style: 'chain', air: 'greedy', hob: 'skip', n: 3 },
  ];
  for (const [name, r] of routeTimes(world, LAYOUT, glide)) {
    console.log(`  ${r.finished ? 'EXPERT' : 'info  '}  ${name}: ${r.finished ? `finishes in ${fmtS(r.frames)} (skips the HOB)` : r.why}`);
  }
}

// ---------------------------------------------------------------------------
// Single obstacles: the round-3 lines, now information
// ---------------------------------------------------------------------------

interface Run {
  endedOn: string;
  teleported: boolean;
  takeoff: number;
  minEye: number;
  downX: number | null;
  game: Game;
}

/** From `origin`, run to `edge` and jump there, then fly (`air`); `hopAt` hops once earlier and jumps again at the edge. */
export function jumpRun(
  world: World,
  origin: [number, number, number],
  edge: number,
  opts: { ground: 'plain' | 'greedy'; air: 'none' | 'greedy'; hopAt?: number; downAt?: number; early?: number },
  camHeight = 0,
): Run {
  const game = newGame(world, origin);
  settle(game);
  let hopped = opts.hopAt === undefined;
  let jumped = false;
  let takeoff = 0;
  let minEye = Infinity;
  let downX: number | null = null;
  let prevFeet = feet(game);
  let wasGround = true;
  for (let i = 0; i < 3000; i++) {
    const vx = game.ps.velocity[0];
    let input: GameInput;
    const yaw = opts.ground === 'plain' ? 0 : greedyYaw(vx, game.onGround);
    if (!jumped && game.onGround) {
      const hopNow = !hopped && x(game) >= opts.hopAt!;
      const edgeNow = x(game) + vx * 0.008 * (1 + (opts.early ?? 0)) >= edge + 15 - 0.5;
      if (hopNow) {
        hopped = true;
      }
      if (edgeNow) {
        jumped = true;
      }
      input = { forward: 127, yaw, ...(hopNow || edgeNow ? { up: 127 } : {}) };
    } else if (!game.onGround) {
      input = opts.air === 'greedy' ? airGreedy(game) : { forward: 127, yaw: 0 };
    } else {
      input = NONE;
    }
    const frame = game.step(input);
    if (opts.downAt !== undefined && prevFeet > opts.downAt && feet(game) <= opts.downAt && game.ps.velocity[2] <= 0) {
      downX = x(game);
    }
    prevFeet = feet(game);
    if (jumped && !game.onGround) {
      if (wasGround) {
        takeoff = Math.abs(game.ps.velocity[0]);
      }
      minEye = Math.min(minEye, feet(game) + 24 + camHeight);
    }
    if (frame.course.some((e) => e.kind === 'teleport')) {
      settle(game);
      return { endedOn: `the void, back to ${where(game)}`, teleported: true, takeoff, minEye, downX, game };
    }
    if (jumped && game.onGround && !wasGround) {
      settle(game);
      return { endedOn: where(game), teleported: false, takeoff, minEye, downX, game };
    }
    wasGround = game.onGround;
  }
  return { endedOn: where(game), teleported: false, takeoff, minEye, downX, game };
}

function info(label: string, r: Run, target: Platform): void {
  console.log(`  info  ${label}: takeoff ${r.takeoff}, came down through ${target.name}'s height at x ${r.downX?.toFixed(0) ?? '-'} (edge ${target.x0}), ended on ${r.endedOn}`);
}

function gaps(world: World): void {
  console.log('\ngaps A, B and the fog gap C (all level since round 4): what the round-3 failure lines do now');
  const fromA = on(START, 144);
  info('gap A (320), plain jump from a standing start at x 144', jumpRun(world, fromA, START.x1, { ground: 'plain', air: 'none', downAt: P1.top }), P1);
  info('gap A, run40 (turned view, no air strafing)', jumpRun(world, fromA, START.x1, { ground: 'greedy', air: 'none', downAt: P1.top }), P1);
  info('gap A, one strafed jump', jumpRun(world, fromA, START.x1, { ground: 'greedy', air: 'greedy', downAt: P1.top }), P1);
  const fromP1 = on(P1, P1.x0 + 16);
  info('gap B (368), run40 from rest on P1', jumpRun(world, fromP1, P1.x1, { ground: 'greedy', air: 'none', downAt: P2.top }), P2);
  const b = jumpRun(world, fromP1, P1.x1, { ground: 'greedy', air: 'greedy', downAt: P2.top });
  info('gap B, one strafed jump from rest on P1 (round 3: the stone, rescued)', b, P2);
  check(!b.teleported && b.endedOn.startsWith(P2.name), 'gap B: a slow player (from rest on P1) crosses with one strafed jump', b.endedOn);
  // How much a slow player has: the strafed edge jump pressed k frames early,
  // from rest on P1 (no speed carried from gap A: the worst case, a player who
  // stopped there) and from rest on P2 for the fog gap.
  const early = (from: [number, number, number], edge: number, target: Platform): string => {
    const ok: number[] = [];
    for (let k = 0; k <= 12; k++) {
      const r = jumpRun(world, from, edge, { ground: 'greedy', air: 'greedy', downAt: target.top, early: k });
      if (!r.teleported && r.endedOn.startsWith(target.name)) {
        ok.push(k);
      }
    }
    return ok.length ? `k = ${ok.join(',')}` : 'none';
  };
  console.log(`  info  gap B from rest on P1, strafed edge jump pressed k frames early, landing: ${early(fromP1, P1.x1, P2)}`);

  const fromP2 = on(P2, P2.x0 + 32);
  for (const ground of ['plain', 'greedy'] as const) {
    const r = jumpRun(world, fromP2, P2.x1, { ground, air: 'none', downAt: P3.top }, FOG_CAM_HEIGHT);
    info(`fog gap C (352, level), ${ground === 'plain' ? 'plain' : 'run40'} jump`, r, P3);
    if (r.teleported) {
      check(r.minEye > FOG_TOP, `fog ${ground === 'plain' ? 'plain' : 'run40'}: the camera eye stays above the fog top until the rescue`, `lowest eye z ${r.minEye.toFixed(1)}, fog top ${FOG_TOP}`);
    }
  }
  const single = jumpRun(world, fromP2, P2.x1, { ground: 'greedy', air: 'greedy', downAt: P3.top }, FOG_CAM_HEIGHT);
  info('fog gap C, one strafed jump, no hop', single, P3);
  if (single.teleported) {
    check(single.minEye > FOG_TOP, 'fog, one strafed jump: the camera eye stays above the fog top until the rescue', `lowest eye z ${single.minEye.toFixed(1)}`);
  }
  check(!single.teleported && single.endedOn.startsWith(P3.name), 'fog gap C: a slow player (from rest on P2) crosses with one strafed jump', `takeoff ${single.takeoff}, ${single.endedOn}`);
  console.log(`  info  fog gap C from rest on P2, strafed edge jump pressed k frames early, landing: ${early(fromP2, P2.x1, P3)}`);
}

// ---------------------------------------------------------------------------
// The HOB
// ---------------------------------------------------------------------------

interface HobRun {
  landX: number;
  launch: number;
  endedOn: string;
  teleported: boolean;
  frames: number;
}

/**
 * From P3 (standing at x 2864, or forced to `speed` there), up the step and
 * off the ledge. `walk` is how; after landing on the lower floor, jump `n`
 * frames after the landing frame (n = 0 presses on the landing frame itself)
 * and fly with `air`. `n = null` never jumps (just reports the bounce).
 */
function hobRun(
  world: World,
  walk: 'yaw0' | 'yaw40' | 'creep' | 'hop',
  n: number | null,
  air: 'none' | 'greedy',
  fall: 'none' | 'yaw0' | 'yaw40' | 'greedy' = 'none',
  speed = 0,
): HobRun {
  const game = newGame(world, on(P3, P3.x0 + 64));
  settle(game);
  if (speed) {
    game.ps.velocity[0] = speed;
  }
  let left = false;
  let landFrame = -1;
  let launch = 0;
  let landX = 0;
  let jumped = false;
  let wasGround = true;
  for (let i = 0; i < 4000; i++) {
    const vx = game.ps.velocity[0];
    let input: GameInput;
    if (!left) {
      if (walk === 'yaw0') {
        input = { forward: 127, yaw: 0 };
      } else if (walk === 'yaw40') {
        input = runGreedy(game);
      } else if (walk === 'hop') {
        input = { ...runGreedy(game), ...(game.onGround ? { up: 127 } : {}) };
      } else {
        input = x(game) < STEP.x1 - 200 || vx < 20 ? { forward: 127, yaw: 0 } : NONE;
      }
    } else if (landFrame < 0) {
      input = fall === 'none' ? NONE : { forward: 127, yaw: fall === 'yaw0' ? 0 : fall === 'yaw40' ? 40 : greedyYaw(vx, false) };
    } else if (!jumped && n !== null && i - landFrame - 1 >= n) {
      input = { forward: 127, up: 127, yaw: 0 };
      jumped = true;
    } else if (!jumped) {
      input = runGreedy(game);
    } else {
      input = game.onGround ? NONE : air === 'greedy' ? airGreedy(game) : { forward: 127, yaw: 0 };
    }
    const frame = game.step(input);
    if (!left && !game.onGround && x(game) > STEP.x1 - 20 && feet(game) < STEP.top - 4) {
      left = true;
    }
    if (left && landFrame < 0 && game.onGround) {
      landFrame = i;
      landX = x(game);
    }
    if (landFrame >= 0 && i === landFrame + 1) {
      launch = Math.abs(game.ps.velocity[0]);
    }
    if (frame.course.some((e) => e.kind === 'teleport')) {
      settle(game);
      return { landX, launch, endedOn: `the void, back to ${where(game)}`, teleported: true, frames: i };
    }
    if (n === null && landFrame >= 0 && i > landFrame + 2) {
      return { landX, launch, endedOn: 'not jumped', teleported: false, frames: i };
    }
    if (jumped && game.onGround && !wasGround) {
      settle(game);
      return { landX, launch, endedOn: where(game), teleported: false, frames: i };
    }
    wasGround = game.onGround;
  }
  return { landX, launch, endedOn: where(game), teleported: false, frames: 4000 };
}

/** On `p`'s top (grounded, feet within 2 of it, over its x range). */
function restingOnTop(g: Game, p: Platform): boolean {
  return x(g) >= p.x0 - 15 && x(g) <= p.x1 + 15 && Math.abs(feet(g) - p.top) < 2;
}

const onLower = (r: HobRun): boolean => r.landX > LOWER.x0 - 15 && r.landX < LOWER.x1 + 15 && r.launch > 440;

function hob(world: World): void {
  console.log(`\nthe HOB: walk up the step, walk off the ${HOB_DROP} ledge, jump the instant you land (no ceiling since round 4)`);
  for (const walk of ['yaw0', 'yaw40'] as const) {
    const r = hobRun(world, walk, null, 'none');
    check(onLower(r), `walk-off (${walk}) lands on the lower floor and overbounces`, `landed x=${r.landX.toFixed(0)}, speed on the next frame ${r.launch}`);
  }
  const creep = hobRun(world, 'creep', null, 'none');
  console.log(`  info  creep-off: ${onLower(creep) ? `lands x ${creep.landX.toFixed(0)} at ${creep.launch}` : `ends ${creep.endedOn} (landed x ${creep.landX.toFixed(0)})`}`);
  const hop = hobRun(world, 'hop', null, 'none');
  console.log(`  info  hopping all the way in and off (no ceiling stops it now): landed x ${hop.landX.toFixed(0)}, speed on the next frame ${hop.launch} -- ${onLower(hop) ? 'still bounces' : hop.teleported ? 'misses the floor' : 'no bounce (the skill error)'}`);

  // Carried speed: forced on P3 at x 2864, then the turned-view run up the step
  // and off. The grounded run along P3 and the step is what bleeds it back.
  const rows: string[] = [];
  const bad: number[] = [];
  for (const v of [320, 400, 500, 600, 700, 800, 1000, 1200]) {
    const r = hobRun(world, 'yaw40', null, 'none', 'none', v);
    rows.push(`${v}: x ${r.landX.toFixed(0)} at ${r.launch}`);
    if (!onLower(r)) {
      bad.push(v);
    }
  }
  check(bad.length === 0, 'arriving at P3 at 320..1200 and running the step, the walk-off still lands on the lower floor and bounces', `${rows.join(', ')}${bad.length ? `; misses at ${bad.join(',')}` : ''}`);

  const unhandled: string[] = [];
  for (const walk of ['yaw0', 'yaw40'] as const) {
    const row: string[] = [];
    for (const fall of ['none', 'yaw0', 'yaw40', 'greedy'] as const) {
      const r = hobRun(world, walk, null, 'none', fall);
      row.push(`${fall}:${onLower(r) ? `lands x=${r.landX.toFixed(0)} at ${r.launch}` : r.endedOn}`);
      if (!onLower(r) && !r.teleported) {
        unhandled.push(`${walk}/${fall}`);
      }
    }
    console.log(`  info  walk ${walk}, fall holding  ${row.join('  ')}`);
  }
  check(unhandled.length === 0, 'whatever is held through the fall, the walk-off lands on the lower floor or falls into the void', unhandled.length ? `unhandled: ${unhandled.join(', ')}` : 'all 8 handled');

  const windows: Record<string, number[]> = {};
  for (const [walk, air] of [
    ['yaw40', 'greedy'],
    ['yaw40', 'none'],
    ['yaw0', 'greedy'],
  ] as const) {
    const row: string[] = [];
    const window: number[] = [];
    for (let n = 0; n <= 16; n++) {
      const r = hobRun(world, walk, n, air);
      if (r.endedOn.startsWith(P4.name)) {
        window.push(n);
      }
      row.push(`${n}:${r.endedOn.startsWith(P4.name) ? 'P4' : r.teleported ? 'void' : 'short'}`);
    }
    windows[`${walk}/${air}`] = window;
    console.log(`  info  walk ${walk}, air ${air}: ${row.join(' ')}`);
  }
  const w = windows['yaw40/greedy']!;
  check(w.length >= 4 && !w.includes(0), 'turned-view walk-off, HOB, jump after landing, strafe: reaches P4 for several frames, never on the landing frame', `window N=${w.join(',')}`);
  console.log(`  info  without air strafing: N=${windows['yaw40/none']!.join(',') || 'none'}; from a yaw-0 walk-off: N=${windows['yaw0/greedy']!.join(',') || 'none'}`);

  // Is the HOB necessary? Everything without the bounce, at forced speeds.
  const noOb: string[] = [];
  for (const v of [0, 400, 550, 700, 850]) {
    const g = newGame(world, on(LOWER, LOWER.x0 + 16));
    settle(g);
    g.ps.velocity[0] = v;
    const r = jumpRunFrom(g, LOWER.x1);
    noOb.push(`${v}: ${r}`);
  }
  console.log(`  info  no bounce, standing on the lower floor at a forced speed, run + strafe jump at its edge: ${noOb.join('; ')}`);
  const glide: string[] = [];
  let slowest = Infinity;
  for (const v of [400, 500, 600, 650, 700, 750, 800, 900, 1000]) {
    const g = newGame(world, on(STEP, STEP.x0 + 8));
    settle(g);
    g.ps.velocity[0] = v;
    const r = jumpRunFrom(g, STEP.x1);
    glide.push(`${v}: ${r}`);
    if (r.startsWith(P4.name)) {
      slowest = Math.min(slowest, v);
    }
  }
  console.log(`  info  no walk-off, standing on the step at a forced speed, run + strafe jump off the ledge edge (the step's friction bleeds it): ${glide.join('; ')}`);
  // A hopper never touches the step long enough for friction: the last jump
  // off P3 or the step at a carried speed, taken at x, straight for P4.
  const reach: string[] = [];
  let slowestHop = Infinity;
  for (const v of [500, 600, 700, 800, 900, 1000, 1200]) {
    const lands: number[] = [];
    for (let tx = P3.x1 - 256; tx <= STEP.x1; tx += 16) {
      const plat = tx < STEP.x0 ? P3 : STEP;
      const g = newGame(world, on(plat, tx));
      settle(g);
      g.ps.velocity[0] = v;
      g.step({ ...runGreedy(g), up: 127 });
      let end = '';
      for (let i = 0; i < 1500 && !end; i++) {
        const f = g.step(g.onGround ? NONE : airGreedy(g));
        if (f.course.some((e) => e.kind === 'teleport')) {
          end = 'void';
        } else if (g.onGround && i > 5) {
          settle(g);
          end = where(g);
        }
      }
      if (end.startsWith(P4.name)) {
        lands.push(tx);
      }
    }
    reach.push(`${v}: ${lands.length ? `P4 from take-offs x ${lands[0]}..${lands[lands.length - 1]}` : 'never'}`);
    if (lands.length) {
      slowestHop = Math.min(slowestHop, v);
    }
  }
  console.log(`  ${Number.isFinite(slowestHop) ? 'EXPERT' : 'info  '}  no walk-off: a hop off P3 or the step at a carried speed, greedy strafe, straight for P4 (take-offs every 16 from x ${P3.x1 - 256}): ${reach.join('; ')}`);
  // The other skip: a hop off P3 or the step that lands on the lower floor
  // WITHOUT the bounce (the drop plus the jump's apex is not an overbounce
  // height), carrying its speed, then jumps again at once and strafes.
  const viaLower: string[] = [];
  let slowestLower = Infinity;
  for (const v of [450, 500, 550, 600, 650, 700]) {
    const lands: number[] = [];
    for (let tx = P3.x1 - 256; tx <= STEP.x1; tx += 16) {
      const plat = tx < STEP.x0 ? P3 : STEP;
      const g = newGame(world, on(plat, tx));
      settle(g);
      g.ps.velocity[0] = v;
      g.step({ ...runGreedy(g), up: 127 });
      let end = '';
      let onLowerFloor = false;
      for (let i = 0; i < 1500 && !end; i++) {
        const lowerNow = g.onGround && i > 5 && restingOnTop(g, LOWER);
        if (lowerNow && !onLowerFloor) {
          onLowerFloor = true;
        }
        const input: GameInput = g.onGround ? (onLowerFloor && restingOnTop(g, LOWER) ? { ...runGreedy(g), up: 127 } : NONE) : airGreedy(g);
        const f = g.step(input);
        if (f.course.some((e) => e.kind === 'teleport')) {
          end = 'void';
        } else if (g.onGround && i > 5 && !restingOnTop(g, LOWER) && !restingOnTop(g, P3) && !restingOnTop(g, STEP)) {
          settle(g);
          end = where(g);
        }
      }
      if (onLowerFloor && end.startsWith(P4.name)) {
        lands.push(tx);
      }
    }
    viaLower.push(`${v}: ${lands.length ? `P4 from take-offs x ${lands[0]}..${lands[lands.length - 1]}` : 'never'}`);
    if (lands.length) {
      slowestLower = Math.min(slowestLower, v);
    }
  }
  console.log(`  ${Number.isFinite(slowestLower) ? 'EXPERT' : 'info  '}  no bounce: a hop off P3 or the step that lands on the lower floor, jump again at once, strafe: ${viaLower.join('; ')}`);
  console.log(
    `  info  so the HOB is skippable without the bounce from about ${Math.min(slowestHop, slowestLower)} ups at a well-placed hop off P3 (via the lower floor from ${Number.isFinite(slowestLower) ? slowestLower : '-'}, straight for P4 from ${Number.isFinite(slowestHop) ? slowestHop : '-'}); a player who walks the step always needs it`,
  );
  void slowest;
}

/** From the current state, run (turned view) to `edge`, jump there, strafe; where it ends. */
function jumpRunFrom(g: Game, edge: number): string {
  let jumped = false;
  for (let i = 0; i < 1500; i++) {
    const vx = g.ps.velocity[0];
    let input: GameInput;
    if (!jumped && g.onGround) {
      const now = x(g) + vx * 0.008 >= edge + 15 - 0.5;
      jumped = now;
      input = { ...runGreedy(g), ...(now ? { up: 127 } : {}) };
    } else {
      input = g.onGround ? NONE : airGreedy(g);
    }
    const f = g.step(input);
    if (f.course.some((e) => e.kind === 'teleport')) {
      return 'the void';
    }
    if (jumped && g.onGround && i > 5) {
      settle(g);
      return where(g);
    }
  }
  return where(g);
}

function timers(world: World): void {
  console.log('\ntimer gates');
  const game = newGame(world, on(START, START_GATE_X - 200));
  settle(game);
  let started = false;
  for (let i = 0; i < 400 && !started; i++) {
    started = game.step({ forward: 127, yaw: 0 }).course.some((e) => e.kind === 'start');
  }
  check(started, 'walking from the spawn fires the start timer');
  game.ps.origin[0] = STOP_GATE_X - 200;
  game.ps.origin[2] = P4.top + 26;
  settle(game);
  let finished = false;
  for (let i = 0; i < 400 && !finished; i++) {
    finished = game.step({ forward: 127, yaw: 0 }).course.some((e) => e.kind === 'finish');
  }
  check(finished, 'walking on the finish fires the stop timer');
}

export function run(world: World, camPath: string): void {
  ceilings(world);
  teleporters(world);
  routes(world);
  gaps(world);
  hob(world);
  timers(world);
  cameraScript(
    camPath,
    [
      [-600, 0, 24],
      [600, 0, 24],
      [1200, 0, 24],
      [2600, 0, 24],
      [3400, 0, 64],
      [3740, 0, -196],
      [P4.x0 + 300, 0, P4.top + 24],
    ],
    4,
  );
}
