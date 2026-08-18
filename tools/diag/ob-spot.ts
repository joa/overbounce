/**
 * At a point on a real map: what the detector claims, and what actually happens.
 *
 * Drops a real Simulation from the resting position, both with horizontal
 * velocity and with none, and reports peak horizontal speed and any upward
 * launch. Prediction and reality side by side, on the map's own geometry.
 */
import { readFileSync } from 'node:fs';
import { parseBsp } from '../../src/collision/bsp.js';
import { buildCollisionModel } from '../../src/collision/cm-load.js';
import { boxTrace } from '../../src/collision/trace.js';
import { createTrace } from '../../src/physics/types.js';
import { MASK_PLAYERSOLID } from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';
import { Simulation } from '../../src/physics/simulate.js';
import { classifyOverbounce, obLabel } from '../../src/game/overbounce.js';

const raw = readFileSync(process.argv[2]);
const bsp = parseBsp(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
const world = buildCollisionModel(bsp);
const [x, y, z] = (process.argv[3] ?? '0,0,0').split(',').map(Number);

const MINS = vec3(-15, -15, -24);
const MAXS = vec3(15, 15, 32);
const tr = createTrace();

// Settle onto whatever is under the given point.
boxTrace(world, tr, vec3(x, y, z), MINS, MAXS, vec3(x, y, z - 8192), MASK_PLAYERSOLID);
if (tr.startsolid || tr.fraction === 1) {
  console.log('no floor under that point');
  process.exit(1);
}
const restZ = tr.endpos[2];
const surfaceZ = tr.plane.dist;
const normalZ = tr.plane.normal[2];
console.log(`rest z=${restZ.toFixed(4)}  surface z=${surfaceZ.toFixed(4)}  normal.z=${normalZ.toFixed(4)}`);
console.log(`drop (origin - surface - 24) = ${(restZ - surfaceZ - 24).toFixed(4)}`);
console.log(`detector says: ${obLabel(classifyOverbounce(restZ, surfaceZ, normalZ)) || 'nothing'}`);

/** Drop from `restZ` with the given horizontal speed and report what happened. */
function drop(hspeed: number): void {
  const sim = new Simulation({
    world,
    origin: [x, y, restZ],
    velocity: [hspeed, 0, 0],
  });
  let peak = hspeed;
  let launch = 0;
  let grounded = 0;
  for (let i = 0; i < 600; i++) {
    const before = sim.ps.velocity[2];
    sim.step({});
    const after = sim.ps.velocity[2];
    peak = Math.max(peak, sim.speed);
    if (before < -10 && after > 10) {
      launch = after;
    }
    if (sim.onGround) {
      if (++grounded > 4) break;
    } else {
      grounded = 0;
    }
  }
  console.log(
    `  drop with ${String(hspeed).padStart(4)}ups horizontal -> peak h-speed ${peak.toFixed(1)}` +
      `  vertical launch ${launch.toFixed(1)}  final z ${sim.ps.origin[2].toFixed(3)}`,
  );
}

drop(0);
drop(100);
drop(320);
