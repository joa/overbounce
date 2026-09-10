/**
 * Shared scaffolding for the per-map course checks (`npm run course-check`).
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is the same loop `test/physics` runs, pointed at a real map: the full
 * `Game` (course triggers, jump pads, teleporters, the y-axis lock the .cam
 * declares) driven by scripted usercmds, one 8ms tick at a time. Nothing here
 * is a heuristic -- a "pass" means the simulation the player actually plays
 * did the thing.
 */

import { readFileSync } from 'node:fs';
import { loadCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import type { CollisionModel } from '../../src/collision/model.js';
import { buildEntities } from '../../src/game/entities.js';
import type { MapEntity } from '../../src/game/entities.js';
import { Game } from '../../src/game/game.js';
import type { GameInput } from '../../src/game/game.js';
import type { Weapon } from '../../src/game/weapons.js';
import { computeCameraPose, parseCameraScript, resolveCameraZone } from '../../src/game/camera-script.js';

export const FWD: GameInput = { forward: 127, yaw: 0 };
export const FWD_JUMP: GameInput = { forward: 127, up: 127, yaw: 0 };
export const NONE: GameInput = { yaw: 0 };

export interface World {
  model: CollisionModel;
  entities: MapEntity[];
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function loadWorld(mapPath: string): World {
  const model = loadCollisionModel(toArrayBuffer(readFileSync(mapPath)));
  const entities = buildEntities(parseEntities(model.entities));
  return { model, entities };
}

let failures = 0;

export function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (!ok) {
    failures++;
  }
}

export function failureCount(): number {
  return failures;
}

export function feet(game: Game): number {
  return game.ps.origin[2] - 24;
}

export function x(game: Game): number {
  return game.ps.origin[0];
}

export function hspeed(game: Game): number {
  return Math.hypot(game.ps.velocity[0], game.ps.velocity[1]);
}

/**
 * A game under the same `"lock" "y 0"` the live player runs under (both
 * bundled side-view courses declare it in their .cam).
 */
export function newGame(world: World, origin: [number, number, number], weapon?: Weapon): Game {
  const lock = { axis: 1 as const, value: 0 };
  return weapon === undefined
    ? new Game({ world: world.model, entities: world.entities, origin, axisLock: lock })
    : new Game({ world: world.model, entities: world.entities, origin, weapon, axisLock: lock });
}

/** Stand still until the origin stops moving (never wait for vz === 0). */
export function settle(game: Game): void {
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
export function walkOff(game: Game, limit = 2000): number {
  for (let i = 0; i < limit; i++) {
    game.step(FWD);
    if (!game.onGround) {
      return x(game);
    }
  }
  throw new Error('never left the ground');
}

/** Free-fall with no input until grounded. Returns frames taken. */
export function fallUntilGrounded(game: Game, limit = 2000): number {
  for (let i = 0; i < limit; i++) {
    game.step(NONE);
    if (game.onGround) {
      return i;
    }
  }
  throw new Error('never landed');
}

/** Hold forward until a jump pad fires. Returns the frame count it took. */
export function walkOntoPad(game: Game, limit = 2000): number {
  for (let i = 0; i < limit; i++) {
    const frame = game.step(FWD);
    if (frame.course.some((e) => e.kind === 'jumppad')) {
      return i;
    }
  }
  throw new Error('no pad fired');
}

export interface FlightResult {
  /** Highest the feet got after the launch. */
  apex: number;
  /** True if a rescue teleporter (or any teleporter) fired. */
  teleported: boolean;
  /** Frames flown before touching down or teleporting. */
  frames: number;
  /** x where the feet came back down through `landingTop` (null: never that high, or no landingTop given). */
  downX: number | null;
  /** x where the flight ended: the touchdown, or the last position before a rescue slab fired. */
  endX: number;
}

/**
 * Fly with `input` held from the frame after a launch until the player is
 * grounded again (or teleported). The first few frames are skipped for the
 * ground test because the launch frame itself still reports onGround.
 */
export function flyUntilGrounded(game: Game, input: GameInput, landingTop: number | null = null, limit = 1200): FlightResult {
  let apex = feet(game);
  let downX: number | null = null;
  let prevFeet = feet(game);
  let prevX = x(game);
  for (let i = 0; i < limit; i++) {
    const frame = game.step(input);
    apex = Math.max(apex, feet(game));
    if (landingTop !== null && downX === null && prevFeet > landingTop && feet(game) <= landingTop && game.ps.velocity[2] < 0) {
      downX = x(game);
    }
    prevFeet = feet(game);
    if (frame.course.some((e) => e.kind === 'teleport')) {
      // The teleport has already moved the origin; the previous frame's x is
      // where the slab was met, which is what "which slab fired" needs.
      return { apex, teleported: true, frames: i + 1, downX, endX: prevX };
    }
    if (game.onGround && i > 5) {
      return { apex, teleported: false, frames: i + 1, downX, endX: x(game) };
    }
    prevX = x(game);
  }
  throw new Error('flight never ended');
}

/**
 * The sidecar is only warned about at load if malformed, so parse it here
 * where a typo fails loudly, and sample the pose each zone produces.
 */
export function cameraScript(camPath: string, samples: readonly [number, number, number][], minZones: number): void {
  console.log(`\ncamera script ${camPath}`);
  let text: string;
  try {
    text = readFileSync(camPath, 'utf8');
  } catch {
    check(false, 'camera script exists');
    return;
  }
  const script = parseCameraScript(text);
  check(script.lock !== null && script.lock.axis === 'y' && script.lock.value === 0, 'declares "lock" "y 0"');
  check(
    script.zones.length >= minZones,
    `has at least ${minZones} zones`,
    `zones=${script.zones.map((z) => z.mode).join(',')}`,
  );
  for (const p of samples) {
    const zone = resolveCameraZone(script, p);
    const pose = computeCameraPose(zone, p);
    console.log(`  info  player ${p.join(',')} -> ${zone.mode.padEnd(5)} eye ${pose.eye.map((v) => Math.round(v)).join(',')}`);
  }
}
