/**
 * Pad + rocket probe: how much a rocket fired into a jump pad adds to the
 * launch, and how wide the timing window is.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run pad-rocket-probe                  # maps/ob_crypt.bsp, pad 1
 *
 * `BG_TouchJumpPad` REPLACES the velocity every tick the player overlaps the
 * trigger, and `Game.step` runs the missiles before the course touch, so a
 * rocket that explodes while the player is still inside the pad volume is
 * simply overwritten. The window is therefore decided by how fast the pad
 * carries the feet out of the trigger versus how long the rocket takes to
 * reach the pad. This sweeps the fire frame relative to the pad touch, for a
 * few aim pitches, and prints apex / landing / health for each.
 *
 * Also measures air control after a pad: the landing x with forward held,
 * nothing held, and back held for the whole flight, and the air-strafe gain
 * with the view turned by a fixed yaw.
 *
 * The map is ob_crypt and the constants below are ITS geometry: pad 1 sits
 * at x 512..640 and its landing platform's top is z 128. Pointing this at
 * another map means changing START and LANDING_TOP together. A strafed
 * flight here runs into crypt's second pad and gets relaunched, so the yaw
 * table's landing x is only comparable up to that point; the peak-speed
 * column is what those rows are for.
 */

import { readFileSync } from 'node:fs';
import { loadCollisionModel, parseEntities } from '../src/collision/cm-load.js';
import { buildEntities } from '../src/game/entities.js';
import { Game } from '../src/game/game.js';
import type { GameInput } from '../src/game/game.js';
import { Weapon } from '../src/game/weapons.js';

const mapPath = process.argv[2] ?? 'maps/ob_crypt.bsp';
const START: [number, number, number] = [300, 0, 26];
const LANDING_TOP = 128; // P1 top in ob_crypt: "landing x" is where the feet fall back through it

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const model = loadCollisionModel(toArrayBuffer(readFileSync(mapPath)));
const entities = buildEntities(parseEntities(model.entities));

function newGame(): Game {
  return new Game({
    world: model,
    entities,
    origin: START,
    weapon: Weapon.ROCKET_LAUNCHER,
    axisLock: { axis: 1, value: 0 },
  });
}

function feet(g: Game): number {
  return g.ps.origin[2] - 24;
}

/** Frame index (from the first step) on which the pad fires when walking forward. */
function padTouchFrame(): number {
  const g = newGame();
  for (let i = 0; i < 600; i++) {
    const f = g.step({ forward: 127, yaw: 0 });
    if (f.course.some((e) => e.kind === 'jumppad')) {
      return i;
    }
  }
  throw new Error('pad never fired');
}

interface Flight {
  /** Frames after the pad touch on which the rocket's damage landed (null: never). */
  explodeFrame: number | null;
  apex: number;
  landX: number | null;
  vzAfter: number;
  health: number;
  teleported: boolean;
}

function fly(fireAt: number | null, pitch: number, airInput: GameInput): Flight {
  const g = newGame();
  let apex = -Infinity;
  let landX: number | null = null;
  let health = 0;
  let teleported = false;
  let launched = false;
  let vzAfter = 0;
  let launchFrame = 0;
  let explodeFrame: number | null = null;
  let lastHealth = 100;
  let prevFeet = feet(g);
  for (let i = 0; i < 700; i++) {
    let input: GameInput;
    if (!launched) {
      input = { forward: 127, yaw: 0, pitch };
    } else {
      input = { ...airInput, pitch };
    }
    if (fireAt !== null && i === fireAt) {
      input = { ...input, attack: true };
    }
    const f = g.step(input);
    health = f.health;
    if (!launched && f.course.some((e) => e.kind === 'jumppad')) {
      launched = true;
      launchFrame = i;
    }
    if (f.health < lastHealth && explodeFrame === null) {
      explodeFrame = i - launchFrame;
    }
    lastHealth = f.health;
    if (f.course.some((e) => e.kind === 'teleport')) {
      teleported = true;
      break;
    }
    if (launched) {
      apex = Math.max(apex, feet(g));
      if (g.ps.velocity[2] > vzAfter) {
        vzAfter = g.ps.velocity[2];
      }
      if (landX === null && prevFeet > LANDING_TOP && feet(g) <= LANDING_TOP && g.ps.velocity[2] < 0) {
        landX = g.ps.origin[0];
      }
      if (g.onGround && i > launchFrame + 5) {
        break;
      }
    }
    prevFeet = feet(g);
  }
  return { explodeFrame, apex, landX, vzAfter, health, teleported };
}

const T = padTouchFrame();
console.log(`${mapPath}: pad touched on frame ${T} walking forward from x=${START[0]}`);

const base = fly(null, 0, { forward: 127, yaw: 0 });
console.log(`\nno rocket, forward held: apex feet ${base.apex.toFixed(1)}, peak vz ${base.vzAfter}, landing x ${base.landX?.toFixed(0)}, health ${base.health}`);

console.log('\nair control after the pad (landing x = where the feet fall back through z=128):');
for (const [name, inp] of [
  ['forward held', { forward: 127, yaw: 0 }],
  ['nothing held', { yaw: 0 }],
  ['back held', { forward: -127, yaw: 0 }],
] as const) {
  const r = fly(null, 0, inp);
  console.log(`  ${name.padEnd(13)} apex ${r.apex.toFixed(1)}  landing x ${r.landX?.toFixed(0) ?? '-'}  teleported=${r.teleported}`);
}

for (const pitch of [89, 60]) {
  console.log(`\nrocket fired N frames after the pad touch, aim pitch ${pitch}, forward held throughout:`);
  console.log('    N   boom@   apex feet   peak vz   landing x   health');
  for (let n = -6; n <= 20; n++) {
    const r = fly(T + n, pitch, { forward: 127, yaw: 0 });
    console.log(
      `  ${String(n).padStart(3)}   ${String(r.explodeFrame ?? '-').padStart(5)}   ${r.apex.toFixed(1).padStart(8)}   ${String(r.vzAfter).padStart(7)}   ${(r.landX?.toFixed(0) ?? '-').padStart(9)}   ${r.health.toFixed(1).padStart(6)}`,
    );
  }
}

// Air strafe after the pad: forward held with the view turned by `yaw`
// degrees. Under the y lock the sideways component is discarded every tick,
// but PM_Accelerate's addspeed test is against wishspeed along the turned
// wishdir, so x speed keeps growing past 320 -- the strafe-jump bug in one
// dimension. Landing x is measured where the feet fall back through
// LANDING_TOP regardless of what is there, so it is comparable across inputs.
function landingThrough(yaw: number): { landX: number | null; peakVx: number } {
  const g = newGame();
  let launched = false;
  let landX: number | null = null;
  let peakVx = 0;
  let launchFrame = 0;
  let wasAbove = false;
  for (let i = 0; i < 700; i++) {
    const f = g.step(launched ? { forward: 127, yaw } : { forward: 127, yaw: 0 });
    if (!launched && f.course.some((e) => e.kind === 'jumppad')) {
      launched = true;
      launchFrame = i;
    }
    if (launched) {
      peakVx = Math.max(peakVx, g.ps.velocity[0]);
      // First contact with anything, or falling past the landing height:
      // either way the flight is over, before a second pad can confound it.
      if (feet(g) > LANDING_TOP) {
        wasAbove = true;
      }
      if ((g.onGround && i > launchFrame + 5) || (wasAbove && feet(g) < LANDING_TOP - 0.5)) {
        landX = g.ps.origin[0];
        break;
      }
    }
  }
  return { landX, peakVx };
}

console.log('\nair strafe after the pad (forward held, view turned by yaw): peak x speed and x at first contact');
for (const yaw of [0, 30, 45, 54, 60, 70, 78, 85]) {
  const r = landingThrough(yaw);
  console.log(`  yaw ${String(yaw).padStart(2)}  peak vx ${r.peakVx.toFixed(0).padStart(4)}  landing x ${r.landX?.toFixed(0) ?? '-'}`);
}
