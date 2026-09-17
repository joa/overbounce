/**
 * ob_strafes: replay each section's intended technique -- and each intended
 * failure -- headlessly against the compiled BSP, and report whether the
 * geometry does what `.agent/plans/OB-STRAFES.md` says it does.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Input models (`physics-for-map-authors.md` sections 8 and 9, and
 * `tools/diag/strafes-momentum.ts` for the pilot):
 *
 *  - pilot (round 3's momentum line): hop on landing (n frames late), aim each
 *    hop at the next island's centre by gaining with the air model, coasting,
 *    or braking (forward held with the view turned back); on the runway gain
 *    freely and set the phase so the last hop lands ~40 before the edge; run
 *    to the edge only when a chained hop cannot be aimed at the next island
 *    at all (counted as an edge fallback, a throttle).
 *  - edge jump, air yaw A, e frames early (the safe line): on each island run
 *    with the turned view (`greedyYaw`, the ~399 run), press jump e frames
 *    before the last grounded frame whose box still overlaps the island, then
 *    hold forward with the view at yaw A.
 *  - chain: jump on every landing with no aiming (the runway phase swept).
 *  - no strafe: the run and edge jump (or chain), view straight in the air.
 *
 * What is asserted:
 *
 *  1. The eight gaps strictly increase (from the layout constants, and every
 *     island top is where the constants say, by standing on it).
 *  2. From the spawn down the hall (no divider, no teleporter since round 3)
 *     the momentum family -- pilots at air yaw 58, 60, 62 and greedy, 0..2
 *     frames late -- lands all eight islands and the station with no edge
 *     fallback and every landing above MOMENTUM_MIN ups, from at least 3 of
 *     13 runway phases (where the hopping starts; a player sets that up).
 *  3. The safe family -- edge jumps at air yaw 50, 54 and 60, 0/3/6 frames
 *     early -- lands all eight too.
 *  4. No air strafing fails by G3 and is rescued to the spawn, before the
 *     start gate; running through the gate again restarts the timer (round
 *     5: a miss on the islands is a restart, not a continuation).
 *  5. Every rescue teleporter is a void catch: below every standing surface
 *     in its x range with the step-up and a margin (side-locked-courses.md),
 *     except the visible retry door at the pit floor.
 *  6. Huge gap (1920 since round 3): quad + suit with the plain 399 run, and
 *     with a view-straight 320 run, plus a rocket behind on the jump, land on
 *     the platform for a range of pitches; without quad the plain run is
 *     rescued. A no-quad crossing at the station's hop-chain speed is an
 *     EXPERT line, reported.
 *  7. The pit (320 wide to the rock at x 10182 since round 3, where the
 *     playerclip was; open across its whole width from the rim up since
 *     round 4): the plain
 *     fall does not overbounce; the double quad rocket reaches the exit ledge
 *     for at least MIN_DOUBLE_PAIRS fire-tick pairs; without the suit the
 *     double kills. What one quad rocket, two plain rockets, and launches from
 *     outside the shaft reach -- including rockets into the far wall, and the
 *     rim-jump lines the round-2 overhang and hanging block used to stop --
 *     is reported as EXPERT, not forbidden.
 *  8. The retry door returns the player to the checkpoint in front of the
 *     pickups, powerups still running, and a re-pickup adds quad time.
 *  9. The intended line from the quad pickup to the exit fits the 30 s quad.
 */

import type { Brush } from '../../src/collision/brush.js';
import type { Game, GameInput } from '../../src/game/game.js';
import { Powerup, WeaponTag } from '../../src/game/items.js';
import { Weapon } from '../../src/game/weapons.js';
import { CONTENTS_PLAYERCLIP, CONTENTS_SOLID, DEFAULT_SPEED, PMOVE_MSEC, pm_airaccelerate } from '../../src/physics/constants.js';
import { greedyYaw } from '../strafe-gaps.js';
import type { World } from './harness.js';
import { NONE, cameraScript, check, feet, newGame, settle, x } from './harness.js';

interface Platform {
  name: string;
  x0: number;
  x1: number;
  top: number;
}

// ---------------------------------------------------------------------------
// Layout, from the plan's round-3 table. Change both together.
// ---------------------------------------------------------------------------

const SPAWN: [number, number, number] = [-1184, 0, 25];
/** The start gate's near face: a miss on the islands returns to the spawn, before it, so the run restarts (round 5). */
const START_GATE_X0 = -1024;
const ISLANDS: readonly Platform[] = [
  // The hall and I0 are one runway since round 3 (the divider at x -320..0 is gone).
  { name: 'I0', x0: -1280, x1: 256, top: 0 },
  { name: 'I1', x0: 586, x1: 698, top: 0 },
  { name: 'I2', x0: 1058, x1: 1170, top: -16 },
  { name: 'I3', x0: 1544, x1: 1656, top: -40 },
  { name: 'I4', x0: 2060, x1: 2172, top: -80 },
  { name: 'I5', x0: 2590, x1: 2702, top: -128 },
  { name: 'I6', x0: 3146, x1: 3258, top: -192 },
  { name: 'I7', x0: 3710, x1: 3822, top: -264 },
  { name: 'the station', x0: 4294, x1: 5574, top: -352 },
];
const I0 = ISLANDS[0]!;
const STATION = ISLANDS[ISLANDS.length - 1]!;
/** Where the momentum pilot wants its last runway landing: a takeoff 40 before I0's edge. */
const AIM_X = I0.x1 - 40;
/** The quad checkpoint's teleport destination (x) and the pickups on the running line. */
const RETRY_QUAD_X = 4496;
const QUAD_X = 4992;
/**
 * The landing platform after the huge gap (near edge 7494 since round 3); the
 * tower's -X face; the tunnel ceiling. Round 4 cut the tower back to the rim
 * and deleted the block that hung from its overhang: the pit is open across
 * its whole width from the rim's height up, so the single-rocket rim lines
 * those two blockers stopped are reported now, not forbidden. Round 3 removed
 * the playerclip far wall: the rock at FLOOR.x1 is the wall.
 */
const LANDING: Platform = { name: 'the landing platform', x0: 7494, x1: 9862, top: -352 };
const TOWER_X0 = 9606;
const TUNNEL_CEILING = -64;
const RIM_X = 9862;
// OB_STRAFES_FLOOR_TOP / OB_STRAFES_EXIT_TOP measure an older build of the pit
// (round 1: -1440 and 672) against the same sweeps; the defaults are this build.
const FLOOR: Platform = { name: 'the pit floor', x0: 9798, x1: 10182, top: Number(process.env.OB_STRAFES_FLOOR_TOP ?? -1648) };
const EXIT: Platform = { name: 'the exit ledge', x0: 10182, x1: 10966, top: Number(process.env.OB_STRAFES_EXIT_TOP ?? 252) };
const DEPTH = LANDING.top - FLOOR.top;
const E = EXIT.top - FLOOR.top;
const STOP_X = 10504;
/** The pit's retry door: a visible return out of the softlock, exempt from the void-catch rule. */
const RETRY_DOOR_X: [number, number] = [9806, 9822];

const DT = PMOVE_MSEC / 1000;
const RAD = Math.PI / 180;
/**
 * The double's tolerance floor, in (first, second) fire-tick pairs sampled
 * every 2 ticks, for a walk-off at 400 or 900 facing away from the far wall.
 * Round 2 exists because round 1 (D 1088, E 2112) was too tight: its four lines
 * measured 111, 148, 130, 148 pairs with this sweep. 150 is above every one of
 * them, so a build that is not more forgiving than round 1 fails.
 */
const MIN_DOUBLE_PAIRS = 150;
/** The momentum family must land every island at or above this (the cruise is ~600). */
const MOMENTUM_MIN = 520;
const ALL: readonly Platform[] = [...ISLANDS, LANDING, FLOOR, EXIT];

function gaps(): number[] {
  const out: number[] = [];
  for (let i = 1; i < ISLANDS.length; i++) {
    out.push(ISLANDS[i]!.x0 - ISLANDS[i - 1]!.x1);
  }
  return out;
}

function restingOn(game: Game, p: Platform): boolean {
  return x(game) >= p.x0 - 15 && x(game) <= p.x1 + 15 && Math.abs(feet(game) - (p.top + 0.125)) < 0.5;
}

function platformUnder(game: Game): Platform | undefined {
  return ALL.find((p) => x(game) >= p.x0 - 15 && x(game) <= p.x1 + 15 && Math.abs(feet(game) - p.top) < 2);
}

function where(game: Game): string {
  return `x=${x(game).toFixed(0)} feet=${feet(game).toFixed(2)}`;
}

function teleported(frame: ReturnType<Game['step']>): boolean {
  return frame.course.some((e) => e.kind === 'teleport');
}

/**
 * Stand still until grounded for four frames in a row. `settle` waits for the
 * origin to stop moving, which a player dropped a unit onto the tunnel floor
 * never quite does within its limit; a jump pressed while airborne does nothing.
 */
function ground(game: Game): void {
  let run = 0;
  for (let i = 0; i < 400 && run < 4; i++) {
    game.step(NONE);
    run = game.onGround ? run + 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// 1-4: the islands
// ---------------------------------------------------------------------------

type Air = number | 'none' | 'greedy';

interface IslandLine {
  style: 'pilot' | 'edge' | 'chain';
  air: Air;
  /** pilot/chain: frames after the landing frame to press jump. edge: frames before the last grounded frame. */
  n: number;
  /** pilot: half-width of the aim window on each island. */
  tol?: number;
  /** pilot/chain: x of the first jump (the runway phase). */
  startHop?: number;
}

interface IslandRun {
  /** Islands landed, by index, with the landing origin's distance past the island's near edge and the speed there. */
  lands: { i: number; dx: number; v: number }[];
  /** True if the run ended on the station without a rescue. */
  ok: boolean;
  /** Where a rescue put the player (the settled platform), or null. */
  rescuedTo: string | null;
  /** x after the rescue settled. */
  rescuedX: number;
  /** The island index the player was on when the run failed. */
  failedFrom: number;
  brakeFrames: number;
  coastFrames: number;
  /** Islands where the chained hop could not be aimed and the pilot ran to the edge instead (a throttle). */
  edgeFallbacks: number;
}

function airInput(air: Air, vx: number): GameInput {
  if (air === 'none') {
    return { forward: 127, yaw: 0 };
  }
  if (air === 'greedy') {
    return { forward: 127, yaw: greedyYaw(vx, false) };
  }
  return { forward: 127, yaw: air };
}

/** One frame's x gain in the air at yaw (the lock discards y), before snapping. */
function airGain(air: Air, vx: number): number {
  if (air === 'none') {
    return 0;
  }
  const one = (yaw: number): number => {
    const c = Math.cos(yaw * RAD);
    const add = DEFAULT_SPEED - vx * c;
    return add <= 0 ? 0 : Math.min(pm_airaccelerate * DT * DEFAULT_SPEED, add) * c;
  };
  if (air === 'greedy') {
    let best = 0;
    for (let y = 0; y < 90; y++) {
      best = Math.max(best, one(y));
    }
    return best;
  }
  return one(air);
}

/** Airtime from feet z with vertical speed vz down to a top (effective gravity 750). */
function airtime(z: number, vz: number, top: number): number {
  const dh = z - (top + 0.125);
  const disc = vz * vz + 1500 * dh;
  return disc < 0 ? 0 : (vz + Math.sqrt(disc)) / 750;
}

function centre(p: Platform): number {
  return p === STATION ? p.x0 + 60 : (p.x0 + p.x1) / 2;
}

/** From the spawn, down the hall, then the islands. */
function islandRun(world: World, line: IslandLine): IslandRun {
  const game = newGame(world, SPAWN);
  settle(game);
  const tol = line.tol ?? 24;
  const lands: IslandRun['lands'] = [];
  let cur = 0;
  let wasGround = true;
  let groundFrames = 0;
  let targetX = Number.NaN;
  let targetTop = 0;
  let brakeFrames = 0;
  let coastFrames = 0;
  let edgeFallbacks = 0;
  let jumped = false;
  const fail = (rescued: boolean): IslandRun => {
    if (rescued) {
      settle(game);
    }
    return {
      lands,
      ok: false,
      rescuedTo: rescued ? (ALL.find((p) => restingOn(game, p))?.name ?? where(game)) : where(game),
      rescuedX: x(game),
      failedFrom: cur,
      brakeFrames,
      coastFrames,
      edgeFallbacks,
    };
  };
  for (let f = 0; f < 8000; f++) {
    const vx = game.ps.velocity[0];
    const px = x(game);
    let input: GameInput;
    if (game.onGround) {
      const p = ISLANDS[cur]!;
      const next = ISLANDS[cur + 1]!;
      const atEdge = px + vx * DT * (1 + (line.style === 'edge' ? line.n : 0)) > p.x1 + 15 - 0.5;
      let hop = false;
      if (line.style === 'edge') {
        hop = atEdge;
      } else if (line.style === 'chain') {
        hop = cur > 0 ? groundFrames >= line.n : px >= (line.startHop ?? SPAWN[0]) && groundFrames >= line.n && vx >= 200;
        hop ||= atEdge;
      } else if (groundFrames >= line.n && (cur > 0 || (vx >= 200 && px >= (line.startHop ?? SPAWN[0])))) {
        // pilot: where would a hop from here come down, and can it be aimed
        // onto the next platform? The box reaches 15 past the origin and the
        // 18-unit step-up catches a landing a little short of the near edge.
        const t = airtime(feet(game) + 0.125, 270, next.top);
        const n = t / DT;
        const pred = px + vx * t;
        const brake = (pm_airaccelerate * DT * DEFAULT_SPEED * DT * n * (n + 1)) / 2;
        const gainAuth = (airGain(line.air, vx) * DT * n * (n + 1)) / 2;
        const aimable = pred + gainAuth >= next.x0 - 15 - 24 && pred - brake <= next.x1 + 15 - 8;
        if (aimable) {
          targetX = centre(next);
          targetTop = next.top;
          hop = true;
        } else if (cur === 0) {
          // The runway: while the hop stays on it, divide what is left to
          // AIM_X into hops of the layout's rhythm H (a player learns it) and
          // aim this hop at its share; early hops cannot reach theirs and just
          // gain. The hop that would leave the runway is aimed at AIM_X if
          // braking can hold it there; otherwise the phase is wrong and the
          // pilot runs to the edge.
          const tl = airtime(feet(game) + 0.125, 270, 0);
          const nl = tl / DT;
          const brakeL = (pm_airaccelerate * DT * DEFAULT_SPEED * DT * nl * (nl + 1)) / 2;
          const hFull = vx * tl + (airGain(line.air, vx) * DT * nl * (nl + 1)) / 2;
          const H = centre(ISLANDS[1]!) - AIM_X;
          targetTop = 0;
          if (px + hFull <= I0.x1 - 15) {
            const remaining = AIM_X - px;
            const k = Math.max(1, Math.ceil(remaining / H - 0.15));
            targetX = px + remaining / k;
            hop = true;
          } else if (px + vx * tl - brakeL <= I0.x1 - 15) {
            targetX = AIM_X;
            hop = true;
          } else {
            hop = atEdge;
            targetX = centre(next);
            targetTop = next.top;
            if (groundFrames === line.n) {
              edgeFallbacks++;
            }
          }
        } else {
          // Cannot aim the chained hop onto the next island: run to the edge and jump there.
          hop = atEdge;
          targetX = centre(next);
          targetTop = next.top;
          if (groundFrames === line.n) {
            edgeFallbacks++;
          }
        }
      } else {
        hop = atEdge;
        targetX = centre(next);
        targetTop = next.top;
      }
      input = { forward: 127, yaw: greedyYaw(vx, true), ...(hop ? { up: 127 } : {}) };
      jumped = hop;
    } else if (line.style === 'pilot' && jumped && !Number.isNaN(targetX)) {
      const t = airtime(feet(game), game.ps.velocity[2], targetTop);
      const pred = px + vx * t;
      if (pred < targetX - tol) {
        input = airInput(line.air, vx);
      } else if (pred > targetX + tol) {
        input = { forward: 127, yaw: 180 };
        brakeFrames++;
      } else {
        input = { yaw: 0 };
        coastFrames++;
      }
    } else {
      input = airInput(line.air, vx);
    }
    const frame = game.step(input);
    if (teleported(frame)) {
      return fail(true);
    }
    if (game.onGround) {
      groundFrames = wasGround ? groundFrames + 1 : 0;
      if (!wasGround) {
        const i = ISLANDS.findIndex((p) => x(game) >= p.x0 - 15 && x(game) <= p.x1 + 15 && Math.abs(feet(game) - p.top) < 2);
        if (i > cur) {
          lands.push({ i, dx: Math.round(x(game) - ISLANDS[i]!.x0), v: game.ps.velocity[0] });
          cur = i;
          if (i === ISLANDS.length - 1) {
            return { lands, ok: true, rescuedTo: null, rescuedX: Number.NaN, failedFrom: cur, brakeFrames, coastFrames, edgeFallbacks };
          }
        } else if (i < cur) {
          return fail(false);
        }
      }
    }
    wasGround = game.onGround;
  }
  return fail(false);
}

function describe(r: IslandRun): string {
  const l = r.lands.map((l) => `${ISLANDS[l.i]!.name}+${l.dx}@${l.v}`).join(' ');
  const vmin = r.lands.length ? Math.min(...r.lands.map((l) => l.v)) : 0;
  const head = r.ok ? `lands all, slowest landing ${vmin}` : `fails off ${ISLANDS[r.failedFrom]!.name}, rescued to ${r.rescuedTo} at x ${r.rescuedX.toFixed(0)}`;
  const throttle = r.brakeFrames || r.coastFrames || r.edgeFallbacks ? ` [brake ${r.brakeFrames} coast ${r.coastFrames} frames, ${r.edgeFallbacks} edge fallbacks]` : '';
  return `${head}: ${l || 'nothing'}${throttle}`;
}

function minLanding(r: IslandRun): number {
  return r.lands.length ? Math.min(...r.lands.map((l) => l.v)) : 0;
}

/**
 * Round 5: a miss on the islands is a restart, not a continuation. The rescue
 * lands at the spawn, and running through the start gate again fires
 * `target_startTimer`, which resets the clock (`Course.startTimer`).
 */
function restart(world: World): void {
  const game = newGame(world, SPAWN);
  settle(game);
  let started = 0;
  let startAt = -1;
  for (let i = 0; i < 400 && started < 1; i++) {
    if (game.step({ forward: 127, yaw: 0 }).course.some((e) => e.kind === 'start')) {
      started++;
      startAt = i;
    }
  }
  // Fall into gap 1 with the run going.
  game.ps.origin[0] = 400;
  game.ps.origin[2] = -40;
  game.ps.velocity[0] = 0;
  game.ps.velocity[2] = -300;
  let rescued = false;
  for (let i = 0; i < 200 && !rescued; i++) {
    rescued = teleported(game.step(NONE));
  }
  const rescuedX = x(game);
  let restarted = false;
  let elapsedAtRestart = -1;
  for (let i = 0; i < 400 && !restarted; i++) {
    const frame = game.step({ forward: 127, yaw: 0 });
    const start = frame.course.find((e) => e.kind === 'start');
    if (start) {
      restarted = true;
      elapsedAtRestart = start.elapsed ?? -1;
    }
  }
  check(
    started === 1 && rescued && rescuedX < START_GATE_X0 && restarted && elapsedAtRestart === 0,
    'a fall into a gap returns to the spawn, before the start gate, and running through the gate again restarts the timer',
    `first start at frame ${startAt}, rescued to x ${rescuedX.toFixed(0)}, restart ${restarted ? `fired with elapsed ${elapsedAtRestart}` : 'never fired'}`,
  );
}

/** Best jump from rest on island k over gap k+1: greedy run, hop swept, air greedy or 54. */
function fromRest(world: World, k: number): { ok: boolean; how: string } {
  const from = ISLANDS[k]!;
  const to = ISLANDS[k + 1]!;
  for (const air of ['greedy', 54] as const) {
    for (let hop = from.x0 + 16; hop <= from.x1 + 16; hop += 16) {
      const game = newGame(world, [from.x0 + 16, 0, from.top + 25]);
      settle(game);
      let jumped = false;
      let wasGround = true;
      for (let f = 0; f < 1500; f++) {
        const vx = game.ps.velocity[0];
        let input: GameInput;
        if (game.onGround) {
          const want: boolean = !jumped && (x(game) >= hop || x(game) + vx * DT > from.x1 + 15 - 0.5);
          input = { forward: 127, yaw: greedyYaw(vx, true), ...(want ? { up: 127 } : {}) };
          jumped ||= want;
        } else {
          input = airInput(air, vx);
        }
        const frame = game.step(input);
        if (teleported(frame)) {
          break;
        }
        if (jumped && game.onGround && !wasGround) {
          if (restingOn(game, to) || (x(game) >= to.x0 - 15 && Math.abs(feet(game) - to.top) < 2)) {
            return { ok: true, how: `air ${air}, hop at ${hop}` };
          }
          if (x(game) <= from.x1 + 15) {
            // Landed back on the runway: keep going, the edge jump will fire.
            jumped = false;
          } else {
            break;
          }
        }
        wasGround = game.onGround;
      }
    }
  }
  return { ok: false, how: '' };
}

function islands(world: World): void {
  console.log('\nthe islands: eight gaps, each wider, landed one after another, from the hall');
  const g = gaps();
  const increasing = g.every((w, i) => i === 0 || w > g[i - 1]!);
  check(increasing, 'gaps G1..G8 strictly increase', g.map((w, i) => `G${i + 1} ${w}`).join(', '));
  const drops = ISLANDS.slice(1).map((p, i) => ISLANDS[i]!.top - p.top);
  console.log(`  info  drops into I1..the station: ${drops.join(', ')} (${drops.every((d, i) => i === 0 || d > drops[i - 1]!) ? 'strictly increasing' : 'NOT strictly increasing'})`);

  const tops: string[] = [];
  let topsOk = true;
  for (const p of ISLANDS) {
    const game = newGame(world, [(p.x0 + p.x1) / 2, 0, p.top + 40]);
    settle(game);
    const okTop = restingOn(game, p);
    topsOk &&= okTop;
    tops.push(`${p.name} ${feet(game).toFixed(3)}`);
  }
  check(topsOk, 'every island top is where the layout says (feet rest 0.125 above it)', tops.join(', '));

  // The momentum family. The runway phase (where the hopping starts) is
  // swept: a player sets that up; the layout has to admit the chain for
  // every air model and jump timing from a good share of the phases.
  const PHASES: number[] = [];
  for (let s = -1184; s <= -416; s += 64) {
    PHASES.push(s);
  }
  const momentum = (air: Air, n: number): { good: IslandRun[]; all: IslandRun[] } => {
    const all = PHASES.map((startHop) => islandRun(world, { style: 'pilot', air, n, startHop }));
    const good = all.filter((r) => r.ok && r.edgeFallbacks === 0 && minLanding(r) >= MOMENTUM_MIN);
    return { good, all };
  };
  for (const air of [58, 60, 62, 'greedy'] as const) {
    for (const n of [0, 1, 2]) {
      const { good, all } = momentum(air, n);
      const best = [...good].sort((a, b) => a.brakeFrames + a.coastFrames - (b.brakeFrames + b.coastFrames))[0] ?? all[0]!;
      check(
        good.length >= 3,
        `momentum: pilot, air yaw ${air}, ${n} frames late -- lands all eight and the station at ${MOMENTUM_MIN}+ ups with no edge run from at least 3 of ${PHASES.length} runway phases`,
        `${good.length} of ${PHASES.length} phases; ${good.length ? 'least throttled' : 'first'}: ${describe(best)}`,
      );
    }
  }
  for (const air of [54, 56] as const) {
    const { good, all } = momentum(air, 1);
    console.log(`  info  pilot at air yaw ${air} (${air === 54 ? 543 : 571} ups, under the cruise): ${good.length} of ${PHASES.length} phases; ${describe(all[0]!)}`);
  }
  const starts: number[] = [];
  let startCount = 0;
  for (let s = -1184; s < 240; s += 16) {
    startCount++;
    if (islandRun(world, { style: 'chain', air: 58, n: 0, startHop: s }).ok) {
      starts.push(s);
    }
  }
  console.log(
    `  info  pure chain at air yaw 58 with no aiming, first jump swept along the runway: ${starts.length} of ${startCount} start positions land all eight${starts.length ? ` (x ${starts[0]}..${starts[starts.length - 1]})` : ''}`,
  );

  // The safe family.
  const minDx: number[] = ISLANDS.map(() => Infinity);
  const maxDx: number[] = ISLANDS.map(() => -Infinity);
  for (const air of [50, 54, 60]) {
    for (const early of [0, 3, 6]) {
      const r = islandRun(world, { style: 'edge', air, n: early });
      for (const l of r.lands) {
        minDx[l.i] = Math.min(minDx[l.i]!, l.dx);
        maxDx[l.i] = Math.max(maxDx[l.i]!, l.dx);
      }
      check(r.ok, `safe line: edge jump, air yaw ${air}, ${early} frames early -- lands all eight and the station`, describe(r));
    }
  }
  console.log(
    `  info  safe-line landing origins past each island's near edge (box reaches from -15): ${ISLANDS.slice(1)
      .map((p, j) => `${p.name} ${minDx[j + 1]}..${maxDx[j + 1]}`)
      .join(', ')}`,
  );
  const greedyEdge = islandRun(world, { style: 'edge', air: 'greedy', n: 0 });
  console.log(`  info  edge jumps with the greedy air view: ${describe(greedyEdge)}`);

  const plain = islandRun(world, { style: 'edge', air: 'none', n: 0 });
  check(
    !plain.ok && plain.failedFrom <= 2 && plain.rescuedTo === I0.name && plain.rescuedX < START_GATE_X0,
    'no air strafing (turned-view run, edge jump, view straight in the air) misses by G3 and is rescued to the spawn, before the start gate',
    describe(plain),
  );
  restart(world);
  const plainChain = islandRun(world, { style: 'chain', air: 'none', n: 0 });
  check(!plainChain.ok && plainChain.rescuedTo === I0.name, 'no air strafing, jumping the instant you land: rescued to the hall', describe(plainChain));

  const rest: string[] = [];
  for (let k = 1; k < ISLANDS.length - 1; k++) {
    rest.push(`G${k + 1} ${fromRest(world, k).ok ? 'crossable' : 'not'}`);
  }
  console.log(`  info  best jump from REST on the island in front (not asserted, see the plan): ${rest.join(', ')}`);
}

// ---------------------------------------------------------------------------
// 5: rescue teleporters are void catches
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
 * `side-locked-courses.md`'s rule, as `ob_grounds.ts` applies it: a rescue
 * trigger sits at least TP_MARGIN below every standing surface over its x
 * range (widened by TP_REACH) after the 18-unit step-up. A brush top buried
 * under another brush resting on it is not a standing surface, and a
 * surface below the trigger's bottom is the floor the catch protects. The
 * pit's retry door is a visible return out of a softlock and is exempt.
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
    // One slab at a time: the islands' catch is one entity of eight slabs,
    // each at its own gap's depth.
    const leaf = m.submodels[e.submodel]!.leaf;
    let worst = Infinity;
    let worstAt = '';
    let floor = -Infinity;
    let slabs = 0;
    let door = false;
    for (let j = 0; j < leaf.numLeafBrushes; j++) {
      const t = m.brushes[m.leafbrushes[leaf.firstLeafBrush + j]!]!;
      const x0 = t.bounds[0][0];
      const z0 = t.bounds[0][2];
      const x1 = t.bounds[1][0];
      const z1 = t.bounds[1][2];
      if (x0 >= RETRY_DOOR_X[0] - 1 && x1 <= RETRY_DOOR_X[1] + 1) {
        door = true;
        continue;
      }
      slabs++;
      for (const b of bs) {
        if (b.bounds[0][0] > x1 + TP_REACH || b.bounds[1][0] < x0 - TP_REACH) {
          continue;
        }
        const top = b.bounds[1][2];
        // A translated tapered brush carries ~1e-13 of noise in its bounds, hence the half unit.
        if (bs.some((d) => d !== b && d.bounds[0][2] <= top && d.bounds[1][2] > top && d.bounds[0][0] <= b.bounds[0][0] + 0.5 && d.bounds[1][0] >= b.bounds[1][0] - 0.5)) {
          continue; // a body under its own top slab: not a standing surface
        }
        if (top < z0) {
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
    if (door) {
      console.log(`  info  the retry door at the pit floor (x ${RETRY_DOOR_X[0]}..${RETRY_DOOR_X[1]}) is a visible return, exempt`);
    }
    if (slabs === 0) {
      continue;
    }
    check(
      worst >= TP_MARGIN,
      `void catch -> ${e.target} (${slabs} slab${slabs === 1 ? '' : 's'}) is at least ${TP_MARGIN} below every standing surface in reach (step-up ${TP_STEP} counted)`,
      `lowest ${worstAt}, margin ${worst.toFixed(0)}; the floor it protects ${floor}`,
    );
  }
  console.log(`  info  ${count} trigger_teleport entities`);
}

// ---------------------------------------------------------------------------
// The station: pickups, checkpoint, and what a rescue does to the powerups
// ---------------------------------------------------------------------------

function station(world: World): void {
  console.log('\nthe quad station: checkpoint, rocket launcher, ammo, battle suit, quad');
  const game = newGame(world, [RETRY_QUAD_X - 120, 0, STATION.top + 25]);
  settle(game);
  game.course?.startTimer(game.time);
  let checkpoint = false;
  let rl = false;
  let ammo = false;
  const powerups = new Set<number>();
  for (let f = 0; f < 800 && x(game) < QUAD_X + 64; f++) {
    const frame = game.step({ forward: 127, yaw: 0 });
    checkpoint ||= frame.course.some((e) => e.kind === 'checkpoint');
    for (const ev of frame.items) {
      if (ev.kind !== 'pickup' || !ev.result) {
        continue;
      }
      if (ev.result.weapon === WeaponTag.ROCKET_LAUNCHER) {
        rl = true;
      } else if (ev.result.ammo !== undefined) {
        ammo = true;
      }
      if (ev.result.powerup !== undefined) {
        powerups.add(ev.result.powerup);
      }
    }
  }
  check(checkpoint, 'walking the station fires the quad checkpoint');
  check(rl && ammo, 'the rocket launcher and the rockets are on the running line', `rockets ${game.ps.ammo[WeaponTag.ROCKET_LAUNCHER]}`);
  check(powerups.has(Powerup.BATTLESUIT) && powerups.has(Powerup.QUAD), 'the battle suit and the quad are on the running line');
  console.log(
    `  info  weapon after the pickups: ${game.weapon === Weapon.ROCKET_LAUNCHER ? 'rocket launcher' : 'still the machine gun'} (autoswitch fires only when unarmed; the hint tells the player to switch)`,
  );

  // Rescue from the huge gap: the powerups keep running, and the pickups are back.
  const quadBefore = game.ps.powerups[Powerup.QUAD];
  game.ps.origin[0] = 6400;
  game.ps.origin[2] = -560;
  game.ps.velocity[0] = 0;
  game.ps.velocity[2] = -400;
  let rescued = false;
  for (let f = 0; f < 200 && !rescued; f++) {
    rescued = teleported(game.step(NONE));
  }
  settle(game);
  check(
    rescued && x(game) > RETRY_QUAD_X - 16 && x(game) < QUAD_X - 128 && restingOn(game, STATION),
    'a fall into the huge gap is rescued to the checkpoint, in front of the pickups',
    where(game),
  );
  check(game.ps.powerups[Powerup.QUAD] > game.time && game.ps.powerups[Powerup.BATTLESUIT] > game.time, 'the quad and the suit are still running after the rescue');
  for (let f = 0; f < 300; f++) {
    game.step(NONE);
  }
  for (let f = 0; f < 800 && x(game) < QUAD_X + 64; f++) {
    game.step({ forward: 127, yaw: 0 });
  }
  const added = game.ps.powerups[Powerup.QUAD] - quadBefore;
  check(added >= 29000, 'the quad has respawned (wait 2) and a re-pickup adds its 30 s', `+${added} ms`);
}

// ---------------------------------------------------------------------------
// 6: the huge gap
// ---------------------------------------------------------------------------

interface GapFlight {
  outcome: 'landed' | 'rescued' | 'other';
  /** Where the feet came down through the landing platform's height, or null. */
  downX: number | null;
  /** Landing x on the platform. */
  landX: number;
  exitReached: boolean;
}

/**
 * Run the station to its edge (turned-view run, or a forced speed `v` on the
 * ground: 320 models a view-straight run, more a hot arrival), jump there and
 * fire `delay` frames later at `pitch` with the view turned back. After the
 * shot, `strafe` turns around and air-strafes with the greedy yaw.
 */
function gapFlight(world: World, quad: boolean, pitch: number, delay: number, v: number | null, strafe: boolean): GapFlight {
  // Past the pickups (the quad is at ${QUAD_X}): a no-quad line must not collect it.
  const game = newGame(world, [QUAD_X + 96, 0, STATION.top + 25], Weapon.ROCKET_LAUNCHER);
  game.ps.powerups[Powerup.BATTLESUIT] = 1e9;
  if (quad) {
    game.ps.powerups[Powerup.QUAD] = 1e9;
  }
  settle(game);
  let jumped = -1;
  let downX: number | null = null;
  let prevFeet = feet(game);
  let exitReached = false;
  for (let f = 0; f < 3000; f++) {
    const vx = game.ps.velocity[0];
    let input: GameInput;
    if (jumped < 0) {
      if (v !== null && game.onGround) {
        game.ps.velocity[0] = v;
      }
      const speed = game.ps.velocity[0];
      const want = game.onGround && x(game) + speed * DT > STATION.x1 + 15 - 0.5;
      input = want ? { up: 127, yaw: 180, pitch, attack: delay === 0 } : { forward: 127, yaw: v === 320 ? 0 : greedyYaw(vx, game.onGround) };
      if (want) {
        jumped = f;
      }
    } else {
      const rel = f - jumped;
      if (rel <= delay) {
        input = { yaw: 180, pitch, attack: rel === delay };
      } else if (strafe) {
        input = { forward: 127, yaw: greedyYaw(vx, false) };
      } else {
        input = { yaw: 0 };
      }
    }
    const frame = game.step(input);
    if (jumped >= 0 && prevFeet > LANDING.top && feet(game) <= LANDING.top && game.ps.velocity[2] <= 0) {
      downX = x(game);
    }
    prevFeet = feet(game);
    exitReached ||= restingOn(game, EXIT);
    if (teleported(frame)) {
      return { outcome: 'rescued', downX, landX: x(game), exitReached };
    }
    if (jumped >= 0 && f > jumped + 5 && game.onGround) {
      const p = platformUnder(game);
      return { outcome: p === LANDING ? 'landed' : 'other', downX, landX: x(game), exitReached };
    }
  }
  return { outcome: 'other', downX, landX: x(game), exitReached };
}

function hugeGap(world: World): void {
  const width = LANDING.x0 - STATION.x1;
  console.log(`\nthe huge gap (${width}, level): quad + suit, rocket behind on the jump`);
  for (const [what, v] of [
    ['the turned-view run (~399)', null],
    ['a view-straight run (320)', 320],
  ] as const) {
    const good: string[] = [];
    const landXs: number[] = [];
    let anyExit = false;
    for (const pitch of [40, 45, 50, 55, 60, 65, 70]) {
      for (const delay of [0, 1, 2, 3]) {
        const r = gapFlight(world, true, pitch, delay, v, false);
        if (r.outcome === 'landed') {
          good.push(`p${pitch}/d${delay}`);
          landXs.push(r.landX);
        }
        anyExit ||= r.exitReached;
      }
    }
    check(
      good.length >= 12 && !anyExit,
      `${what}, jump and quad rocket behind lands on the platform for a wide range of pitches (no strafing needed), never on the exit`,
      `${good.length} of 28 land: ${good.join(' ')}; landing x ${landXs.length ? `${Math.min(...landXs).toFixed(0)}..${Math.max(...landXs).toFixed(0)}` : 'none'} (platform ${LANDING.x0}..${TOWER_X0} before the tower)`,
    );
  }
  const strafed = gapFlight(world, true, 55, 1, null, true);
  console.log(`  info  pitch 55 with air strafing after the shot (the expert line, for speed): ${strafed.outcome} at x=${strafed.landX.toFixed(0)}`);

  // The fastest the station lets a player leave its edge: a hot arrival
  // (the momentum chain lands at ~600) hopping the whole station with the
  // greedy yaw.
  const hop = newGame(world, [STATION.x0 + 40, 0, STATION.top + 25]);
  hop.ps.velocity[0] = 650;
  let vmax = 0;
  for (let f = 0; f < 2000 && x(hop) < STATION.x1 + 15; f++) {
    const vx = hop.ps.velocity[0];
    vmax = Math.max(vmax, vx);
    if (teleported(hop.step({ forward: 127, yaw: greedyYaw(vx, hop.onGround), ...(hop.onGround ? { up: 127 } : {}) }))) {
      break;
    }
  }
  const rows: string[] = [];
  let plainRescued = true;
  for (const v of [null, vmax, 1100] as const) {
    let best = -Infinity;
    let rescued = true;
    let landed = 0;
    for (const pitch of [30, 45, 55, 60, 65, 70, 80]) {
      for (const delay of [0, 1, 2]) {
        const r = gapFlight(world, false, pitch, delay, v, true);
        rescued &&= r.outcome === 'rescued';
        landed += r.outcome === 'landed' ? 1 : 0;
        best = Math.max(best, r.downX ?? -Infinity);
      }
    }
    if (v === null) {
      plainRescued = rescued;
    }
    rows.push(`${v ?? 'run'}: ${rescued ? 'all rescued' : `${landed} of 21 land`}, furthest down through the platform height at x ${Number.isFinite(best) ? best.toFixed(0) : 'never'}`);
  }
  check(plainRescued, 'without quad (suit on), a rocket jump from the turned-view run with air strafing is rescued to the checkpoint: the quad is needed unless you bring speed', rows[0]);
  console.log(`  ${rows[1]!.startsWith(`${vmax}: all rescued`) ? 'info  ' : 'EXPERT'}  without quad at the station's greedy hop-chain speed (${vmax}) and at 1100: ${rows.slice(1).join('; ')}; the platform starts at ${LANDING.x0}`);
}

// ---------------------------------------------------------------------------
// 7: the pit
// ---------------------------------------------------------------------------

interface PitOpts {
  quad: boolean;
  suit: boolean;
  /** Ground speed forced while walking off the rim. */
  v: number;
  /** Fire frames, relative to the first airborne frame off the rim (or the jump frame). */
  fires: number[];
  pitch: number;
  /**
   * View yaw while falling and firing. The view pitch clamps at 87.89, so a
   * rocket fired "straight down" while FACING the far wall drifts ~0.037 a unit
   * into it and explodes on the wall ~400 units down; facing away (180) or
   * sideways (90) it reaches the floor. Default 0.
   */
  yaw?: number;
  /** Hold forward (into the far wall) during the fall. */
  hold: boolean;
  /** Start standing on the pit floor against the far wall and jump on frame 0 instead of walking off the rim. */
  floorJump?: boolean;
  /**
   * Jump off the rim instead of walking off it: press jump on the grounded
   * frame whose feet are within this many units of leaving the rim (0 = the
   * last grounded frame). The roof over the rim is 288 clear, so a jump fits.
   */
  rimJump?: number | undefined;
}

interface PitResult {
  apex: number;
  exit: boolean;
  dead: boolean;
  /** Ticks from leaving the rim to the first ground contact after it, or -1. */
  land: number;
}

function pitLine(world: World, o: PitOpts): PitResult {
  const start: [number, number, number] = o.floorJump ? [FLOOR.x1 - 16, 0, FLOOR.top + 25] : [RIM_X - 40, 0, LANDING.top + 25];
  const game = newGame(world, start, Weapon.ROCKET_LAUNCHER);
  if (o.quad) {
    game.ps.powerups[Powerup.QUAD] = 1e9;
  }
  if (o.suit) {
    game.ps.powerups[Powerup.BATTLESUIT] = 1e9;
  }
  ground(game);
  let t0 = o.floorJump ? 0 : -1;
  let apex = -Infinity;
  let land = -1;
  let jumped = false;
  const last = Math.max(0, ...o.fires);
  for (let i = 0; i < 2600; i++) {
    const rel = t0 < 0 ? -1 : i - t0;
    if (t0 < 0 && game.onGround) {
      game.ps.velocity[0] = o.v;
    }
    const fire = rel >= 0 && o.fires.includes(rel);
    const move = t0 < 0 || rel > last || o.hold ? { forward: 127 } : {};
    // The feet leave the rim once the box's back edge (-15) passes it; the
    // next frame's move is ~v * DT, so "within rimJump of leaving" is read
    // against where this frame will end.
    const rimJumpNow: boolean =
      o.rimJump !== undefined && !jumped && t0 < 0 && game.onGround && x(game) + o.v * DT >= RIM_X + 15 - o.rimJump;
    jumped ||= rimJumpNow;
    const jump = (o.floorJump && rel === 0) || rimJumpNow ? { up: 127 } : {};
    const yaw = t0 < 0 || rel > last ? 0 : (o.yaw ?? 0);
    const frame = game.step({ yaw, pitch: o.pitch, attack: fire, ...move, ...jump });
    if (frame.respawned !== null) {
      return { apex, exit: false, dead: true, land };
    }
    if (t0 < 0 && !game.onGround && x(game) > RIM_X + 15) {
      t0 = i;
    }
    if (t0 >= 0) {
      apex = Math.max(apex, feet(game));
      if (land < 0 && i > t0 && game.onGround) {
        land = i - t0;
      }
    }
    if (restingOn(game, EXIT)) {
      return { apex, exit: true, dead: false, land };
    }
    if (rel > last + 20 && game.onGround && game.ps.velocity[2] <= 0 && feet(game) < EXIT.top - 1) {
      break;
    }
  }
  return { apex, exit: false, dead: false, land };
}

interface DoubleWindow {
  /** Ticks from leaving the rim to landing with nothing fired. */
  plainLand: number;
  /** (first, second) fire-tick pairs, sampled every `step` ticks, that reach the exit. */
  pairs: number;
  /** First-shot ticks that work with some second shot, relative to the plain landing. */
  first: [number, number] | null;
  firstSamples: number;
  /** Second-shot ticks that work, relative to the plain landing. */
  second: [number, number] | null;
  /** The widest second-shot window for one first shot, in ticks. */
  secondWidth: number;
  /** One working (first, second) pair, ticks after leaving the rim. */
  example: [number, number] | null;
}

/**
 * Sweep the double's two fire ticks the way `physics-for-map-authors.md` section
 * 9 ("How forgiving the double is") measures it, on the real map: every first
 * shot during the fall, and for each, every second shot around the landing.
 *
 * Both are read against the PLAIN landing tick. The first rocket, fired at
 * pitch 89 from high in the fall, reaches the floor at or after the player
 * does, so it does not move the landing; a late first shot explodes up to ~10
 * ticks after it, and its working second shot comes later still (probed
 * 2026-09-14 on the round-1 BSP: first shot at landing -89, second at +12).
 */
function doubleWindow(world: World, yaw: number, v: number, step = 2): DoubleWindow {
  const plainLand = pitLine(world, { quad: true, suit: true, v, fires: [], pitch: 89, yaw, hold: false }).land;
  const out: DoubleWindow = { plainLand, pairs: 0, first: null, firstSamples: 0, second: null, secondWidth: 0, example: null };
  for (let f1 = Math.max(20, plainLand - 220); f1 < plainLand - 20; f1 += step) {
    let works = 0;
    let misses = 0;
    for (let f2 = Math.max(f1 + step, plainLand - 50); f2 <= plainLand + 60; f2 += step) {
      const r = pitLine(world, { quad: true, suit: true, v, fires: [f1, f2], pitch: 89, yaw, hold: false });
      if (!r.exit) {
        // A second shot window is one contiguous run; stop well past its end.
        if (works > 0 && ++misses >= 8) {
          break;
        }
        continue;
      }
      misses = 0;
      works++;
      out.pairs++;
      out.example ??= [f1, f2];
      const rel = f2 - plainLand;
      out.second = out.second ? [Math.min(out.second[0], rel), Math.max(out.second[1], rel)] : [rel, rel];
    }
    if (works > 0) {
      const rel = f1 - plainLand;
      out.first = out.first ? [Math.min(out.first[0], rel), Math.max(out.first[1], rel)] : [rel, rel];
      out.firstSamples++;
      out.secondWidth = Math.max(out.secondWidth, works * step);
    }
  }
  return out;
}

function describeWindow(w: DoubleWindow): string {
  if (!w.first || !w.second) {
    return `no working pair (plain landing ${w.plainLand} ticks after the rim)`;
  }
  return (
    `${w.pairs} pairs; first shot ${w.first[0]}..${w.first[1]} ticks from the plain landing (${w.firstSamples} samples), ` +
    `second shot ${w.second[0]}..${w.second[1]} ticks from it, up to ${w.secondWidth} ticks wide for one first shot ` +
    `(plain landing ${w.plainLand} ticks after the rim)`
  );
}

/** Walk off the rim with nothing fired and read the launch on the frames after landing. */
function plainFall(world: World, v: number): { launch: number; landX: number } {
  const game = newGame(world, [RIM_X - 40, 0, LANDING.top + 25]);
  ground(game);
  let left = false;
  let landed = -1;
  let launch = 0;
  let landX = 0;
  for (let i = 0; i < 1000; i++) {
    if (!left && game.onGround) {
      game.ps.velocity[0] = v;
    }
    game.step(left ? NONE : { forward: 127, yaw: 0 });
    left ||= !game.onGround && x(game) > RIM_X + 15;
    if (left && landed < 0 && game.onGround) {
      landed = i;
      landX = x(game);
    }
    if (landed >= 0 && i > landed && i <= landed + 4) {
      launch = Math.max(launch, game.ps.velocity[2]);
    }
    if (landed >= 0 && i > landed + 4) {
      break;
    }
  }
  return { launch, landX };
}

/** A launch from a standing surface outside the shaft: jump+fire, then more rockets later. */
function outsideLine(world: World, at: number, pitch: number, fires: number[], hold: boolean): PitResult {
  const game = newGame(world, [at, 0, LANDING.top + 25], Weapon.ROCKET_LAUNCHER);
  game.ps.powerups[Powerup.QUAD] = 1e9;
  game.ps.powerups[Powerup.BATTLESUIT] = 1e9;
  ground(game);
  let apex = -Infinity;
  const last = Math.max(...fires);
  for (let i = 0; i < 2000; i++) {
    const frame = game.step({ yaw: 0, pitch: i <= 1 ? 89 : pitch, up: i === 0 ? 127 : 0, attack: fires.includes(i), ...(hold ? { forward: 127 } : {}) });
    if (frame.respawned !== null) {
      return { apex, exit: false, dead: true, land: -1 };
    }
    apex = Math.max(apex, feet(game));
    if (restingOn(game, EXIT)) {
      return { apex, exit: true, dead: false, land: -1 };
    }
    if (i > last + 20 && game.onGround && game.ps.velocity[2] <= 0) {
      break;
    }
  }
  return { apex, exit: false, dead: false, land: -1 };
}

function pit(world: World): { doubleFrames: number } {
  console.log(`\nthe pit: a ${DEPTH} fall, ${FLOOR.x1 - RIM_X} wide to the rock, the exit ledge ${E} above the floor`);
  // OB_STRAFES_PIT_PARTS=a,b (windows, a, b, c, d) runs part of the pit while
  // iterating; (c) needs the windows for its working line.
  const parts = process.env.OB_STRAFES_PIT_PARTS?.split(',').map((s) => s.trim());
  const part = (p: string): boolean => !parts || parts.includes(p);
  for (const v of [100, 320, 400, 600, 900]) {
    const r = plainFall(world, v);
    check(r.launch < 50, `walking off the rim at ${v} does not overbounce`, `vz on the frames after landing <= ${r.launch}, landed x=${r.landX.toFixed(0)}`);
  }

  // The intended line: walk off, turn away from the far wall, fire down during
  // the fall and again around the landing; both fire ticks swept (section 9,
  // "How forgiving the double is"). Sampled every 2 ticks.
  let doubleFrames = 0;
  let working: { v: number; f1: number; f2: number; yaw: number } | null = null;
  for (const yaw of part('windows') ? [180, 90] : []) {
    for (const v of [400, 900, 320]) {
      const w = doubleWindow(world, yaw, v);
      if (w.example) {
        doubleFrames = Math.max(doubleFrames, w.example[1]);
        working ??= { v, f1: w.example[0], f2: w.example[1], yaw };
      }
      const what = `walk off at ${v}, quad + suit, back (yaw ${yaw}) to the far wall, fire down in the fall and again on the landing`;
      if (v === 320) {
        console.log(`  info  ${what}: ${describeWindow(w)}`);
      } else {
        check(w.pairs >= MIN_DOUBLE_PAIRS, `${what}: reaches the exit for at least ${MIN_DOUBLE_PAIRS} fire-tick pairs`, describeWindow(w));
      }
    }
  }

  // (a) one quad rocket, (b) two plain rockets, by every swept line. Reported,
  // not asserted, since round 3: the far wall is real and rockets into it are
  // the creativity the user asked for.
  const sweep = (quad: boolean, k: 1 | 2): { exit: boolean; apex: number; how: string; byLine: string } => {
    let best = { exit: false, apex: -Infinity, how: '' };
    const lineBest = new Map<string, number>();
    const lineExit = new Set<string>();
    const note = (key: string, r: PitResult): void => {
      lineBest.set(key, Math.max(lineBest.get(key) ?? -Infinity, r.apex));
      if (r.exit) {
        lineExit.add(key);
      }
    };
    for (const v of [320, 600, 900, 1200]) {
      // Walk off the rim, or jump off its edge: the jump arrives at the far wall
      // near rim height with little fall speed, which is the best single wall shot.
      for (const rimJump of [undefined, 0, 8] as const) {
        if (v === 1200 && rimJump === undefined) {
          continue;
        }
        const pitches = rimJump === undefined ? [60, 75, 85, 89] : [60, 70, 75, 80, 85];
        const fMax = rimJump === undefined ? 230 : 140;
        for (const pitch of pitches) {
          for (const [hold, yaw] of [[false, 0], [true, 0], [false, 180]] as const) {
            // Every tick for the first 24 (the rim shot peaks at 1..3 ticks off the rim), then every 2.
            for (let f1 = 0; f1 <= fMax; f1 += f1 < 24 ? 1 : 2) {
              const r = pitLine(world, { quad, suit: true, v, fires: k === 1 ? [f1] : [f1, f1 + 100], pitch, yaw, hold, rimJump });
              note(`${rimJump === undefined ? 'walk-off' : 'rim jump'}, ${yaw === 0 ? 'facing the far wall' : 'facing the rim'}${hold ? ', holding forward' : ''}`, r);
              if (r.exit || r.apex > best.apex) {
                best = {
                  exit: best.exit || r.exit,
                  apex: Math.max(best.apex, r.apex),
                  how: `v${v} ${rimJump === undefined ? 'walk-off' : `rim jump ${rimJump}`} pitch ${pitch} yaw ${yaw} hold ${hold} f1 ${f1}`,
                };
              }
            }
          }
        }
      }
    }
    for (const pitch of [60, 70, 75, 80, 85, 89]) {
      for (const hold of [false, true]) {
        for (let d = 0; d <= 3; d++) {
          const r = pitLine(world, { quad, suit: true, v: 0, fires: k === 1 ? [d] : [d, d + 100], pitch, hold, floorJump: true });
          note('jump from the floor at the far wall', r);
          if (r.exit || r.apex > best.apex) {
            best = { exit: best.exit || r.exit, apex: Math.max(best.apex, r.apex), how: `floor jump, pitch ${pitch} hold ${hold} delay ${d}` };
          }
        }
      }
    }
    const byLine = [...lineBest.entries()]
      .sort((p, q) => q[1] - p[1])
      .map(([key, apex]) => `${key} ${(apex - FLOOR.top).toFixed(0)}${lineExit.has(key) ? ' (reaches the exit)' : ''}`)
      .join('; ');
    return { ...best, byLine };
  };
  if (part('a')) {
    const one = sweep(true, 1);
    console.log(
      `  ${one.exit ? 'EXPERT' : 'info  '}  (a) one quad rocket, by any swept line (walk-off or rim jump at any fire frame, wall shots, a jump from the floor): ${
        one.exit ? 'REACHES the exit' : 'stays under the exit'
      }; best apex ${(one.apex - FLOOR.top).toFixed(0)} above the floor (${one.how}), exit ${E}`,
    );
    console.log(`  info  (a) by line: ${one.byLine}`);
  }
  if (part('b')) {
    const plain2 = sweep(false, 2);
    console.log(
      `  ${plain2.exit ? 'EXPERT' : 'info  '}  (b) two plain rockets (no quad, suit on), by any swept line including the wall shots: ${
        plain2.exit ? 'REACH the exit -- the quad is skippable in the pit' : 'do not reach the exit'
      }; best apex ${(plain2.apex - FLOOR.top).toFixed(0)} above the floor (${plain2.how})`,
    );
    console.log(`  info  (b) by line: ${plain2.byLine}`);
  }

  // (c) the suit is what makes it survivable.
  let killed = working !== null;
  let anyExit = false;
  if (working && part('c')) {
    for (const df of [0, 4, 8]) {
      const r = pitLine(world, { quad: true, suit: false, v: working.v, fires: [working.f1 + df, working.f2 + df], pitch: 89, yaw: working.yaw, hold: false });
      killed &&= r.dead;
      anyExit ||= r.exit;
    }
  }
  if (part('c')) {
    check(
      killed && !anyExit,
      '(c) without the battle suit the double kills (respawn at the start)',
      working ? `the working line v${working.v} yaw ${working.yaw}, fires ${working.f1}/${working.f2} shifted by 0, 4, 8 ticks` : 'no working double to test',
    );
  }
  if (!part('d')) {
    return { doubleFrames };
  }

  // (d) launches from standing surfaces outside the shaft: reported.
  let outside = false;
  let outsideApex = -Infinity;
  let outsideHow = '';
  for (const at of [LANDING.x0 + 700, TOWER_X0 - 64, TOWER_X0 + 100, RIM_X - 16, RIM_X + 10]) {
    for (const pitch of [60, 75, 89]) {
      for (const hold of [false, true]) {
        for (const second of [100, 140, 180, 220, 260]) {
          const r = outsideLine(world, at, pitch, [0, second, second + 100], hold);
          if (r.exit && !outside) {
            outsideHow = `from x ${at}, pitch ${pitch}, hold ${hold}, second rocket at ${second}`;
          }
          outside ||= r.exit;
          outsideApex = Math.max(outsideApex, r.apex);
        }
      }
    }
  }
  console.log(
    `  ${outside ? 'EXPERT' : 'info  '}  (d) a quad jump+fire (then two more rockets) from the landing platform, the tunnel floor or the rim ${
      outside ? `REACHES the exit (${outsideHow})` : 'does not reach the exit'
    }; best apex ${outsideApex.toFixed(0)} (z), exit top ${EXIT.top}; the tunnel ceiling is ${TUNNEL_CEILING - LANDING.top} over the floor to x=${RIM_X}, and the pit is open from the rim on (round 4: no overhang, no hanging block)`,
  );

  // Alternate in-shaft lines: printed, not asserted.
  const wall = pitLine(world, { quad: true, suit: true, v: 0, fires: [0, 100], pitch: 80, hold: true, floorJump: true });
  const rimTwo = pitLine(world, { quad: true, suit: true, v: 900, fires: [0, 100], pitch: 75, hold: true });
  console.log(`  info  alternate two-quad-rocket lines in the shaft: floor jump+fire then a wall rocket ${wall.exit ? 'reaches' : 'does not reach'} the exit (apex ${(wall.apex - FLOOR.top).toFixed(0)}); a rim shot then a wall rocket ${rimTwo.exit ? 'reaches' : 'does not reach'} it (apex ${(rimTwo.apex - FLOOR.top).toFixed(0)})`);
  return { doubleFrames };
}

// ---------------------------------------------------------------------------
// 8-9: the retry door and the timing
// ---------------------------------------------------------------------------

function retryDoor(world: World): void {
  console.log('\nthe retry door at the pit floor');
  const game = newGame(world, [FLOOR.x1 - 40, 0, FLOOR.top + 25], Weapon.ROCKET_LAUNCHER);
  game.ps.powerups[Powerup.QUAD] = game.time + 20000;
  game.ps.powerups[Powerup.BATTLESUIT] = game.time + 20000;
  settle(game);
  let tele = false;
  for (let f = 0; f < 600 && !tele; f++) {
    tele = teleported(game.step({ forward: 127, yaw: 180 }));
  }
  settle(game);
  check(tele && restingOn(game, STATION) && x(game) < QUAD_X - 128, 'walking back into the door at the pit floor returns to the quad checkpoint, in front of the pickups', where(game));
  check(game.ps.powerups[Powerup.QUAD] > game.time, 'the quad is still running after the door');
}

function timing(world: World, doubleFrames: number): void {
  console.log('\ntiming: quad pickup -> huge gap -> pit -> exit, against the 30 s quad');
  const toEdge = (STATION.x1 - QUAD_X) / 399;
  const flight = gapFlight(world, true, 55, 1, null, false);
  const flightTime = 3.0;
  const walk = (RIM_X - flight.landX) / 399;
  const pitTime = doubleFrames * DT + 2.5;
  const total = toEdge + flightTime + walk + pitTime;
  check(total < 20, 'the intended line fits well inside 30 s of quad', `~${total.toFixed(1)} s (station ${toEdge.toFixed(1)}, flight ~${flightTime}, platform ${walk.toFixed(1)}, fall + double + rise ~${pitTime.toFixed(1)})`);
}

function timers(world: World): void {
  console.log('\ntimer gates');
  const game = newGame(world, SPAWN);
  settle(game);
  let started = false;
  for (let i = 0; i < 400 && !started; i++) {
    started = game.step({ forward: 127, yaw: 0 }).course.some((e) => e.kind === 'start');
  }
  check(started, 'walking from the spawn fires the start timer');
  const end = newGame(world, [STOP_X - 200, 0, EXIT.top + 25]);
  settle(end);
  end.course?.startTimer(end.time);
  let finished = false;
  for (let i = 0; i < 400 && !finished; i++) {
    finished = end.step({ forward: 127, yaw: 0 }).course.some((e) => e.kind === 'finish');
  }
  check(finished, 'walking on the exit ledge fires the stop timer');
}

export function run(world: World, camPath: string): void {
  // OB_STRAFES_ONLY=pit,timing (comma-separated section names) runs a subset
  // while iterating on one section; the full run is what verifies the course.
  const only = process.env.OB_STRAFES_ONLY?.split(',').map((s) => s.trim());
  const want = (section: string): boolean => !only || only.includes(section);
  if (want('islands')) islands(world);
  if (want('teleporters')) teleporters(world);
  if (want('station')) station(world);
  if (want('gap')) hugeGap(world);
  const { doubleFrames } = want('pit') ? pit(world) : { doubleFrames: 250 };
  if (want('door')) retryDoor(world);
  if (want('timing')) timing(world, doubleFrames);
  if (want('timers')) timers(world);
  if (!want('camera')) {
    return;
  }
  cameraScript(
    camPath,
    [
      [-900, 0, 24],
      [-200, 0, 24],
      [1500, 0, -8],
      [4800, 0, -328],
      [7000, 0, 200],
      [10150, 0, -1200],
      [10700, 0, 276],
    ],
    5,
  );
}
