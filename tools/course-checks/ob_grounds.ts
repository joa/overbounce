/**
 * ob_grounds: replay each obstacle's intended technique -- and each intended
 * failure -- headlessly against the compiled BSP, and report whether the
 * geometry does what `.agent/plans/OB-GROUNDS.md` says it does.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The input models are `tools/strafe-gaps.ts`'s (see its header, and
 * `physics-for-map-authors.md` section 8), so a number printed here and a
 * number in that table mean the same player:
 *
 *  - plain: forward, view straight, jump at the edge.
 *  - run40: the turned-view ground run (a steady ~399 under the y lock), jump
 *    at the edge, no air strafing. The no-technique baseline.
 *  - max effort: the same run, then every air frame the view yaw of the
 *    largest snapped x gain, jumping on every landing. Also tried with the
 *    first hop taken earlier on the runway. A very good player, NOT a proven
 *    optimum.
 *
 * What is asserted, per obstacle:
 *
 *  - Gap A (level since round 3): plain falls short; the run40 jump lands on
 *    the stone; the air-strafe effort is swept and printed.
 *  - The fog gap C: plain and run40 fall short and are rescued to the
 *    section's retry point; max effort lands.
 *  - Gap B (the chain): max effort through A, jumping again on P1's first
 *    grounded frame, lands on P2; the run40 jump onto the stone chained with
 *    full strafing does not, so B still needs strafing on A; a player who stops on P1 and gives it the
 *    best jump from rest is rescued back before gate 1 (a rescue to P1 would
 *    strand them, since gap B cannot be crossed from rest).
 *  - The fog: every failed fog-gap flight is caught before the camera's eye
 *    (feet + 24 + the zone's height) drops below the fog's top plane, which is
 *    what keeps the player readable on the analytic fog path.
 *  - The HOB: a walk-off from the step-normalised ledge at yaw 0, yaw 40 and a
 *    slow creep all land on the lower floor and overbounce (horizontal speed
 *    jumps on the frame after landing). Jumping N frames after landing is swept
 *    and the window that reaches P4 is printed and required; N = 0 (jump on the
 *    landing frame) cancels the bounce and is rescued; the best strafe chain
 *    from rest along the lower floor, with no overbounce, is rescued.
 *  - The start and stop timer gates fire, and the .cam parses.
 */

import type { Game, GameInput } from '../../src/game/game.js';
import { greedyYaw } from '../strafe-gaps.js';
import type { World } from './harness.js';
import { NONE, cameraScript, check, feet, newGame, settle, x } from './harness.js';

/** A walkable top: x range and height. */
interface Platform {
  name: string;
  x0: number;
  x1: number;
  top: number;
}

// ---------------------------------------------------------------------------
// Layout, from the plan's table. Change both together.
// ---------------------------------------------------------------------------

const START: Platform = { name: 'the start courtyard', x0: -1264, x1: 640, top: 0 };
/** Gate 1's ceiling spans x 128..384 over the start courtyard; runway 384..640. */
const GATE1_X = 144;
/** A 32-long stepping stone: too short to build speed on, so gap B needs gap A's. */
const P1: Platform = { name: 'P1 (the stepping stone)', x0: 960, x1: 992, top: 0 };
const P2: Platform = { name: 'P2', x0: 1400, x1: 2448, top: 0 };
/** Gate 2's ceiling spans x 1680..1936 over P2; runway 1936..2448. */
const GATE2_X = 1696;
const P3: Platform = { name: 'P3', x0: 2800, x1: 3440, top: 32 };
/** The fog garden's volume top: 16 under P2 (top 0), 48 under P3 (top 32). */
const FOG_TOP = -16;
/** The side camera's height in the fog zone of scripts/ob_grounds.cam. */
const FOG_CAM_HEIGHT = 150;

// The HOB section: an 8-unit step (x 3312..3440, top 40) under a ceiling at
// z 98 (66 clear before the step, 58 after), a 260 drop, a rescue hole at the foot, the lower floor, the gap.
const LEDGE_EDGE = 3440;
const LEDGE_TOP = 40;
const HOB_DROP = 260;
const HOLE_X1 = 3616;
const LOWER: Platform = { name: 'the lower floor', x0: HOLE_X1, x1: 3856, top: LEDGE_TOP - HOB_DROP };
const P4: Platform = { name: 'P4 (the finish)', x0: 4256, x1: 5520, top: -188 };

const START_GATE_X = -752;
const STOP_GATE_X = 4528;

// ---------------------------------------------------------------------------

function on(p: Platform, atX: number): [number, number, number] {
  return [atX, 0, p.top + 26];
}

function restingOn(game: Game, p: Platform): boolean {
  return x(game) >= p.x0 - 15 && x(game) <= p.x1 + 15 && Math.abs(feet(game) - (p.top + 0.125)) < 0.5;
}

function where(game: Game): string {
  return `x=${x(game).toFixed(0)} feet=${feet(game).toFixed(2)}`;
}

type Air = 'none' | 'greedy';

interface Run {
  /** Came to rest on the named platform at the end. */
  endedOn: string;
  teleported: boolean;
  /** Horizontal speed on the first airborne frame of the jump off the takeoff platform. */
  takeoff: number;
  /** Lowest eye height seen while airborne over a fog pit, before any teleport. */
  minEye: number;
  /**
   * x where the feet last came DOWN through `downAt` (the target's top): for a
   * landing this is how far past the target's edge it came in, for a miss how
   * far short it fell. Null if it never rose above that height.
   */
  downX: number | null;
  game: Game;
}

/**
 * From `origin`, run to `edge` and jump there (the last grounded frame whose
 * box still overlaps the takeoff), then fly. `ground` is the run style, `air`
 * the air control; `chain` jumps again on every landing; `hopAt` presses the
 * first jump earlier, at that x. A chain stops once the player is grounded
 * past `stopPastX` (default: just past `edge`), so a hop that lands back on the
 * runway, or on an intermediate platform, keeps going. Ends at a teleport too.
 */
function jumpRun(
  world: World,
  origin: [number, number, number],
  edge: number,
  opts: {
    ground: 'plain' | 'greedy';
    air: Air;
    chain: boolean;
    hopAt?: number | undefined;
    stopPastX?: number;
    downAt?: number;
    /** Air-strafe only the first N frames of the first flight, then forward at yaw 0; later flights use `air`. */
    airFrames?: number;
  },
  platforms: readonly Platform[],
  camHeight = 0,
): Run {
  const game = newGame(world, origin);
  settle(game);
  const stopPast = opts.stopPastX ?? edge + 15;
  let jumped = false;
  let takeoff = 0;
  let minEye = Infinity;
  let wasGround = true;
  let downX: number | null = null;
  let prevFeet = feet(game);
  let landedOnce = false;
  let flightFrames = 0;
  for (let i = 0; i < 3000; i++) {
    const vx = game.ps.velocity[0];
    let input: GameInput;
    if (!jumped) {
      const at = opts.hopAt ?? edge + 15 - 0.5 - vx * 0.008;
      const want = game.onGround && x(game) >= at;
      input = { forward: 127, yaw: opts.ground === 'plain' ? 0 : greedyYaw(vx, game.onGround), ...(want ? { up: 127 } : {}) };
      if (want) {
        jumped = true;
      }
    } else if (game.onGround) {
      input = opts.chain ? { forward: 127, up: 127, yaw: greedyYaw(vx, true) } : NONE;
    } else if (!landedOnce && opts.airFrames !== undefined) {
      input = flightFrames++ < opts.airFrames ? { forward: 127, yaw: greedyYaw(vx, false) } : { forward: 127, yaw: 0 };
    } else {
      input = opts.air === 'greedy' ? { forward: 127, yaw: greedyYaw(vx, false) } : { forward: 127, yaw: 0 };
    }
    const frame = game.step(input);
    if (jumped && game.onGround && !wasGround) {
      landedOnce = true;
    }
    if (opts.downAt !== undefined && prevFeet > opts.downAt && feet(game) <= opts.downAt && game.ps.velocity[2] <= 0) {
      downX = x(game);
    }
    prevFeet = feet(game);
    if (jumped && !game.onGround) {
      if (takeoff === 0 || x(game) < edge + 15) {
        // The speed of the LAST jump off the takeoff platform.
        if (!wasGround || takeoff === 0) {
          takeoff = wasGround || takeoff === 0 ? Math.abs(game.ps.velocity[0]) : takeoff;
        }
      }
      minEye = Math.min(minEye, feet(game) + 24 + camHeight);
    }
    if (frame.course.some((e) => e.kind === 'teleport')) {
      settle(game);
      return { endedOn: platforms.find((p) => restingOn(game, p))?.name ?? where(game), teleported: true, takeoff, minEye, downX, game };
    }
    if (jumped && game.onGround && !wasGround && (!opts.chain || x(game) > stopPast)) {
      settle(game);
      return { endedOn: platforms.find((p) => restingOn(game, p))?.name ?? where(game), teleported: false, takeoff, minEye, downX, game };
    }
    wasGround = game.onGround;
  }
  return { endedOn: where(game), teleported: false, takeoff, minEye, downX, game };
}

const ALL = (): Platform[] => [START, P1, P2, P3, LOWER, P4];

/**
 * The best a max-effort player gets out of a runway, sweeping the first hop
 * across it. `stopPastX` is where the attempt is judged: for a chain over two
 * gaps it is past the intermediate platform.
 */
function maxEffort(
  world: World,
  origin: [number, number, number],
  edge: number,
  runwayStart: number,
  target: Platform,
  stopPastX?: number,
): Run {
  let best: Run | null = null;
  const hops: (number | undefined)[] = [undefined];
  for (let hx = runwayStart + 16; hx < edge - 64; hx += 32) {
    hops.push(hx);
  }
  for (const hopAt of hops) {
    const r = jumpRun(
      world,
      origin,
      edge,
      { ground: 'greedy', air: 'greedy', chain: true, hopAt, downAt: target.top, ...(stopPastX === undefined ? {} : { stopPastX }) },
      ALL(),
    );
    if (r.endedOn === target.name) {
      return r;
    }
    best ??= r;
  }
  return best!;
}

function gapA(world: World): void {
  console.log('\ngap A (start courtyard -> P1, level, runway 256 out of gate 1): the turned-view run jump');
  const from = on(START, GATE1_X);
  const plain = jumpRun(world, from, START.x1, { ground: 'plain', air: 'none', chain: false, downAt: P1.top }, ALL());
  check(
    plain.teleported && plain.endedOn === START.name,
    'plain jump falls short and is rescued to the start courtyard',
    `takeoff ${plain.takeoff}, came down through the stone's height at x=${plain.downX?.toFixed(0) ?? 'never that high'} (edge ${P1.x0}), ended ${plain.endedOn}`,
  );
  // Level, 320 wide: section 8's table gives run40 341 and max effort 413 from
  // a 256 runway, so the turned-view run jump reaches the 32-long stone and a
  // hard strafe carries past it. Sweep how many air frames are strafed.
  const lands: number[] = [];
  const row: string[] = [];
  for (let k = 0; k <= 100; k += 4) {
    const r = jumpRun(world, from, START.x1, { ground: 'greedy', air: 'none', chain: false, downAt: P1.top, airFrames: k }, ALL());
    const tag = r.endedOn === P1.name && !r.teleported ? 'stone' : r.teleported && r.downX !== null && r.downX > P1.x1 ? 'over' : r.teleported ? 'short' : r.endedOn;
    row.push(`${k}:${tag}@${x(r.game).toFixed(0)}`);
    if (tag === 'stone') {
      lands.push(k);
    }
  }
  console.log(`  info  air frames strafed on gap A -> outcome@rest x (stone 960..992) ${row.join(' ')}`);
  check(lands.includes(0), 'run40 jump (no air strafing) lands on the stone', `strafed frames that land: ${lands.join(',') || 'none'}`);
}

function gapB(world: World): void {
  console.log('\ngap B (the stepping stone -> P2, level): the chain -- carry gap A\'s speed with a jump on P1\'s first grounded frame');
  const r = maxEffort(world, on(START, GATE1_X), START.x1, 384, P2, P1.x1 + 15);
  check(r.endedOn === P2.name && !r.teleported, 'max effort through A and B lands on P2', `came down through P2's height at x=${r.downX?.toFixed(0) ?? '-'} (edge ${P2.x0}), ended ${r.endedOn}`);

  // Which gap-A efforts, chained on the stone's first grounded frame with full
  // air strafing over B, reach P2. Air frames strafed on A, swept.
  const reach: number[] = [];
  const row: string[] = [];
  for (let k = 0; k <= 100; k += 4) {
    const c = jumpRun(world, on(START, GATE1_X), START.x1, { ground: 'greedy', air: 'greedy', chain: true, airFrames: k, stopPastX: P1.x1 + 15, downAt: P2.top }, ALL());
    const tag = c.endedOn === P2.name && !c.teleported ? 'P2' : c.teleported ? 'rescued' : c.endedOn;
    row.push(`${k}:${tag}@${x(c.game).toFixed(0)}`);
    if (tag === 'P2') {
      reach.push(k);
    }
  }
  console.log(`  info  air frames strafed on gap A, then the chain over B -> outcome@rest x (P2 from 1400) ${row.join(' ')}`);
  check(!reach.includes(0), 'the run40 jump onto the stone, chained with full strafing, does not reach P2', row[0] ?? '');
  check(reach.length > 0, 'strafing on gap A as well as B reaches P2', `A strafed frames that reach P2: ${reach.join(',') || 'none'}`);

  const stop = maxEffort(world, on(P1, P1.x0 + 16), P1.x1, P1.x0, P2);
  check(
    stop.teleported && stop.endedOn === START.name,
    'from rest on the stone the best jump falls short and is rescued before gate 1',
    `takeoff ${stop.takeoff}, came down at x=${stop.downX?.toFixed(0) ?? 'never that high'} (edge ${P2.x0}), ended ${stop.endedOn}`,
  );
}

function gapC(world: World): void {
  console.log('\nthe fog garden, gap C (P2 -> P3, runway 512 out of gate 2)');
  const from = on(P2, GATE2_X);
  for (const ground of ['plain', 'greedy'] as const) {
    const r = jumpRun(world, from, P2.x1, { ground, air: 'none', chain: false, downAt: P3.top }, ALL(), FOG_CAM_HEIGHT);
    check(
      r.teleported && r.endedOn === P2.name,
      `${ground === 'plain' ? 'plain' : 'run40'} jump falls into the fog and is rescued to P2`,
      `takeoff ${r.takeoff}, came down through P3's height at x=${r.downX?.toFixed(0) ?? 'never that high'} (edge ${P3.x0}), ended ${r.endedOn}`,
    );
    check(r.minEye > FOG_TOP, 'the camera eye stays above the fog top until the rescue', `lowest eye z=${r.minEye.toFixed(1)}, fog top ${FOG_TOP}`);
  }
  const r = maxEffort(world, from, P2.x1, 1936, P3);
  check(r.endedOn === P3.name && !r.teleported, 'max-effort strafe jump lands on P3', `takeoff ${r.takeoff}, came down at x=${r.downX?.toFixed(0) ?? '-'} (edge ${P3.x0}), ended ${r.endedOn}`);
}

interface HobRun {
  landX: number;
  /** Horizontal speed on the frame after the landing frame. */
  launch: number;
  endedOn: string;
  teleported: boolean;
}

/**
 * Walk from P3 under the ceiling, up the step, off the ledge. `walk` is how;
 * after landing on the lower floor, jump `n` frames after the landing frame
 * (n = 0 presses on the landing frame itself), fly with `air`, and if `chain`
 * keep hopping. `n = null` never jumps (just reports the bounce).
 */
function hobRun(
  world: World,
  walk: 'yaw0' | 'yaw40' | 'creep' | 'hop',
  n: number | null,
  air: Air,
  chain: boolean,
  /**
   * What the player holds through the fall off the ledge: nothing, forward at
   * yaw 0, forward with the view held at 40 (the hint's turned view, not
   * turning), or forward while turning for the most air gain.
   */
  fall: 'none' | 'yaw0' | 'yaw40' | 'greedy' = 'none',
): HobRun {
  const game = newGame(world, on(P3, P3.x0 + 64));
  settle(game);
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
        input = { forward: 127, yaw: greedyYaw(vx, true) };
      } else if (walk === 'hop') {
        // Jump on every grounded frame all the way under the ceilings: the
        // attempt to land on the step with a stray resting height.
        input = { forward: 127, yaw: greedyYaw(vx, true), ...(game.onGround ? { up: 127 } : {}) };
      } else {
        input = x(game) < LEDGE_EDGE - 200 || vx < 20 ? { forward: 127, yaw: 0 } : NONE;
      }
    } else if (landFrame < 0) {
      // In the air off the ledge: touch nothing. The landing frame is the step
      // whose result first reports onGround, so a jump pressed on the NEXT
      // step is n = 0 as pmove sees it -- the landing frame's PM_CheckJump.
      input =
        fall === 'none'
          ? NONE
          : { forward: 127, yaw: fall === 'yaw0' ? 0 : fall === 'yaw40' ? 40 : greedyYaw(vx, false) };
    } else if (!jumped && n !== null && i - landFrame - 1 >= n) {
      input = { forward: 127, up: 127, yaw: 0 };
      jumped = true;
    } else if (!jumped) {
      input = { forward: 127, yaw: greedyYaw(vx, true) };
    } else if (game.onGround) {
      input = chain ? { forward: 127, up: 127, yaw: greedyYaw(vx, true) } : NONE;
    } else {
      input = air === 'greedy' ? { forward: 127, yaw: greedyYaw(vx, false) } : { forward: 127, yaw: 0 };
    }
    const frame = game.step(input);
    if (!left && !game.onGround && x(game) > LEDGE_EDGE - 20) {
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
      return { landX, launch, endedOn: ALL().find((p) => restingOn(game, p))?.name ?? where(game), teleported: true };
    }
    if (n === null && landFrame >= 0 && i > landFrame + 2) {
      return { landX, launch, endedOn: 'not jumped', teleported: false };
    }
    if (jumped && game.onGround && !wasGround && (!chain || restingOn(game, P4))) {
      settle(game);
      return { landX, launch, endedOn: ALL().find((p) => restingOn(game, p))?.name ?? where(game), teleported: false };
    }
    wasGround = game.onGround;
  }
  return { landX, launch, endedOn: where(game), teleported: false };
}

function hob(world: World): void {
  console.log(`
the HOB: step up under the ceiling, walk off a ${HOB_DROP} ledge, jump the instant you land`);
  for (const walk of ['yaw0', 'yaw40', 'hop'] as const) {
    const r = hobRun(world, walk, null, 'none', false);
    check(
      r.landX > LOWER.x0 - 15 && r.landX < LOWER.x1 + 15 && r.launch > 440,
      `walk-off (${walk === 'hop' ? 'hopping all the way under the ceiling' : walk}) lands on the lower floor and overbounces`,
      `landed x=${r.landX.toFixed(0)}, speed on the next frame ${r.launch}`,
    );
  }
  const creepEnd = hobRun(world, 'creep', 1, 'greedy', true);
  check(
    creepEnd.teleported && creepEnd.endedOn === P3.name,
    'a creep-off falls into the hole at the ledge foot and is rescued to P3',
    `ended ${creepEnd.endedOn}`,
  );

  // What the player holds through the fall moves the landing. The lower floor
  // is 240 long (3616..3856); every combination must land on it or be rescued
  // to P3, never end anywhere else, and the table says which lands.
  const unhandled: string[] = [];
  for (const walk of ['yaw0', 'yaw40', 'hop'] as const) {
    const row: string[] = [];
    for (const fall of ['none', 'yaw0', 'yaw40', 'greedy'] as const) {
      const r = hobRun(world, walk, null, 'none', false, fall);
      const landed = r.landX > LOWER.x0 - 15 && r.landX < LOWER.x1 + 15 && r.launch > 440;
      row.push(`${fall}:${landed ? `lands x=${r.landX.toFixed(0)} at ${r.launch}` : r.teleported && r.endedOn === P3.name ? 'rescued' : r.endedOn}`);
      if (!landed && !(r.teleported && r.endedOn === P3.name)) {
        unhandled.push(`${walk}/${fall}`);
      }
    }
    console.log(`  info  walk ${walk}, fall holding  ${row.join('  ')}`);
  }
  check(
    unhandled.length === 0,
    'whatever is held through the fall, the walk-off lands on the lower floor or is rescued to P3',
    unhandled.length === 0 ? 'all 12 handled' : `unhandled: ${unhandled.join(', ')}`,
  );

  const windows: Record<string, number[]> = {};
  for (const [walk, air] of [
    ['yaw40', 'greedy'],
    ['yaw40', 'none'],
    ['yaw0', 'greedy'],
  ] as const) {
    const rows: string[] = [];
    const window: number[] = [];
    for (let n = 0; n <= 24; n++) {
      const r = hobRun(world, walk, n, air, false);
      if (r.endedOn === P4.name) {
        window.push(n);
      }
      rows.push(`${n}:${r.endedOn === P4.name ? 'P4' : r.teleported ? 'rescued' : r.endedOn}`);
    }
    windows[`${walk}/${air}`] = window;
    console.log(`  info  walk ${walk}, air ${air}: ${rows.join(' ')}`);
  }
  const w = windows['yaw40/greedy']!;
  check(w.length >= 4 && !w.includes(0), 'turned-view walk-off, HOB, jump after landing, strafe: reaches P4 for several frames, never on the landing frame', `window N=${w.join(',')}`);
  console.log(`  info  without air strafing: N=${windows['yaw40/none']!.join(',') || 'none'}; from a yaw-0 walk-off: N=${windows['yaw0/greedy']!.join(',') || 'none'}`);

  const cancel = hobRun(world, 'yaw40', 0, 'greedy', true);
  check(cancel.teleported && cancel.endedOn === P3.name, 'jump on the landing frame cancels the bounce; the strafe chain that follows is rescued to P3', `ended ${cancel.endedOn}`);

  const rest = maxEffort(world, on(LOWER, LOWER.x0 + 16), LOWER.x1, LOWER.x0, P4);
  check(rest.teleported && rest.endedOn === P3.name, 'with no overbounce, the best strafe chain along the lower floor is rescued to P3', `takeoff ${rest.takeoff}, came down through P4's height at x=${rest.downX?.toFixed(0) ?? 'never that high'} (edge ${P4.x0}), ended ${rest.endedOn}`);
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
  // Put the running player in front of the stop gate the way respawn writes
  // an origin, then walk into it.
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
  gapA(world);
  gapB(world);
  gapC(world);
  hob(world);
  timers(world);
  cameraScript(
    camPath,
    [
      [-600, 0, 24],
      [600, 0, 24],
      [1200, 0, 56],
      [2600, 0, 56],
      [3400, 0, 96],
      [3740, 0, -164],
      [P4.x0 + 300, 0, P4.top + 24],
    ],
    4,
  );
}
