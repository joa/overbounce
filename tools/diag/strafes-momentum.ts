/**
 * ob_strafes round 3: what island spacing lets a bunny-hop chain CARRY its
 * speed through eight gaps, and which players land it?
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npx tsx tools/diag/strafes-momentum.ts              # hops table + generated layout + families
 *   npx tsx tools/diag/strafes-momentum.ts --cruise 60  # generate the layout from this air yaw
 *
 * Rounds 1-2 spaced the islands for EDGE jumps (each island resets the speed
 * to the ~399 turned-view run). The playtest asked for momentum instead:
 * remove the hall divider and its teleporter, and space the islands so a
 * player who keeps gaining speed does not have to throttle. Under the y lock
 * a constant air yaw saturates at 320/cos(yaw) (physics doc section 8), so a
 * momentum chain is a chain at a cruise speed, and its hop length grows only
 * with the drop into the next island. With I0's edge (256) and the station
 * (4294) fixed, the eight hops' sum is fixed, and that picks the cruise.
 *
 * Synthetic axial world through the full `Game` under the lock, as
 * `tools/strafe-gaps.ts` does. Islands are 112 long, as built.
 */

import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import type { CollisionModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID, DEFAULT_SPEED, PMOVE_MSEC, pm_airaccelerate } from '../../src/physics/constants.js';
import { Game } from '../../src/game/game.js';
import type { GameInput } from '../../src/game/game.js';
import { greedyYaw } from '../strafe-gaps.js';

const DT = PMOVE_MSEC / 1000;
const RAD = Math.PI / 180;
const LOCK = { axis: 1 as const, value: 0 };

const RUNWAY_X0 = -1280;
const EDGE = 256;
const SPAWN: [number, number, number] = [-1184, 0, 25];
const STATION_X0 = 4294;
const STATION_X1 = 5574;
const STATION_TOP = -352;
const L = 112;
/** Where the momentum pilot wants its last runway landing (a takeoff 40 before the edge). */
const AIM_X = EDGE - 40;
/** Drops into I1..I7 and the station, strictly increasing, summing to 352. */
const DROPS = [0, 16, 24, 40, 48, 64, 72, 88];

export interface Island {
  name: string;
  x0: number;
  x1: number;
  top: number;
}

type Air = number | 'greedy' | 'none';

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
  if (disc < 0) {
    return 0;
  }
  return (vz + Math.sqrt(disc)) / 750;
}

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

function base(): ReturnType<typeof axialBrush>[] {
  return [
    axialBrush([RUNWAY_X0 - 16, -512, -2048], [RUNWAY_X0, 512, 1024], CONTENTS_SOLID),
    axialBrush([RUNWAY_X0, -512, -2048], [EDGE, 512, 0], CONTENTS_SOLID),
    axialBrush([STATION_X0, -512, -2048], [STATION_X1, 512, STATION_TOP], CONTENTS_SOLID),
  ];
}

function islandWorld(islands: readonly Island[]): CollisionModel {
  return brushListModel([...base(), ...islands.map((p) => axialBrush([p.x0, -512, p.top - 300], [p.x1, 512, p.top], CONTENTS_SOLID))]);
}

/** A continuous floor that steps down at `steps` (x) by the drops, for measuring hops. */
function steppedWorld(steps: readonly number[]): CollisionModel {
  const bs = [axialBrush([RUNWAY_X0 - 16, -512, -2048], [RUNWAY_X0, 512, 1024], CONTENTS_SOLID)];
  let x0 = RUNWAY_X0;
  let top = 0;
  for (let k = 0; k < steps.length; k++) {
    bs.push(axialBrush([x0, -512, -2048], [steps[k]!, 512, top], CONTENTS_SOLID));
    x0 = steps[k]!;
    top -= DROPS[k]!;
  }
  bs.push(axialBrush([x0, -512, -2048], [x0 + 8000, 512, top], CONTENTS_SOLID));
  return brushListModel(bs);
}

// ---------------------------------------------------------------------------
// Hop lengths of a pure chain (jump on every landing) at a constant air yaw
// ---------------------------------------------------------------------------

interface Hop {
  v: number;
  h: number;
  drop: number;
}

/**
 * From the spawn, hop on every landing with the air view at `air`; the floor
 * steps down by DROPS at the eight hops after x = EDGE. The step positions
 * are placed just past each landing and iterated until they stop moving, so
 * every measured hop really starts on the upper level and lands on the lower.
 */
function hops(air: Air): Hop[] {
  let steps = DROPS.map((_, k) => EDGE + 500 * (k + 1));
  let out: Hop[] = [];
  for (let iter = 0; iter < 6; iter++) {
    const world = steppedWorld(steps);
    const game = new Game({ world, origin: SPAWN, axisLock: LOCK });
    for (let i = 0; i < 30; i++) {
      game.step({ yaw: 0 });
    }
    const lands: { x: number; v: number }[] = [];
    let wasGround = true;
    for (let i = 0; i < 4000 && lands.length < 40; i++) {
      const vx = game.ps.velocity[0];
      game.step(game.onGround ? { forward: 127, up: 127, yaw: greedyYaw(vx, true) } : airInput(air, vx));
      if (game.onGround && !wasGround) {
        lands.push({ x: game.ps.origin[0], v: game.ps.velocity[0] });
      }
      wasGround = game.onGround;
    }
    // The first landing past the edge is hop 1's landing; its takeoff is the landing before it.
    const first = lands.findIndex((l) => l.x > EDGE);
    if (first < 1 || lands.length < first + 8) {
      throw new Error(`chain at air ${String(air)} did not make eight hops past the edge`);
    }
    out = [];
    const next: number[] = [];
    for (let k = 0; k < 8; k++) {
      const a = lands[first - 1 + k]!;
      const b = lands[first + k]!;
      out.push({ v: b.v, h: Math.round(b.x - a.x), drop: DROPS[k]! });
      next.push(Math.round(a.x + 24));
    }
    const moved = next.some((s, k) => Math.abs(s - steps[k]!) > 1);
    steps = next;
    if (!moved) {
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lines on a layout
// ---------------------------------------------------------------------------

interface Result {
  ok: boolean;
  /** Landing origin past each island's near edge, and the speed there. */
  lands: { i: number; dx: number; v: number }[];
  failedFrom: number;
  brakeFrames: number;
  coastFrames: number;
  /** Islands where the chained hop could not be aimed and the pilot ran to the edge instead (a throttle). */
  edgeFallbacks: number;
  /** Where it ended when not ok. */
  where: string;
}

type Style = 'pilot' | 'chain' | 'edge';

interface Line {
  style: Style;
  air: Air;
  /** pilot/chain: frames after the landing frame to press jump. edge: frames before the last grounded frame. */
  n: number;
  /** pilot: half-width of the aim window on each island. */
  tol?: number;
  /** chain: x of the first jump (the runway phase). */
  startHop?: number;
  /** Print every hop decision. */
  trace?: boolean;
}

function platforms(islands: readonly Island[]): Island[] {
  return [{ name: 'I0', x0: RUNWAY_X0, x1: EDGE, top: 0 }, ...islands, { name: 'station', x0: STATION_X0, x1: STATION_X1, top: STATION_TOP }];
}

function centre(p: Island): number {
  return p.name === 'station' ? p.x0 + 60 : (p.x0 + p.x1) / 2;
}

function run(world: CollisionModel, islands: readonly Island[], line: Line): Result {
  const P = platforms(islands);
  const game = new Game({ world, origin: SPAWN, axisLock: LOCK });
  for (let i = 0; i < 30; i++) {
    game.step({ yaw: 0 });
  }
  const tol = line.tol ?? 24;
  const lands: Result['lands'] = [];
  let cur = 0;
  let wasGround = true;
  let groundFrames = 0;
  let targetX = Number.NaN;
  let targetTop = 0;
  let brakeFrames = 0;
  let coastFrames = 0;
  let edgeFallbacks = 0;
  let jumped = false;
  const feet = (): number => game.ps.origin[2] - 24;
  const under = (): number => P.findIndex((p) => game.ps.origin[0] >= p.x0 - 15 && game.ps.origin[0] <= p.x1 + 15 && Math.abs(feet() - p.top) < 2);
  for (let f = 0; f < 8000; f++) {
    const vx = game.ps.velocity[0];
    const px = game.ps.origin[0];
    let input: GameInput;
    if (game.onGround) {
      const p = P[cur]!;
      const next = P[cur + 1]!;
      const atEdge = px + vx * DT * (1 + (line.style === 'edge' ? line.n : 0)) > p.x1 + 15 - 0.5;
      let hop = false;
      if (line.style === 'edge') {
        hop = atEdge;
      } else if (line.style === 'chain') {
        hop = cur > 0 ? groundFrames >= line.n : px >= (line.startHop ?? SPAWN[0]) && groundFrames >= line.n && vx >= 200;
        hop ||= atEdge;
      } else if (groundFrames >= line.n && (cur > 0 || vx >= 200)) {
        // pilot: where would a hop from here come down, and can it be aimed
        // onto the next platform? The box reaches 15 past the origin and the
        // 18-unit step-up catches a landing a little short of the near edge.
        const t = airtime(feet() + 0.125, 270, next.top);
        const n = t / DT;
        const pred = px + vx * t;
        const brake = (pm_airaccelerate * DT * DEFAULT_SPEED * DT * n * (n + 1)) / 2;
        const gainAuth = (airGain(line.air, vx) * DT * n * (n + 1)) / 2;
        const aimable = pred + gainAuth >= next.x0 - 15 - 12 && pred - brake <= next.x1 + 15 - 8;
        if (aimable) {
          targetX = centre(next);
          targetTop = next.top;
          hop = true;
        } else if (cur === 0) {
          // The runway: gain freely while the hop stays on it; the hop that
          // would leave it is aimed at AIM_X if braking can hold it there,
          // and otherwise the phase is wrong and the pilot runs to the edge.
          const tl = airtime(feet() + 0.125, 270, 0);
          const nl = tl / DT;
          const brakeL = (pm_airaccelerate * DT * DEFAULT_SPEED * DT * nl * (nl + 1)) / 2;
          const hFull = vx * tl + (airGain(line.air, vx) * DT * nl * (nl + 1)) / 2;
          targetTop = 0;
          if (px + hFull <= EDGE - 15) {
            // Two hops ahead: if the next full hop could not be braked onto
            // the runway and this one is not the aim hop, set the phase now:
            // land this hop at AIM_X - hFull, or take a ground step first
            // when that is more than braking can shorten it.
            const h1 = px + hFull;
            if (h1 + hFull - brakeL > EDGE - 15 && h1 < AIM_X - tol) {
              const want = AIM_X - hFull;
              if (want >= px + vx * tl - brakeL) {
                targetX = want;
                hop = true;
              } else {
                hop = false;
                targetX = Number.NaN;
              }
            } else {
              targetX = px + 10000;
              hop = true;
            }
          } else if (px + vx * tl - brakeL <= EDGE - 15) {
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
      if (line.trace && hop) {
        console.log(`    hop from ${P[cur]!.name} x ${px.toFixed(0)} vx ${vx} feet ${feet().toFixed(2)} target ${targetX.toFixed(0)} top ${targetTop} groundFrames ${groundFrames}`);
      }
      jumped = hop;
    } else if (line.style === 'pilot' && jumped && !Number.isNaN(targetX)) {
      const t = airtime(feet(), game.ps.velocity[2], targetTop);
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
    game.step(input);
    if (game.onGround) {
      groundFrames = wasGround ? groundFrames + 1 : 0;
      if (!wasGround) {
        const i = under();
        if (i > cur) {
          lands.push({ i, dx: Math.round(game.ps.origin[0] - P[i]!.x0), v: game.ps.velocity[0] });
          if (line.trace) {
            console.log(`    landed ${P[i]!.name}+${Math.round(game.ps.origin[0] - P[i]!.x0)} at ${game.ps.velocity[0]} ups`);
          }
          cur = i;
          if (i === P.length - 1) {
            return { ok: true, lands, failedFrom: cur, brakeFrames, coastFrames, edgeFallbacks, where: '' };
          }
        } else if (i < cur) {
          return { ok: false, lands, failedFrom: cur, brakeFrames, coastFrames, edgeFallbacks, where: `landed on ${i < 0 ? 'nothing known' : P[i]!.name} at x ${game.ps.origin[0].toFixed(0)}` };
        }
      }
    }
    if (feet() < Math.min(P[cur]!.top, P[Math.min(cur + 1, P.length - 1)]!.top) - 200) {
      return { ok: false, lands, failedFrom: cur, brakeFrames, coastFrames, edgeFallbacks, where: `fell at x ${px.toFixed(0)}` };
    }
    wasGround = game.onGround;
  }
  return { ok: false, lands, failedFrom: cur, brakeFrames, coastFrames, edgeFallbacks, where: 'timed out' };
}

function describe(r: Result, P: readonly Island[]): string {
  const l = r.lands.map((l) => `${P[l.i]!.name}+${l.dx}@${l.v}`).join(' ');
  const vmin = r.lands.length ? Math.min(...r.lands.map((l) => l.v)) : 0;
  return `${r.ok ? `lands all, slowest landing ${vmin}` : `fails off ${P[r.failedFrom]!.name} (${r.where})`}: ${l || 'nothing'}${r.brakeFrames || r.coastFrames || r.edgeFallbacks ? ` [brake ${r.brakeFrames} coast ${r.coastFrames} frames, ${r.edgeFallbacks} edge fallbacks]` : ''}`;
}

/** Best jump from rest on island k over the gap to k+1: greedy run, hop swept, air greedy or 54. */
function fromRest(world: CollisionModel, P: readonly Island[], k: number): boolean {
  const from = P[k]!;
  const to = P[k + 1]!;
  for (const air of ['greedy', 54] as const) {
    for (let hop = from.x0 + 16; hop <= from.x1 + 16; hop += 16) {
      const game = new Game({ world, origin: [from.x0 + 16, 0, from.top + 25], axisLock: LOCK });
      for (let i = 0; i < 30; i++) {
        game.step({ yaw: 0 });
      }
      let jumped = false;
      let wasGround = true;
      for (let f = 0; f < 1500; f++) {
        const vx = game.ps.velocity[0];
        const px = game.ps.origin[0];
        let input: GameInput;
        if (game.onGround) {
          const want: boolean = !jumped && (px >= hop || px + vx * DT > from.x1 + 15 - 0.5);
          input = { forward: 127, yaw: greedyYaw(vx, true), ...(want ? { up: 127 } : {}) };
          jumped ||= want;
        } else {
          input = airInput(air, vx);
        }
        game.step(input);
        const feet = game.ps.origin[2] - 24;
        if (jumped && game.onGround && !wasGround) {
          if (game.ps.origin[0] >= to.x0 - 15 && Math.abs(feet - to.top) < 2) {
            return true;
          }
          if (game.ps.origin[0] <= from.x1 + 15) {
            jumped = false;
          } else {
            break;
          }
        }
        if (feet < to.top - 200) {
          break;
        }
        wasGround = game.onGround;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Layout from a cruise
// ---------------------------------------------------------------------------

function layoutFrom(h: readonly Hop[]): { islands: Island[]; scale: number } {
  // The chain's eight hops run from the runway takeoff at AIM_X to a landing
  // 60 inside the station; scale the measured hops to fit that sum exactly.
  const want = STATION_X0 + 60 - AIM_X;
  const sum = h.reduce((s, x) => s + x.h, 0);
  const scale = want / sum;
  const islands: Island[] = [];
  let c = AIM_X;
  let top = 0;
  for (let k = 0; k < 7; k++) {
    c += h[k]!.h * scale;
    top -= DROPS[k]!;
    const x0 = Math.round((c - L / 2) / 2) * 2;
    islands.push({ name: `I${k + 1}`, x0, x1: x0 + L, top });
  }
  return { islands, scale };
}

function gapsOf(P: readonly Island[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < P.length; i++) {
    out.push(P[i]!.x0 - P[i - 1]!.x1);
  }
  return out;
}

function main(): void {
  const argv = process.argv.slice(2);
  const cruiseArg = argv.indexOf('--cruise');
  const cruise: Air = cruiseArg >= 0 ? Number(argv[cruiseArg + 1]) : 58;

  console.log(`hops of a pure chain (jump on every landing) from the spawn, floor stepping down ${DROPS.join('/')}: landing speed / hop length`);
  const table = new Map<string, Hop[]>();
  for (const air of [54, 56, 58, 60, 62, 'greedy'] as const) {
    const h = hops(air);
    table.set(String(air), h);
    console.log(`  air ${String(air).padEnd(6)} ${h.map((x) => `${x.v}/${x.h}`).join('  ')}  sum ${h.reduce((s, x) => s + x.h, 0)}`);
  }
  const want = STATION_X0 + 60 - AIM_X;
  console.log(`  the eight hops must sum to ${want} (takeoff at ${AIM_X}, landing 60 inside the station)`);

  const ref = table.get(String(cruise));
  if (!ref) {
    throw new Error(`no hops measured for air ${String(cruise)}`);
  }
  const { islands, scale } = layoutFrom(ref);
  const P = platforms(islands);
  console.log(`\nlayout from air yaw ${String(cruise)} (hops scaled by ${scale.toFixed(3)}, so the cruise is ~${Math.round(ref[3]!.v * scale)} ups):`);
  for (const p of islands) {
    console.log(`  ${p.name}  x ${p.x0}..${p.x1}  top ${p.top}`);
  }
  const g = gapsOf(P);
  console.log(`  gaps ${g.map((w, i) => `G${i + 1} ${w}`).join(', ')}  ${g.every((w, i) => i === 0 || w > g[i - 1]!) ? 'strictly increasing' : 'NOT strictly increasing'}`);
  const world = islandWorld(islands);

  if (argv.includes('--trace')) {
    for (const n of [0, 1]) {
      console.log(`\ntrace: pilot air 58 late ${n}`);
      console.log(`  ${describe(run(world, islands, { style: 'pilot', air: 58, n, trace: true }), P)}`);
    }
    return;
  }
  console.log('\nmomentum pilots (hop on landing, aim each hop at the next island centre by gaining, coasting or braking):');
  for (const air of [54, 56, 58, 60, 62, 'greedy'] as const) {
    for (const n of [0, 1, 2]) {
      const r = run(world, islands, { style: 'pilot', air, n });
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} air ${String(air).padEnd(6)} late ${n}: ${describe(r, P)}`);
    }
  }

  console.log('\npure chains (no aiming), first jump swept along the runway: start x that land all eight');
  for (const air of [56, 58, 60, 'greedy'] as const) {
    const good: number[] = [];
    for (let s = -1184; s < 240; s += 16) {
      if (run(world, islands, { style: 'chain', air, n: 0, startHop: s }).ok) {
        good.push(s);
      }
    }
    console.log(`  air ${String(air).padEnd(6)}: ${good.length ? `${good.length} of ${Math.ceil((240 + 1184) / 16)} starts land all (${good[0]}..${good[good.length - 1]})` : 'none'}`);
  }

  console.log('\nedge jumps (run to every edge with the turned view, jump there, constant air yaw):');
  for (const air of [50, 54, 60, 'greedy', 'none'] as const) {
    for (const n of [0, 3, 6]) {
      const r = run(world, islands, { style: 'edge', air, n });
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} air ${String(air).padEnd(6)} ${n} early: ${describe(r, P)}`);
    }
  }
  console.log('\nno air strafing, jump on every landing:');
  const nc = run(world, islands, { style: 'chain', air: 'none', n: 0, startHop: -1184 });
  console.log(`  ${describe(nc, P)}`);

  console.log('\nfrom REST on each island, best strafed jump over the next gap:');
  console.log(`  ${islands.map((_, k) => `G${k + 2} ${fromRest(world, P, k + 1) ? 'crossable' : 'not'}`).join(', ')}`);
}

main();
