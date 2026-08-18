/**
 * Find the overbounce spots a map actually contains.
 *
 * Drops a probe from every teleporter destination and every standable ledge,
 * traces to the floor beneath, and asks the detector what that landing does.
 * This is how you check that a purpose-built OB map really works, and that the
 * detector agrees with the map author.
 */
import { readFileSync } from 'node:fs';
import { parseBsp } from '../../src/collision/bsp.js';
import { buildCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import { buildEntities } from '../../src/game/entities.js';
import { boxTrace } from '../../src/collision/trace.js';
import { createTrace } from '../../src/physics/types.js';
import { MASK_PLAYERSOLID } from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';
import { ObMethod, classifyOverbounce, obLabel } from '../../src/game/overbounce.js';

const raw = readFileSync(process.argv[2]);
const bsp = parseBsp(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
const world = buildCollisionModel(bsp);
const entities = buildEntities(parseEntities(bsp.entities));

const MINS = vec3(-15, -15, -24);
const MAXS = vec3(15, 15, 32);
const trace = createTrace();

/** Settle a point onto the floor beneath it, then report the drop below THAT. */
function report(label: string, origin: readonly number[]): void {
  // Where the player comes to rest at this spot.
  const from = vec3(origin[0], origin[1], origin[2]);
  const to = vec3(origin[0], origin[1], origin[2] - 4096);
  boxTrace(world, trace, from, MINS, MAXS, to, MASK_PLAYERSOLID);
  if (trace.startsolid || trace.fraction === 1) {
    console.log(`${label.padEnd(28)} no floor beneath`);
    return;
  }
  const restZ = trace.endpos[2];

  // Now step off it: what is below the ledge you are standing on?
  const off = vec3(origin[0] + 40, origin[1], restZ);
  const offDown = vec3(off[0], off[1], restZ - 4096);
  boxTrace(world, trace, off, MINS, MAXS, offDown, MASK_PLAYERSOLID);
  if (trace.startsolid || trace.fraction === 1) {
    console.log(`${label.padEnd(28)} rest z=${restZ.toFixed(3)}  nothing below`);
    return;
  }

  const surfaceZ = trace.plane.dist;
  const r = classifyOverbounce(restZ, surfaceZ, trace.plane.normal[2]);
  const drop = (restZ - surfaceZ).toFixed(3);
  console.log(
    `${label.padEnd(28)} rest z=${restZ.toFixed(3)}  drop=${drop.padStart(9)}  ` +
      `${r.method === ObMethod.NONE ? '-' : obLabel(r)}`,
  );
}

for (const e of entities) {
  if (
    e.classname === 'misc_teleporter_dest' ||
    e.classname === 'info_player_start' ||
    e.classname === 'target_position'
  ) {
    report(`${e.classname} ${e.targetname ?? ''}`, e.origin);
  }
}
