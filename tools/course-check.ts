/**
 * Course check: replay each ob_crypt obstacle's intended technique headlessly
 * against the compiled BSP and report whether the geometry does what
 * `.agent/plans/OB-CRYPT.md` says it does.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run course-check                       # maps/ob_crypt.bsp
 *   npm run course-check -- path/to/other.bsp
 *
 * This is the same loop `test/physics` runs, pointed at a real map: the full
 * `Game` (course triggers, jump pads, teleporters, the y-axis lock the .cam
 * declares) driven by scripted usercmds, one 8ms tick at a time. Nothing here
 * is a heuristic -- a "pass" means the simulation the player actually plays
 * did the thing.
 *
 * Two of the checks deserve a word on what they measure:
 *
 *  - The vertical overbounce in the iron shaft is asserted on the frame AFTER
 *    landing, because the launch velocity appears there, not on the landing
 *    frame (physics-for-map-authors.md, "Reproducing this").
 *  - The final overbounce's jump window is swept, not assumed: the jump is
 *    pressed N frames after landing for N = 0..24, and the table says which N
 *    still reach the finish. N = 0 is expected to FAIL -- `PM_CheckJump` runs
 *    before `PM_WalkMove`'s clip on the landing frame and overwrites the fall
 *    velocity, so a jump pressed on the landing frame gets no bounce.
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadCollisionModel, parseEntities } from '../src/collision/cm-load.js';
import type { CollisionModel } from '../src/collision/model.js';
import { buildEntities } from '../src/game/entities.js';
import type { MapEntity } from '../src/game/entities.js';
import { Game } from '../src/game/game.js';
import type { GameInput } from '../src/game/game.js';
import { Weapon } from '../src/game/weapons.js';
import { computeCameraPose, parseCameraScript, resolveCameraZone } from '../src/game/camera-script.js';

const mapPath = process.argv[2] ?? 'maps/ob_crypt.bsp';

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const FWD: GameInput = { forward: 127, yaw: 0 };
const FWD_JUMP: GameInput = { forward: 127, up: 127, yaw: 0 };
const NONE: GameInput = { yaw: 0 };

let failures = 0;

function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (!ok) {
    failures++;
  }
}

function feet(game: Game): number {
  return game.ps.origin[2] - 24;
}

function x(game: Game): number {
  return game.ps.origin[0];
}

function hspeed(game: Game): number {
  return Math.hypot(game.ps.velocity[0], game.ps.velocity[1]);
}

interface World {
  model: CollisionModel;
  entities: MapEntity[];
}

function newGame(world: World, origin: [number, number, number]): Game {
  return new Game({
    world: world.model,
    entities: world.entities,
    origin,
    // scripts/ob_crypt.cam: "lock" "y 0". Same lock the live player runs under.
    axisLock: { axis: 1, value: 0 },
  });
}

/** Stand still until the origin stops moving (never wait for vz === 0). */
function settle(game: Game): void {
  let last = Number.NaN;
  for (let i = 0; i < 120; i++) {
    game.step(NONE);
    const z = game.ps.origin[2];
    if (z === last && game.onGround) {
      return;
    }
    last = z;
  }
}

/** Hold forward until the player leaves the ground. Returns the x it happened at. */
function walkOff(game: Game, limit = 2000): number {
  for (let i = 0; i < limit; i++) {
    game.step(FWD);
    if (!game.onGround) {
      return x(game);
    }
  }
  throw new Error('never left the ground');
}

/** Free-fall with no input until grounded. Returns frames taken. */
function fallUntilGrounded(game: Game, limit = 2000): number {
  for (let i = 0; i < limit; i++) {
    game.step(NONE);
    if (game.onGround) {
      return i;
    }
  }
  throw new Error('never landed');
}

function padChain(world: World, keepSpeed: boolean): void {
  console.log(`\npad chain (${keepSpeed ? 'jump on every landing' : 'never jump'})`);
  const game = newGame(world, [300, 0, 26]);
  settle(game);
  let pads = 0;
  let teleports = 0;
  let wasGround = true;
  let maxX = 0;
  for (let i = 0; i < 1500; i++) {
    const landedNow = game.onGround && !wasGround;
    const frame = game.step(keepSpeed && landedNow ? FWD_JUMP : FWD);
    wasGround = game.onGround;
    for (const e of frame.course) {
      if (e.kind === 'jumppad') {
        pads++;
      }
      if (e.kind === 'teleport') {
        teleports++;
      }
    }
    maxX = Math.max(maxX, x(game));
    if (x(game) >= 3100 && game.onGround) {
      break;
    }
  }
  check(pads === 3, 'all three pads fired', `pads=${pads}`);
  check(teleports === 0, 'never fell into lava', `teleports=${teleports}`);
  check(
    x(game) >= 2944 && game.onGround && Math.abs(feet(game) - 512.125) < 0.5,
    'reached P3 (x >= 2944, feet 512)',
    `x=${x(game).toFixed(1)} feet=${feet(game).toFixed(3)}`,
  );
}

function strafeGapNeedsSpeed(world: World): void {
  console.log('\nstrafe gap 1 (240): a plain 320ups jump from the P3 edge must NOT make it');
  const game = newGame(world, [3000, 0, 538]);
  settle(game);
  let teleport = false;
  let jumped = false;
  for (let i = 0; i < 600; i++) {
    const atEdge = game.onGround && x(game) > 3328 - 24 && !jumped;
    const frame = game.step(atEdge ? FWD_JUMP : FWD);
    if (atEdge) {
      jumped = true;
    }
    if (frame.course.some((e) => e.kind === 'teleport')) {
      teleport = true;
      break;
    }
  }
  check(teleport, 'fell into the lava and was teleported back', `x after=${x(game).toFixed(0)}`);
  check(x(game) > 2944 && x(game) < 3328, 'rescue put the player back on P3', `x=${x(game).toFixed(0)}`);
}

function ironShaft(world: World): void {
  console.log('\niron shaft: walk off P6 under the gate, release, wall, floor, vertical bounce');
  const game = newGame(world, [4700, 0, 538]);
  settle(game);
  const leftAt = walkOff(game);
  check(leftAt > 5090 && leftAt < 5140, 'left the edge at the gate', `x=${leftAt.toFixed(1)}`);
  const fallFrames = fallUntilGrounded(game);
  const landFeet = feet(game);
  const landX = x(game);
  const landH = hspeed(game);
  check(
    Math.abs(landX - 5361) < 2,
    'reached the far wall before landing (x ~ 5361)',
    `x=${landX.toFixed(2)} after ${fallFrames} frames`,
  );
  check(landH === 0, 'horizontal speed exactly 0 on the landing frame', `h=${landH}`);
  // physics-for-map-authors.md quotes a 0.125..0.25 landing window; the 512
  // drop here lands at ~0.307 and still launches a full 876, so the number
  // that decides anything is the launch on the next frame, not this one.
  console.log(`  info  feet on the landing frame: ${landFeet.toFixed(4)} above the floor`);
  // The launch appears on the frame after landing.
  game.step(NONE);
  const vz = game.ps.velocity[2];
  check(vz > 800, 'vertical overbounce launched (vz > 800)', `vz=${vz}`);

  // Now play the exit: hold forward from the launch on. The wall zeroes vx
  // until the feet clear its top (416), then air acceleration drifts the
  // player over the liner onto the ledge.
  let apex = 0;
  for (let i = 0; i < 600; i++) {
    game.step(FWD);
    apex = Math.max(apex, feet(game));
    if (game.onGround && i > 10) {
      break;
    }
  }
  settle(game);
  check(apex > 416 + 18, 'apex clears the exit ledge with step-up margin', `apex feet=${apex.toFixed(1)}`);
  check(
    x(game) >= 5376 && Math.abs(feet(game) - 416.125) < 0.5,
    'came to rest on the exit ledge (x >= 5376, feet 416)',
    `x=${x(game).toFixed(1)} feet=${feet(game).toFixed(3)}`,
  );
}

function shaftCannotBeGlided(world: World): void {
  console.log('\niron shaft skip: walk-off from the gate must land on the shaft floor, not the ledge');
  const game = newGame(world, [4700, 0, 538]);
  settle(game);
  walkOff(game);
  // Keep holding forward the whole way: the most a gate-capped player can do.
  for (let i = 0; i < 600; i++) {
    game.step(FWD);
    if (game.onGround) {
      break;
    }
  }
  check(feet(game) < 1, 'landed on the shaft floor', `feet=${feet(game).toFixed(2)} x=${x(game).toFixed(0)}`);
}

function finalOverbounce(world: World): void {
  console.log('\nfinal overbounce: walk off wall 2 under the gate, land on the stub, jump N frames later');
  const results: { n: number; speed: number; finish: boolean; x: number; feet: number }[] = [];
  for (let n = 0; n <= 24; n++) {
    const game = newGame(world, [6300, 0, 922]);
    settle(game);
    walkOff(game);
    fallUntilGrounded(game);
    if (n === 0) {
      // Report the landing itself once.
      check(
        x(game) > 6784 && x(game) < 7168 && Math.abs(feet(game) - 319.125) < 0.5,
        'walk-off lands on the stub',
        `x=${x(game).toFixed(1)} feet=${feet(game).toFixed(3)}`,
      );
    }
    for (let k = 0; k < n; k++) {
      game.step(NONE);
    }
    const speedAtJump = hspeed(game);
    game.step(FWD_JUMP);
    let teleported = false;
    for (let i = 0; i < 400; i++) {
      const frame = game.step(FWD);
      if (frame.course.some((e) => e.kind === 'teleport')) {
        teleported = true;
        break;
      }
      if (game.onGround && i > 5 && x(game) > 7500) {
        break;
      }
    }
    settle(game);
    const finish = !teleported && x(game) >= 7520 && Math.abs(feet(game) - 219.125) < 0.5;
    results.push({ n, speed: speedAtJump, finish, x: x(game), feet: feet(game) });
  }
  console.log('  jump delay (frames after landing) -> horizontal speed when jumping -> reached finish?');
  for (const r of results) {
    console.log(`    ${String(r.n).padStart(2)}  ${r.speed.toFixed(0).padStart(4)}ups  ${r.finish ? 'FINISH' : `no (x=${r.x.toFixed(0)}, feet=${r.feet.toFixed(1)})`}`);
  }
  const good = results.filter((r) => r.finish).map((r) => r.n);
  check(!results[0]!.finish, 'jumping ON the landing frame gets no bounce (expected)');
  check(good.length >= 8, 'at least 8 frames of jump window', `window=${good.join(',')}`);
}

/**
 * The sidecar is only warned about at load if malformed, so parse it here
 * where a typo fails loudly, and sample the pose each zone produces.
 */
function cameraScript(camPath: string): void {
  console.log(`
camera script ${camPath}`);
  let text: string;
  try {
    text = readFileSync(camPath, 'utf8');
  } catch {
    check(false, 'camera script exists');
    return;
  }
  const script = parseCameraScript(text);
  check(script.lock !== null && script.lock.axis === 'y' && script.lock.value === 0, 'declares "lock" "y 0"');
  check(script.zones.length >= 3, 'has at least three zones', `zones=${script.zones.map((z) => z.mode).join(',')}`);
  const samples: [number, number, number][] = [
    [0, 0, 24],
    [1800, 0, 300],
    [3000, 0, 536],
    [5248, 0, 100],
    [7000, 0, 343],
    [8000, 0, 243],
  ];
  for (const p of samples) {
    const zone = resolveCameraZone(script, p);
    const pose = computeCameraPose(zone, p);
    console.log(`  info  player ${p.join(',')} -> ${zone.mode.padEnd(5)} eye ${pose.eye.map((v) => Math.round(v)).join(',')}`);
  }
}

/**
 * Rocket wall 1 (rise 260): jump, then fire straight down the next frame,
 * forward held into the wall the whole way. The standing shot alone (166 of
 * rise per physics-for-map-authors.md) must NOT get up; jump+fire must.
 */
function rocketWall(world: World, jump: boolean): void {
  console.log(`
rocket wall 1 (rise 260): ${jump ? 'jump, then fire down' : 'fire down standing (control)'}`);
  const game = new Game({
    world: world.model,
    entities: world.entities,
    origin: [5700, 0, 442],
    weapon: Weapon.ROCKET_LAUNCHER,
    axisLock: { axis: 1, value: 0 },
  });
  settle(game);
  for (let i = 0; i < 400 && x(game) < 5824 - 40; i++) {
    game.step(FWD);
  }
  const healthBefore = game.step(FWD).health;
  if (jump) {
    game.step({ forward: 127, up: 127, pitch: 89, yaw: 0 });
  }
  game.step({ forward: 127, attack: true, pitch: 89, yaw: 0 });
  let apex = feet(game);
  let health = healthBefore;
  for (let i = 0; i < 400; i++) {
    const frame = game.step({ forward: 127, pitch: 89, yaw: 0 });
    apex = Math.max(apex, feet(game));
    health = frame.health;
    if (game.onGround && i > 20) {
      break;
    }
  }
  settle(game);
  const onTop = x(game) >= 5824 && Math.abs(feet(game) - 676.125) < 0.5;
  check(
    onTop === jump,
    jump ? 'jump+fire lands on top of the wall (feet 676)' : 'standing shot does not reach the top',
    `apex feet=${apex.toFixed(1)} rise=${(apex - 416.125).toFixed(1)} rest x=${x(game).toFixed(0)} feet=${feet(game).toFixed(3)} health ${healthBefore}->${health}`,
  );
}

function main(): void {
  const model = loadCollisionModel(toArrayBuffer(readFileSync(mapPath)));
  const entities = buildEntities(parseEntities(model.entities));
  const world: World = { model, entities };
  console.log(`${mapPath}: ${entities.length} entities`);

  padChain(world, true);
  padChain(world, false);
  strafeGapNeedsSpeed(world);
  ironShaft(world);
  shaftCannotBeGlided(world);
  finalOverbounce(world);
  rocketWall(world, true);
  rocketWall(world, false);
  cameraScript(join('scripts', basename(mapPath, '.bsp') + '.cam'));

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main();
