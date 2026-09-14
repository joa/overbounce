/**
 * ob_strafes: replay each section's intended technique -- and each intended
 * failure -- headlessly against the compiled BSP, and report whether the
 * geometry does what `.agent/plans/OB-STRAFES.md` says it does.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Input models (`physics-for-map-authors.md` sections 8 and 9):
 *
 *  - edge jump, air yaw A, e frames early: on each island run with the turned
 *    view (`greedyYaw`, the ~399 run), press jump e frames before the last
 *    grounded frame whose box still overlaps the island, then hold forward
 *    with the view at yaw A. The MUST-PASS family is A 50/54/60, e 0..6.
 *  - no strafe: the same run and edge jump, view straight in the air.
 *  - chain: jump on every landing instead of running to the edge (info only:
 *    under the lock it wastes the island, section 8).
 *
 * What is asserted:
 *
 *  1. The eight gaps strictly increase (from the layout constants, and every
 *     island top is where the constants say, by standing on it).
 *  2. Through the real spawn hall and teleporter, the must-pass family lands
 *     on all eight islands and the station.
 *  3. (Printed, not asserted: the best jump from rest on each island.)
 *  4. The no-strafe player misses by G3 and is rescued to I0.
 *  5. Huge gap: quad + suit, rocket behind on the jump, lands on the landing
 *     platform for a range of pitches; without quad, even at 1100 ups with
 *     air strafing, every line is rescued to the quad checkpoint.
 *  6. The pit: the plain fall does not overbounce; the double quad rocket
 *     reaches the exit ledge; (a) one quad rocket by any swept line does not;
 *     (b) two plain rockets by any swept line do not; (c) without the suit
 *     the double kills; (d) no launch from a standing surface outside the
 *     shaft (landing platform, tunnel floor, rim) reaches the exit.
 *  7. The retry door returns the player to the checkpoint in front of the
 *     pickups, powerups still running, and a re-pickup adds quad time.
 *  8. The intended line from the quad pickup to the exit fits the 30 s quad.
 */

import type { Game, GameInput } from '../../src/game/game.js';
import { Powerup, WeaponTag } from '../../src/game/items.js';
import { Weapon } from '../../src/game/weapons.js';
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
// Layout, from the plan's table. Change both together.
// ---------------------------------------------------------------------------

const SPAWN: [number, number, number] = [-1184, 0, 25];
const ISLANDS: readonly Platform[] = [
  { name: 'I0', x0: 0, x1: 256, top: 0 },
  { name: 'I1', x0: 556, x1: 668, top: 0 },
  { name: 'I2', x0: 1008, x1: 1120, top: -16 },
  { name: 'I3', x0: 1510, x1: 1622, top: -32 },
  { name: 'I4', x0: 2032, x1: 2144, top: -64 },
  { name: 'I5', x0: 2572, x1: 2684, top: -112 },
  { name: 'I6', x0: 3130, x1: 3242, top: -176 },
  { name: 'I7', x0: 3704, x1: 3816, top: -256 },
  { name: 'the station', x0: 4294, x1: 5574, top: -352 },
];
const I0 = ISLANDS[0]!;
const STATION = ISLANDS[ISLANDS.length - 1]!;
/** The quad checkpoint's teleport destination (x) and the pickups on the running line. */
const RETRY_QUAD_X = 4496;
const QUAD_X = 4992;
/** The landing platform after the huge gap; the tower's -X face; the tunnel ceiling. */
const LANDING: Platform = { name: 'the landing platform', x0: 8134, x1: 9862, top: -352 };
const TOWER_X0 = 9606;
const TUNNEL_CEILING = -64;
const RIM_X = 9862;
const TOWER_X1 = 10054;
/**
 * Round 2: a block hangs from the overhang's pit end (x LINTEL_X0..TOWER_X1)
 * down to this, 72 over the rim (a walking player's head clears it by 16). A
 * quad rocket jump off the rim rises into its -X face and loses its horizontal
 * speed; a roof alone does not stop it, because sliding under a ceiling keeps
 * the upward velocity. The far wall's rock is 64 behind a playerclip face at
 * FLOOR.x1, so a wall shot explodes out of full-knockback range (rockets
 * ignore playerclip).
 */
const LINTEL_X0 = 10000;
const LINTEL_BOTTOM = -280;
// OB_STRAFES_FLOOR_TOP / OB_STRAFES_EXIT_TOP measure an older build of the pit
// (round 1: -1440 and 672) against the same sweeps; the defaults are this build.
const FLOOR: Platform = { name: 'the pit floor', x0: 9798, x1: 10182, top: Number(process.env.OB_STRAFES_FLOOR_TOP ?? -1648) };
const EXIT: Platform = { name: 'the exit ledge', x0: 10182, x1: 10966, top: Number(process.env.OB_STRAFES_EXIT_TOP ?? 252) };
const DEPTH = LANDING.top - FLOOR.top;
const E = EXIT.top - FLOOR.top;
const STOP_X = 10504;

const DT = 0.008;
/**
 * The double's tolerance floor, in (first, second) fire-tick pairs sampled
 * every 2 ticks, for a walk-off at 400 or 900 facing away from the far wall.
 * Round 2 exists because round 1 (D 1088, E 2112) was too tight: its four lines
 * measured 111, 148, 130, 148 pairs with this sweep. 150 is above every one of
 * them, so a build that is not more forgiving than round 1 fails.
 */
const MIN_DOUBLE_PAIRS = 150;
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

interface IslandModel {
  air: Air;
  /** Frames before the last grounded frame the jump is pressed. */
  early: number;
  /** Jump on every landing instead of at the edge. */
  chain?: boolean;
}

interface IslandRun {
  /** Islands landed, by index, with the landing origin's distance past the island's near edge. */
  lands: { i: number; dx: number }[];
  /** Speed on the frame after the hall teleporter fired. */
  exitSpeed: number;
  /** True if the run ended on the station without a rescue. */
  ok: boolean;
  /** Where a rescue put the player (the settled platform), or null. */
  rescuedTo: string | null;
  /** The island index the player was on when the run failed. */
  failedFrom: number;
}

function airYaw(air: Air, vx: number): GameInput {
  if (air === 'none') {
    return { forward: 127, yaw: 0 };
  }
  if (air === 'greedy') {
    return { forward: 127, yaw: greedyYaw(vx, false) };
  }
  return { forward: 127, yaw: air };
}

/** From the spawn, through the start gate and the hall teleporter, then the islands. */
function islandRun(world: World, m: IslandModel): IslandRun {
  const game = newGame(world, SPAWN);
  settle(game);
  let throughHall = false;
  let exitSpeed = 0;
  let speedNext = false;
  let cur = 0;
  let wasGround = true;
  const lands: { i: number; dx: number }[] = [];
  for (let f = 0; f < 6000; f++) {
    const vx = game.ps.velocity[0];
    let input: GameInput;
    if (!throughHall) {
      input = { forward: 127, yaw: 0 };
    } else if (game.onGround) {
      const island = ISLANDS[cur]!;
      const atEdge = x(game) + vx * DT * (1 + m.early) > island.x1 + 15 - 0.5;
      const want = m.chain === true ? cur > 0 || atEdge : atEdge;
      input = { forward: 127, yaw: greedyYaw(vx, true), ...(want ? { up: 127 } : {}) };
    } else {
      input = airYaw(m.air, vx);
    }
    const frame = game.step(input);
    if (speedNext) {
      exitSpeed = Math.abs(game.ps.velocity[0]);
      speedNext = false;
    }
    if (teleported(frame)) {
      if (!throughHall) {
        throughHall = true;
        speedNext = true;
        wasGround = game.onGround;
        continue;
      }
      settle(game);
      return { lands, exitSpeed, ok: false, rescuedTo: ALL.find((p) => restingOn(game, p))?.name ?? where(game), failedFrom: cur };
    }
    if (throughHall && game.onGround && !wasGround) {
      const i = ISLANDS.findIndex((p) => x(game) >= p.x0 - 15 && x(game) <= p.x1 + 15 && Math.abs(feet(game) - p.top) < 2);
      if (i > cur) {
        lands.push({ i, dx: Math.round(x(game) - ISLANDS[i]!.x0) });
        cur = i;
        if (i === ISLANDS.length - 1) {
          return { lands, exitSpeed, ok: true, rescuedTo: null, failedFrom: cur };
        }
      }
    }
    wasGround = game.onGround;
  }
  return { lands, exitSpeed, ok: false, rescuedTo: where(game), failedFrom: cur };
}

function describe(r: IslandRun): string {
  return r.lands.map((l) => `${ISLANDS[l.i]!.name}+${l.dx}`).join(' ');
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
          input = airYaw(air, vx);
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
  console.log('\nthe islands: eight gaps, each wider, landed one after another');
  const g = gaps();
  const increasing = g.every((w, i) => i === 0 || w > g[i - 1]!);
  check(increasing, 'gaps G1..G8 strictly increase', g.map((w, i) => `G${i + 1} ${w}`).join(', '));

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

  const mustPass: IslandModel[] = [];
  for (const air of [50, 54, 60]) {
    for (const early of [0, 3, 6]) {
      mustPass.push({ air, early });
    }
  }
  const minDx: number[] = ISLANDS.map(() => Infinity);
  const maxDx: number[] = ISLANDS.map(() => -Infinity);
  for (const m of mustPass) {
    const r = islandRun(world, m);
    for (const l of r.lands) {
      minDx[l.i] = Math.min(minDx[l.i]!, l.dx);
      maxDx[l.i] = Math.max(maxDx[l.i]!, l.dx);
    }
    check(
      r.ok,
      `must-pass: edge jump, air yaw ${m.air}, ${m.early} frames early -- lands all eight and the station`,
      `teleporter exit ${r.exitSpeed} ups; landed ${describe(r)}${r.ok ? '' : `; rescued to ${r.rescuedTo}`}`,
    );
  }
  console.log(
    `  info  must-pass landing origins past each island's near edge (box reaches from -15): ${ISLANDS.slice(1)
      .map((p, j) => `${p.name} ${minDx[j + 1]}..${maxDx[j + 1]}`)
      .join(', ')}`,
  );

  const plain = islandRun(world, { air: 'none', early: 0 });
  check(
    !plain.ok && plain.failedFrom <= 2 && plain.rescuedTo === I0.name,
    'no air strafing (turned-view run, edge jump, view straight in the air) misses by G3 and is rescued to I0',
    `landed ${describe(plain) || 'nothing'}, failed off ${ISLANDS[plain.failedFrom]!.name}, rescued to ${plain.rescuedTo}`,
  );
  const plainChain = islandRun(world, { air: 'none', early: 0, chain: true });
  check(!plainChain.ok && plainChain.rescuedTo === I0.name, 'no air strafing, jumping the instant you land: rescued to I0', `landed ${describe(plainChain) || 'nothing'}`);

  for (const [what, m] of [
    ['air yaw 45, edge jump', { air: 45, early: 0 }],
    ['greedy air (max effort), edge jump', { air: 'greedy', early: 0 }],
    ['air yaw 54, jump the instant you land', { air: 54, early: 0, chain: true }],
    ['greedy air, jump the instant you land', { air: 'greedy', early: 0, chain: true }],
  ] as const) {
    const r = islandRun(world, m);
    console.log(`  info  ${what}: ${r.ok ? 'lands all' : `fails off ${ISLANDS[r.failedFrom]!.name}`} (${describe(r) || 'nothing'})`);
  }
  const rest: string[] = [];
  for (let k = 1; k < ISLANDS.length - 1; k++) {
    rest.push(`G${k + 1} ${fromRest(world, k).ok ? 'crossable' : 'not'}`);
  }
  console.log(`  info  best jump from REST on the island in front (not asserted, see the plan): ${rest.join(', ')}`);
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
// 5: the huge gap
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
 * ground to model a hot arrival), jump there and fire `delay` frames later at
 * `pitch` with the view turned back. After the shot, `strafe` turns around
 * and air-strafes with the greedy yaw.
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
      input = want ? { up: 127, yaw: 180, pitch, attack: delay === 0 } : { forward: 127, yaw: greedyYaw(vx, game.onGround) };
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
  const good: string[] = [];
  const landXs: number[] = [];
  for (const pitch of [40, 45, 50, 55, 60, 65, 70]) {
    for (const delay of [0, 1, 2, 3]) {
      const r = gapFlight(world, true, pitch, delay, null, false);
      if (r.outcome === 'landed') {
        good.push(`p${pitch}/d${delay}`);
        landXs.push(r.landX);
      }
      check(!r.exitReached, `quad flight pitch ${pitch} delay ${delay} does not reach the exit`, r.outcome);
    }
  }
  check(
    good.length >= 6,
    'the turned-view run, jump and quad rocket behind lands on the platform for a range of pitches',
    `${good.length} of 28 land: ${good.join(' ')}; landing x ${Math.min(...landXs).toFixed(0)}..${Math.max(...landXs).toFixed(0)} (platform ${LANDING.x0}..${TOWER_X0} before the tower)`,
  );
  const strafed = gapFlight(world, true, 55, 1, null, true);
  console.log(`  info  the same at pitch 55 with air strafing after the shot: ${strafed.outcome} at x=${strafed.landX.toFixed(0)}`);

  // The fastest the station lets a player leave its edge: a hot arrival (the
  // greedy edge jump off I7 lands at ~610) hopping the whole station with the
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
  const bound = Math.ceil((vmax + 150) / 50) * 50;
  const rows: string[] = [];
  let allRescued = true;
  let furthest = -Infinity;
  for (const v of [null, vmax, bound, 1100] as const) {
    let best = -Infinity;
    let rescued = true;
    for (const pitch of [30, 45, 55, 60, 65, 70, 80]) {
      for (const delay of [0, 1, 2]) {
        const r = gapFlight(world, false, pitch, delay, v, true);
        rescued &&= r.outcome === 'rescued';
        best = Math.max(best, r.downX ?? -Infinity);
      }
    }
    if (v !== 1100) {
      allRescued &&= rescued;
      furthest = Math.max(furthest, best);
    }
    rows.push(`${v ?? 'run'}: ${rescued ? 'all rescued' : 'SOME LAND'}, furthest down through the platform height at x ${Number.isFinite(best) ? best.toFixed(0) : 'never'}`);
  }
  check(
    allRescued,
    `without quad (suit on), a rocket jump from the station at up to ${bound} ups (its greedy hop chain reaches ${vmax}) with air strafing is rescued to the checkpoint`,
    `${rows.join('; ')}; the platform starts at ${LANDING.x0}`,
  );
}

// ---------------------------------------------------------------------------
// 6: the pit
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
  console.log(`\nthe pit: a ${DEPTH} fall, the exit ledge ${E} above the floor`);
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

  // (a) one quad rocket, (b) two plain rockets, by every swept line.
  const sweep = (quad: boolean, k: 1 | 2): { exit: boolean; apex: number; how: string; byLine: string } => {
    let best = { exit: false, apex: -Infinity, how: '' };
    const lineBest = new Map<string, number>();
    const note = (key: string, apex: number): void => {
      lineBest.set(key, Math.max(lineBest.get(key) ?? -Infinity, apex));
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
              note(`${rimJump === undefined ? 'walk-off' : 'rim jump'}, ${yaw === 0 ? 'facing the far wall' : 'facing the rim'}${hold ? ', holding forward' : ''}`, r.apex);
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
          note('jump from the floor at the far wall', r.apex);
          if (r.exit || r.apex > best.apex) {
            best = { exit: best.exit || r.exit, apex: Math.max(best.apex, r.apex), how: `floor jump, pitch ${pitch} hold ${hold} delay ${d}` };
          }
        }
      }
    }
    const byLine = [...lineBest.entries()]
      .sort((p, q) => q[1] - p[1])
      .map(([key, apex]) => `${key} ${(apex - FLOOR.top).toFixed(0)}`)
      .join('; ');
    return { ...best, byLine };
  };
  if (part('a')) {
    const one = sweep(true, 1);
    check(
      !one.exit && one.apex < EXIT.top - 18 - 50,
      '(a) one quad rocket, by any swept line (walk-off or rim jump at any fire frame, wall shots, a jump from the floor), stays 50 under the exit less its 18 step-up',
      `best apex ${(one.apex - FLOOR.top).toFixed(0)} above the floor (${one.how}); exit ${E}, margin ${(EXIT.top - 18 - one.apex).toFixed(0)} under the step-up`,
    );
    console.log(`  info  (a) best one-quad-rocket apex above the floor, by line: ${one.byLine}`);
  }
  if (part('b')) {
    const plain2 = sweep(false, 2);
    check(!plain2.exit, '(b) two plain rockets, by any swept line including the wall shots, do not reach the exit', `best apex ${(plain2.apex - FLOOR.top).toFixed(0)} above the floor (${plain2.how})`);
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

  // (d) launches from standing surfaces outside the shaft.
  let outside = false;
  let outsideApex = -Infinity;
  for (const at of [LANDING.x0 + 700, TOWER_X0 - 64, TOWER_X0 + 100, RIM_X - 16, RIM_X + 10]) {
    for (const pitch of [60, 75, 89]) {
      for (const hold of [false, true]) {
        for (const second of [100, 140, 180, 220, 260]) {
          const r = outsideLine(world, at, pitch, [0, second, second + 100], hold);
          outside ||= r.exit;
          outsideApex = Math.max(outsideApex, r.apex);
        }
      }
    }
  }
  check(
    !outside,
    '(d) no quad jump+fire (then two more rockets) from the landing platform, the tunnel floor or the rim reaches the exit',
    `best apex ${outsideApex.toFixed(0)} (z), exit top ${EXIT.top}; the tunnel ceiling is ${TUNNEL_CEILING - LANDING.top} over the floor to x=${RIM_X}, the hanging block over the shaft ${LINTEL_BOTTOM - LANDING.top} over the rim at x=${LINTEL_X0}..${TOWER_X1}`,
  );

  // Alternate in-shaft lines: printed, not asserted (the coordinator accepted them).
  const wall = pitLine(world, { quad: true, suit: true, v: 0, fires: [0, 100], pitch: 80, hold: true, floorJump: true });
  const rimTwo = pitLine(world, { quad: true, suit: true, v: 900, fires: [0, 100], pitch: 75, hold: true });
  console.log(`  info  alternate two-quad-rocket lines in the shaft: floor jump+fire then a wall rocket ${wall.exit ? 'reaches' : 'does not reach'} the exit (apex ${(wall.apex - FLOOR.top).toFixed(0)}); a rim shot then a wall rocket ${rimTwo.exit ? 'reaches' : 'does not reach'} it (apex ${(rimTwo.apex - FLOOR.top).toFixed(0)})`);
  return { doubleFrames };
}

// ---------------------------------------------------------------------------
// 7-8: the retry door and the timing
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
      [1500, 0, -8],
      [4800, 0, -328],
      [7000, 0, 200],
      [10150, 0, -1200],
      [10700, 0, 276],
    ],
    5,
  );
}
