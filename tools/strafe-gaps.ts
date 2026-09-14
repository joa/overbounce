/**
 * Ground strafe-jump gap table under a course's y-axis lock.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run strafe-gaps
 *   npm run strafe-gaps -- --quick        # fewer runway lengths
 *   npm run strafe-gaps -- --saturation   # constant-yaw chains: speed and hop per hop
 *   npm run strafe-gaps -- --edge         # the edge-jump strafe window on a 112 island, by drop
 *
 * WHY THIS EXISTS
 *
 * "Width never gates a jump" is true in the limit (strafe speed is uncapped),
 * but a gap IS a strafe-jump test when the runway in front of it is bounded:
 * the plain run falls short and a strafe chain from that same runway crosses.
 * Designing one needs the two numbers for each runway length, and neither was
 * in `.agent/docs/physics-for-map-authors.md` (section 7 is pad air-strafe,
 * which starts from a pad's velocity, not from rest).
 *
 * Everything here runs through the full `Game` with `axisLock` y=0 -- the same
 * lock every ob_* course's .cam declares -- on a two-brush world: a runway of
 * length L ending at an edge (a wall behind the start, so L really bounds it),
 * a pit, and a landing platform W further on at a height difference h. The gap
 * W is found by bisection for each input model.
 *
 * THE INPUT MODELS -- "max effort" means the best of these, and nothing more:
 *
 *   plain   forward held, view straight (yaw 0), jump at the edge.
 *   run40   forward held on the ground with the view turned to maximise ground
 *           speed (greedy, below), jump at the edge, no air strafing. The lock
 *           discards the y component of the wish direction, so a turned view
 *           holds a STEADY ground speed near 399 (yaw 40) instead of 320:
 *           this is the no-jump-technique baseline on a locked course.
 *   chain   the greedy ground run until x_hop (swept across the runway), then
 *           a bunny-hop chain: jump on every grounded frame, and in the air the
 *           view yaw that maximises this frame's snapped x gain. Also tried
 *           with the per-tick optimal angle `test/game/axis-lock.test.ts`'s
 *           `strafeJumpGame` uses (forward+right, theta from acos), and with
 *           a constant air yaw of 54. The best wins.
 *
 * The greedy controller is analytic: `PM_Accelerate` with the y component
 * thrown away by the lock is `vx += c * min(accel, wishspeed - vx*c)` with
 * c = cos(yaw), then `SnapVector` rounds, so it picks the integer yaw with the
 * largest rounded gain (ties to the larger yaw, which leaves a higher cap).
 * It is a model of a very good player, not a proof of the optimum; a
 * tool-assisted input could beat it by a few units. Say so wherever a number
 * from here decides a gap.
 */

import { pathToFileURL } from 'node:url';
import { axialBrush } from '../src/collision/brush.js';
import { brushListModel } from '../src/collision/model.js';
import { CONTENTS_SOLID, DEFAULT_SPEED, PMOVE_MSEC, pm_accelerate, pm_airaccelerate } from '../src/physics/constants.js';
import { Game } from '../src/game/game.js';
import type { GameInput } from '../src/game/game.js';

const DT = PMOVE_MSEC / 1000;
const RAD = Math.PI / 180;
const LOCK = { axis: 1 as const, value: 0 };

/** One frame's snapped x gain for a forward-held wish direction at `yaw`. */
function gain(vx: number, yaw: number, accel: number): number {
  const c = Math.cos(yaw * RAD);
  const add = DEFAULT_SPEED - vx * c;
  if (add <= 0) {
    return 0;
  }
  const a = Math.min(accel * DT * DEFAULT_SPEED, add);
  return Math.round(vx + a * c) - vx;
}

/** The integer yaw in 0..89 with the largest rounded gain; ties to the larger yaw. */
export function greedyYaw(vx: number, onGround: boolean): number {
  // On the ground friction comes off first (PM_Friction runs before
  // PM_WalkMove), so the gain is judged against the post-friction speed.
  let v = vx;
  if (onGround) {
    const control = Math.max(Math.abs(v), 100);
    const newspeed = Math.max(0, Math.abs(v) - control * 6 * DT);
    v = Math.abs(v) > 0 ? (v * newspeed) / Math.abs(v) : 0;
  }
  const accel = onGround ? pm_accelerate : pm_airaccelerate;
  let best = 0;
  let bestGain = -Infinity;
  for (let yaw = 0; yaw < 90; yaw++) {
    const g = gain(v, yaw, accel);
    if (g >= bestGain) {
      bestGain = g;
      best = yaw;
    }
  }
  return best;
}

type AirModel = 'greedy' | 'theta' | 'none' | 45 | 50 | 54 | 60;

function airInput(game: Game, model: AirModel, up: boolean): GameInput {
  const vx = game.ps.velocity[0];
  const jump = up ? { up: 127 } : {};
  if (model === 'none') {
    return { forward: 127, yaw: 0, ...jump };
  }
  if (model === 'greedy') {
    return { forward: 127, yaw: greedyYaw(vx, false), ...jump };
  }
  if (model === 'theta') {
    const wish = DEFAULT_SPEED;
    const accelPerFrame = pm_airaccelerate * DT * wish;
    const theta = vx > wish - accelPerFrame ? Math.acos((wish - accelPerFrame) / vx) / RAD : 0;
    return { forward: 127, right: 127, yaw: -theta + 45, ...jump };
  }
  return { forward: 127, yaw: model, ...jump };
}

interface Attempt {
  /** Ground run style before the first jump. */
  ground: 'plain' | 'greedy';
  /** x at which the first jump is pressed; null = at the edge (last grounded frame). */
  hopAt: number | null;
  air: AirModel;
  /** Keep hopping on every landing (true) or jump once (false). */
  chain: boolean;
}

interface Outcome {
  ok: boolean;
  /** Horizontal speed on the frame of the jump that left the runway. */
  takeoff: number;
}

/**
 * Runway x in [-L, 0], top 0; wall behind the start; landing platform from
 * W on, top h. Player starts at rest centred 16 in front of the wall.
 */
function attempt(L: number, W: number, h: number, a: Attempt): Outcome {
  const world = brushListModel([
    axialBrush([-L - 64, -512, -1024], [0, 512, 0], CONTENTS_SOLID),
    axialBrush([-L - 128, -512, -1024], [-L, 512, 512], CONTENTS_SOLID),
    axialBrush([W, -512, -1024], [W + 6000, 512, h], CONTENTS_SOLID),
  ]);
  const game = new Game({ world, origin: [-L + 16, 0, 24.125 + 1], axisLock: LOCK });
  for (let i = 0; i < 30; i++) {
    game.step({ yaw: 0 });
  }
  let jumped = false;
  let takeoff = 0;
  for (let i = 0; i < 2000; i++) {
    const x = game.ps.origin[0];
    const vx = game.ps.velocity[0];
    const onGround = game.onGround;
    let input: GameInput;
    if (!jumped) {
      // The edge jump: press on the last frame whose END position still has
      // the box over the runway (centre within 15 of the edge).
      const wantHop = a.hopAt === null ? x + vx * DT > 15 - 0.5 : x >= a.hopAt;
      const yaw = a.ground === 'plain' ? 0 : greedyYaw(vx, onGround);
      input = { forward: 127, yaw, ...(wantHop && onGround ? { up: 127 } : {}) };
      if (wantHop && onGround) {
        jumped = true;
      }
    } else {
      input = onGround
        ? a.chain
          ? { forward: 127, up: 127, yaw: greedyYaw(vx, true) }
          : { forward: 127, yaw: 0 }
        : airInput(game, a.air, false);
    }
    game.step(input);
    if (jumped && takeoff === 0 && !game.onGround) {
      takeoff = Math.abs(game.ps.velocity[0]);
    }
    const feet = game.ps.origin[2] - 24;
    if (game.onGround && game.ps.origin[0] >= W - 15 && Math.abs(feet - (h + 0.125)) < 0.5) {
      return { ok: true, takeoff };
    }
    if (feet < Math.min(0, h) - 96) {
      return { ok: false, takeoff };
    }
    if (game.onGround && game.ps.origin[0] < W - 15 && jumped && !a.chain && i > 20 && feet < 1) {
      // Landed back on the runway (a short jump taken early): a single jump failed.
      return { ok: false, takeoff };
    }
  }
  return { ok: false, takeoff };
}

/**
 * Widest gap `a` crosses, by bisection over integer widths. For a raised
 * landing a gap of 0 is a wall at the edge that blocks the jump, so the
 * search starts from the first width (in steps of 8) that does succeed.
 */
function widest(L: number, h: number, a: Attempt): { W: number; takeoff: number } {
  let lo = -1;
  for (let W = 0; W <= 480; W += 8) {
    if (attempt(L, W, h, a).ok) {
      lo = W;
      break;
    }
  }
  let hi = 1600;
  let takeoff = 0;
  if (lo < 0) {
    return { W: -1, takeoff: 0 };
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const r = attempt(L, mid, h, a);
    if (r.ok) {
      lo = mid;
      takeoff = r.takeoff;
    } else {
      hi = mid;
    }
  }
  return { W: lo, takeoff };
}

function best(L: number, h: number): { plain: number; run40: number; chain: number; chainTakeoff: number; how: string } {
  const plain = widest(L, h, { ground: 'plain', hopAt: null, air: 'none', chain: false }).W;
  const run40 = widest(L, h, { ground: 'greedy', hopAt: null, air: 'none', chain: false }).W;
  let chain = -1;
  let chainTakeoff = 0;
  let how = '';
  const airs: AirModel[] = ['greedy', 'theta', 54];
  const starts: (number | null)[] = [null];
  for (let x = -L + 16; x < 0; x += 32) {
    starts.push(x);
  }
  for (const air of airs) {
    for (const hopAt of starts) {
      const r = widest(L, h, { ground: 'greedy', hopAt, air, chain: true });
      if (r.W > chain) {
        chain = r.W;
        chainTakeoff = r.takeoff;
        how = `air ${air}, first hop ${hopAt === null ? 'at the edge' : `at x=${hopAt}`}`;
      }
    }
  }
  return { plain, run40, chain, chainTakeoff, how };
}

/**
 * A single jump at a carried speed: the player drops the last unit onto the
 * runway with horizontal speed v and jumps on the first grounded frame, the
 * way a chained landing does -- `PM_CheckJump` runs before `PM_Friction` in
 * `PM_WalkMove`, so that jump loses nothing. The takeoff x is found on an
 * unbounded floor first, and the runway's edge is then put 15 past it (the
 * box still overlaps the runway there), so the gap is measured edge to edge.
 */
function carried(v: number, h: number, air: AirModel): number {
  const start: [number, number, number] = [-4096, 0, 24.125 + 1];
  const fly = (world: ReturnType<typeof brushListModel>, W: number | null): { ok: boolean; jumpX: number } => {
    const game = new Game({ world, origin: start, velocity: [v, 0, 0], axisLock: LOCK });
    let jumpX = Number.NaN;
    for (let i = 0; i < 2400; i++) {
      if (Number.isNaN(jumpX)) {
        if (game.onGround) {
          jumpX = game.ps.origin[0];
          game.step({ forward: 127, up: 127, yaw: 0 });
          if (W === null) {
            return { ok: true, jumpX };
          }
        } else {
          game.step({ yaw: 0 });
        }
        continue;
      }
      game.step(airInput(game, air, false));
      const feet = game.ps.origin[2] - 24;
      if (game.onGround && W !== null && game.ps.origin[0] >= W - 15 && Math.abs(feet - (h + 0.125)) < 0.5) {
        return { ok: true, jumpX };
      }
      if (feet < Math.min(0, h) - 96) {
        return { ok: false, jumpX };
      }
    }
    return { ok: false, jumpX };
  };
  const floor = brushListModel([axialBrush([-8192, -512, -1024], [8192, 512, 0], CONTENTS_SOLID)]);
  const edge = fly(floor, null).jumpX + 15;
  const ok = (gap: number): boolean => {
    const world = brushListModel([
      axialBrush([-8192, -512, -1024], [edge, 512, 0], CONTENTS_SOLID),
      axialBrush([edge + gap, -512, -1024], [edge + gap + 6000, 512, h], CONTENTS_SOLID),
    ]);
    return fly(world, edge + gap).ok;
  };
  let lo = -1;
  for (let gap = 0; gap <= 480; gap += 8) {
    if (ok(gap)) {
      lo = gap;
      break;
    }
  }
  if (lo < 0) {
    return -1;
  }
  let hi = 2000;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * A bunny-hop chain with the air view held at a CONSTANT yaw (or the greedy
 * yaw), jumping on every landing, from a 400 ups start on an unbounded floor.
 * Prints the landing speed and the origin-to-origin hop length of each hop:
 * a constant yaw saturates in one hop (the snapped gain stops at 320/cos yaw),
 * the greedy yaw keeps growing. Written for ob_strafes (section 8).
 */
function saturation(): void {
  console.log('\nChain on the level, jump on every landing, from 400 ups: landing speed and hop length per hop');
  const flat = brushListModel([axialBrush([-100000, -512, -64], [100000, 512, 0], CONTENTS_SOLID)]);
  for (const air of ['none', 45, 54, 60, 'greedy'] as const) {
    const game = new Game({ world: flat, origin: [0, 0, 25.125], velocity: [400, 0, 0], axisLock: LOCK });
    const hops: string[] = [];
    let jumpX = 0;
    let wasGround = false;
    for (let i = 0; i < 6000 && hops.length < 8; i++) {
      const vx = game.ps.velocity[0];
      if (game.onGround && !wasGround && i > 2) {
        hops.push(`${vx}/${Math.round(game.ps.origin[0] - jumpX)}`);
      }
      wasGround = game.onGround;
      if (game.onGround) {
        jumpX = game.ps.origin[0];
        game.step({ forward: 127, up: 127, yaw: 0 });
      } else {
        game.step(airInput(game, air, false));
      }
    }
    console.log(`  air ${String(air).padEnd(6)} speed/hop: ${hops.join('  ')}`);
  }
}

/**
 * The strafe window on a short island: arrive on an island L long at 543 ups
 * (a yaw-54 landing), run to its edge with the turned view, jump `early`
 * frames before the last grounded frame, fly with `air`, land `drop` lower.
 * Widest gap by bisection. Written for ob_strafes (section 8).
 */
function edgeWidest(L: number, drop: number, air: AirModel, early: number): number {
  const ok = (G: number): boolean => {
    const world = brushListModel([
      axialBrush([0, -512, -1024], [L, 512, 0], CONTENTS_SOLID),
      axialBrush([L + G, -512, -1024], [L + G + 3000, 512, -drop], CONTENTS_SOLID),
    ]);
    const game = new Game({ world, origin: [9, 0, 32], velocity: [543, 0, -300], axisLock: LOCK });
    let jumped = false;
    for (let i = 0; i < 3000; i++) {
      const x = game.ps.origin[0];
      const vx = game.ps.velocity[0];
      if (!jumped) {
        const want = game.onGround && x + vx * DT * (1 + early) > L + 15 - 0.5;
        game.step({ forward: 127, yaw: greedyYaw(vx, game.onGround), ...(want ? { up: 127 } : {}) });
        jumped = want;
      } else {
        game.step(airInput(game, air, false));
      }
      const feet = game.ps.origin[2] - 24;
      if (jumped && game.onGround && game.ps.origin[0] > L + G - 15 && Math.abs(feet + drop - 0.125) < 1) {
        return true;
      }
      if (feet < -drop - 64) {
        return false;
      }
    }
    return false;
  };
  let lo = 100;
  let hi = 800;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function edgeWindow(): void {
  console.log('\nIsland 112 long, arrive at 543, turned-view run, jump at the edge (eN = N frames early), widest gap by drop:');
  console.log('  drop   none  54e0  54e6    50    60  greedy');
  for (const drop of [0, 16, 32, 48, 64, 80, 96]) {
    const cols = [
      edgeWidest(112, drop, 'none', 0),
      edgeWidest(112, drop, 54, 0),
      edgeWidest(112, drop, 54, 6),
      edgeWidest(112, drop, 50, 0),
      edgeWidest(112, drop, 60, 0),
      edgeWidest(112, drop, 'greedy', 0),
    ];
    console.log(`  ${String(drop).padStart(4)}  ${cols.map((c) => String(c).padStart(5)).join(' ')}`);
  }
}

function main(): void {
  const quick = process.argv.includes('--quick');
  if (process.argv.includes('--saturation') || process.argv.includes('--edge')) {
    if (process.argv.includes('--saturation')) {
      saturation();
    }
    if (process.argv.includes('--edge')) {
      edgeWindow();
    }
    return;
  }

  console.log('Ground run under the y lock, forward held, view at yaw (steady state from rest):');
  console.log('  yaw  steady vx   (forward+right at yaw+45 gives)');
  const flat = brushListModel([axialBrush([-100000, -512, -64], [100000, 512, 0], CONTENTS_SOLID)]);
  for (const yaw of [0, 20, 30, 35, 38, 40, 42, 45, 50, 55, 60]) {
    const a = new Game({ world: flat, origin: [0, 0, 25.125], axisLock: LOCK });
    const b = new Game({ world: flat, origin: [0, 0, 25.125], axisLock: LOCK });
    for (let i = 0; i < 1000; i++) {
      a.step({ forward: 127, yaw });
      b.step({ forward: 127, right: 127, yaw: yaw + 45 });
    }
    console.log(`  ${String(yaw).padStart(3)}  ${String(a.ps.velocity[0]).padStart(9)}   ${b.ps.velocity[0]}`);
  }

  console.log('\nSingle jump at the edge, carried horizontal speed v, air model per column: widest gap (edge to edge)');
  const vs = [320, 400, 500, 600, 700, 800, 900];
  for (const h of [0, 48]) {
    console.log(`  landing ${h >= 0 ? '+' : ''}${h}:   v   none  greedy`);
    for (const v of vs) {
      console.log(`              ${String(v).padStart(3)}  ${String(carried(v, h, 'none')).padStart(5)}  ${String(carried(v, h, 'greedy')).padStart(6)}`);
    }
  }

  const Ls = quick ? [64, 256, 512] : [32, 64, 128, 192, 256, 384, 512, 768, 1024];
  const hs = quick ? [0, 48] : [-64, 0, 32, 48];
  console.log('\nFrom REST on a runway of length L (wall behind), widest gap crossed, edge to edge:');
  console.log('     L     h   plain   run40   chain  (chain takeoff vx, how)');
  for (const L of Ls) {
    for (const h of hs) {
      const r = best(L, h);
      console.log(
        `  ${String(L).padStart(4)}  ${String(h).padStart(4)}  ${String(r.plain).padStart(6)}  ${String(r.run40).padStart(6)}  ${String(r.chain).padStart(6)}  (${r.chainTakeoff}, ${r.how})`,
      );
    }
  }
}

// Only when run, not when `course-checks/` imports `greedyYaw`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
