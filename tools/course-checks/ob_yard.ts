/**
 * ob_yard: replay each obstacle's intended technique headlessly against the
 * compiled BSP and report whether the geometry does what
 * `.agent/plans/OB-YARD.md` says it does.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * What the checks measure:
 *
 *  - Strafe pads: the plain flight (forward held, view straight) must be
 *    rescued; the strafed flight (forward held, view turned 60 degrees, the
 *    +1/frame row of physics-for-map-authors.md section 7) must land on the
 *    next platform. Both are asserted, not just the failure.
 *  - Rocket pads: the fire frame is swept relative to the pad's launch tick,
 *    and the table says which N still reach the target, what the apex was,
 *    and what it cost. N <= 0 (on or before the launch tick) is expected to
 *    FAIL -- the explosion lands while the player still overlaps the trigger
 *    and `BG_TouchJumpPad` overwrites it. The plain flight (no rocket at all)
 *    must be rescued.
 *  - Nothing is clipped on the way up: every winning rise is checked to be
 *    short of the target's edge at the moment the feet pass its height.
 *  - Every failure's rescue lands the player on the platform the plan says,
 *    which is not a given: the slabs are deep and a fast body falls through
 *    them far to the right of where it missed.
 */

import type { Game, GameInput } from '../../src/game/game.js';
import { Weapon } from '../../src/game/weapons.js';
import type { World } from './harness.js';
import {
  FWD,
  FWD_JUMP,
  cameraScript,
  check,
  feet,
  flyUntilGrounded,
  newGame,
  settle,
  walkOntoPad,
  x,
} from './harness.js';

/** Platform tops and x ranges, from the plan's layout table. */
interface Platform {
  name: string;
  x0: number;
  x1: number;
  top: number;
}

const YARD: Platform = { name: 'the yard', x0: -640, x1: 768, top: 0 };
const P1: Platform = { name: 'P1', x0: 1216, x1: 1728, top: 256 };
const P2: Platform = { name: 'P2', x0: 2528, x1: 2944, top: 448 };
const P3: Platform = { name: 'P3', x0: 3808, x1: 4416, top: 384 };
const P4: Platform = { name: 'P4', x0: 4544, x1: 5248, top: 816 };
const P5: Platform = { name: 'P5', x0: 6656, x1: 7680, top: 912 };
const FINISH: Platform = { name: 'the finish yard', x0: 8448, x1: 9472, top: 400 };

/** Where the walk-up to each pad starts (origin z = top + 26 settles onto the top). */
function on(p: Platform, atX: number): [number, number, number] {
  return [atX, 0, p.top + 26];
}

/** Resting on `p`: the box is 30 wide, so its centre may sit 15 outside the edge. */
function restingOn(game: Game, p: Platform): boolean {
  return x(game) >= p.x0 - 15 && x(game) <= p.x1 + 15 && Math.abs(feet(game) - (p.top + 0.125)) < 0.5;
}

function where(game: Game): string {
  return `x=${x(game).toFixed(0)} feet=${feet(game).toFixed(2)}`;
}

/** A plain pad: walk on, forward held, land on the next platform. */
function plainPad(world: World, what: string, from: [number, number, number], target: Platform): void {
  console.log(`\n${what}: walk on, forward held, land on ${target.name}`);
  const game = newGame(world, from);
  settle(game);
  walkOntoPad(game);
  const flight = flyUntilGrounded(game, FWD, target.top);
  settle(game);
  check(!flight.teleported, 'never rescued', `apex feet=${flight.apex.toFixed(1)}`);
  check(restingOn(game, target), `came to rest on ${target.name}`, `${where(game)} landed at x=${flight.downX?.toFixed(0) ?? '-'}`);
}

/**
 * A strafe pad flown two ways. `yaw` is held with forward from the launch
 * on; 0 is the plain flight that must fall short, 60 the strafed one.
 */
function strafePad(world: World, what: string, from: [number, number, number], back: Platform, target: Platform): void {
  for (const yaw of [0, 60]) {
    console.log(`\n${what}: forward held with the view at yaw ${yaw} (${yaw ? 'strafed' : 'plain'})`);
    const game = newGame(world, from);
    settle(game);
    walkOntoPad(game);
    const input: GameInput = { forward: 127, yaw };
    const flight = flyUntilGrounded(game, input, target.top);
    settle(game);
    if (yaw === 0) {
      check(
        flight.teleported,
        'plain flight fell short and was rescued',
        `apex feet=${flight.apex.toFixed(1)}, passed landing height at x=${flight.downX?.toFixed(0) ?? '-'} (edge ${target.x0}), met the slab at x=${flight.endX.toFixed(0)}`,
      );
      check(restingOn(game, back), `rescue put the player back on ${back.name}`, where(game));
    } else {
      check(!flight.teleported, 'strafed flight was not rescued', where(game));
      check(
        restingOn(game, target),
        `strafed flight landed on ${target.name}`,
        `${where(game)}, passed landing height at x=${flight.downX?.toFixed(0) ?? '-'} (edge ${target.x0})`,
      );
    }
  }
}

interface RocketRow {
  /** Frames after the launch tick the rocket was fired; NaN for the no-rocket control. */
  n: number;
  apex: number;
  landed: boolean;
  teleported: boolean;
  x: number;
  feet: number;
  /** Health on the launch tick, before any rocket, and at the end. */
  healthAtLaunch: number;
  health: number;
  /** x of the player when the feet first rose past the target top (null: never did). */
  crossX: number | null;
  /** x where the feet came back down through the target top (null: never that high). */
  downX: number | null;
  /** x where the flight ended: touchdown, or the last position before a rescue slab fired. */
  endX: number;
}

/** The frame index (from the first step after settling) on which the pad fires. */
function launchFrame(world: World, from: [number, number, number]): number {
  const game = newGame(world, from, Weapon.ROCKET_LAUNCHER);
  settle(game);
  for (let i = 0; i < 1500; i++) {
    if (game.step({ forward: 127, pitch: 89, yaw: 0 }).course.some((e) => e.kind === 'jumppad')) {
      return i;
    }
  }
  throw new Error('no pad fired');
}

/**
 * `n` is relative to the launch tick: the attack goes into the usercmd of
 * frame L + n, where L is the frame whose course touch fired the pad. n = 0
 * fires on the launch tick itself, negative n before it; both are expected
 * to be overwritten by the pad. `n === null` is the control: no rocket.
 */
function rocketFlight(world: World, from: [number, number, number], target: Platform, n: number | null, L: number): RocketRow {
  const game = newGame(world, from, Weapon.ROCKET_LAUNCHER);
  settle(game);
  let launched = false;
  let sinceLaunch = 0;
  let apex = feet(game);
  let health = 100;
  let healthAtLaunch = 100;
  let landed = false;
  let teleported = false;
  let crossX: number | null = null;
  let downX: number | null = null;
  let prevFeet = feet(game);
  let prevX = x(game);
  for (let i = 0; i < 1500; i++) {
    // Approach looking down already: pitch does not affect walking.
    const fire = n !== null && i === L + n;
    const input: GameInput = fire ? { forward: 127, pitch: 89, yaw: 0, attack: true } : { forward: 127, pitch: 89, yaw: 0 };
    const frame = game.step(input);
    if (!launched) {
      if (frame.course.some((e) => e.kind === 'jumppad')) {
        launched = true;
        healthAtLaunch = frame.health;
        health = frame.health;
      }
      prevFeet = feet(game);
      prevX = x(game);
      continue;
    }
    health = frame.health;
    sinceLaunch++;
    apex = Math.max(apex, feet(game));
    if (crossX === null && feet(game) > target.top && game.ps.velocity[2] > 0) {
      crossX = x(game);
    }
    if (downX === null && prevFeet > target.top && feet(game) <= target.top && game.ps.velocity[2] < 0) {
      downX = x(game);
    }
    prevFeet = feet(game);
    if (frame.course.some((e) => e.kind === 'teleport')) {
      teleported = true;
      break;
    }
    if (game.onGround && sinceLaunch > 5) {
      landed = true;
      prevX = x(game);
      break;
    }
    prevX = x(game);
  }
  const endX = prevX;
  settle(game);
  return { n: n ?? Number.NaN, apex, landed, teleported, x: x(game), feet: feet(game), healthAtLaunch, health, crossX, downX, endX };
}

function onTarget(r: RocketRow, target: Platform): boolean {
  return r.landed && r.x >= target.x0 - 15 && r.x <= target.x1 + 15 && Math.abs(r.feet - (target.top + 0.125)) < 0.5;
}

/** Sweep the fire frame for a rocket pad, from one frame before the launch tick to well past the splash radius. */
function rocketPad(world: World, what: string, from: [number, number, number], back: Platform, target: Platform): void {
  console.log(`\n${what}: fire straight down N frames after the launch tick, forward held; target ${target.name} (top ${target.top})`);
  const L = launchFrame(world, from);
  const plain = rocketFlight(world, from, target, null, L);
  check(
    plain.teleported && !plain.landed,
    'plain flight (no rocket) is rescued',
    `apex feet=${plain.apex.toFixed(1)}, met the slab at x=${plain.endX.toFixed(0)}`,
  );
  check(plain.x >= back.x0 - 15 && plain.x <= back.x1 + 15, `rescue put the player back on ${back.name}`, `x=${plain.x.toFixed(0)}`);

  const rows: RocketRow[] = [];
  for (let n = -1; n <= 14; n++) {
    rows.push(rocketFlight(world, from, target, n, L));
  }
  console.log('     N   apex feet   over plain   result                    cost   rose past top at x   came down through top at x   flight ended at x');
  for (const r of rows) {
    const result = onTarget(r, target) ? `on ${target.name}` : r.teleported ? 'rescued' : `elsewhere (${r.x.toFixed(0)}, ${r.feet.toFixed(1)})`;
    console.log(
      `    ${String(r.n).padStart(2)}   ${r.apex.toFixed(1).padStart(8)}   ${(r.apex - plain.apex).toFixed(1).padStart(10)}   ${result.padEnd(24)} ${(r.healthAtLaunch - r.health).toFixed(0).padStart(5)}   ${(r.crossX === null ? '-' : r.crossX.toFixed(0)).padStart(18)}   ${(r.downX === null ? '-' : r.downX.toFixed(0)).padStart(26)}   ${r.endX.toFixed(0).padStart(17)}`,
    );
  }
  const good = rows.filter((r) => onTarget(r, target));
  const window = good.map((r) => r.n);
  check(
    !onTarget(rows[0]!, target) && !onTarget(rows[1]!, target),
    'a rocket on or before the launch tick is overwritten by the pad (expected)',
  );
  check(window.length >= 6, 'at least 6 frames of fire window', `window=${window.join(',')}`);
  // A hole in the window would mean a clip or an edge case worth seeing.
  const consecutive = window.every((n, i) => i === 0 || n === window[i - 1]! + 1);
  check(consecutive, 'the window is one unbroken run of frames');
  const clearance = good.map((r) => (r.crossX === null ? Infinity : target.x0 - 15 - r.crossX));
  check(
    clearance.every((c) => c > 0),
    'every winning rise passes the target height before reaching its edge',
    `min clearance=${Math.min(...clearance).toFixed(0)}`,
  );
  const rescued = rows.filter((r) => r.teleported);
  check(
    rescued.every((r) => r.x >= back.x0 - 15 && r.x <= back.x1 + 15),
    `every failed attempt is rescued back to ${back.name}`,
    rescued.map((r) => `N${r.n}->x${r.x.toFixed(0)}`).join(' '),
  );
  if (good.length) {
    const costs = good.map((r) => r.healthAtLaunch - r.health);
    const worst = Math.max(...costs);
    console.log(
      `  info  a rocket in the window costs ${Math.min(...costs).toFixed(0)}..${worst.toFixed(0)} health; from a 200 mega that is ${Math.floor(199 / worst)} attempts before dying`,
    );
  }
}

/**
 * The jump-on-landing habit ob_basics teaches, applied to pad A. The landing
 * on P1 is a horizontal overbounce (~780ups), so jumping off it flies clear
 * across the P1->P2 gap and onto P2's near edge -- a real sequence break that
 * skips strafe pad B for a player who can time it. That is fine in a movement
 * game: the requirement is only that the habit never drops the player into
 * the void. So this asserts NOT rescued and landed on P1 or P2, and prints
 * which, rather than pinning them to P1.
 */
function padAWithLandingJump(world: World): void {
  console.log('\npad A with a jump on landing (an overbounce skip, not a rescue)');
  const game = newGame(world, on(YARD, 200));
  settle(game);
  walkOntoPad(game);
  const flight = flyUntilGrounded(game, FWD);
  // The jump, then release everything and see where the overbounce carries.
  game.step(FWD_JUMP);
  const hop = flyUntilGrounded(game, { yaw: 0 });
  settle(game);
  const onP1 = restingOn(game, P1);
  const onP2 = restingOn(game, P2);
  check(
    !flight.teleported && !hop.teleported && (onP1 || onP2),
    'the landing jump advances, never drops into the void',
    `${where(game)} -> ${onP1 ? 'P1' : onP2 ? 'P2 (skipped strafe pad B)' : 'neither'}, hop apex=${hop.apex.toFixed(1)}`,
  );
}

export function run(world: World, camPath: string): void {
  plainPad(world, 'pad A (the yard -> P1)', on(YARD, 200), P1);
  padAWithLandingJump(world);
  strafePad(world, 'strafe pad B (P1 -> P2)', on(P1, 1300), P1, P2);
  strafePad(world, 'strafe pad C (P2 -> P3)', on(P2, 2560), P2, P3);
  rocketPad(world, 'rocket pad 1, the tower (P3 -> P4)', on(P3, 3950), P3, P4);
  rocketPad(world, 'rocket pad 2, the distance (P4 -> P5)', on(P4, 4700), P4, P5);
  plainPad(world, 'final pad (P5 -> the finish yard)', on(P5, 7300), FINISH);

  cameraScript(
    camPath,
    [
      [0, 0, 24],
      [2200, 0, 600],
      [4400, 0, 700],
      [5800, 0, 1300],
      [7000, 0, 936],
      [8100, 0, 700],
      [9000, 0, 424],
    ],
    4,
  );
}
