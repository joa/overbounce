/** Load a bare .bsp from disk (no pk3) and report what is in it. */
import { readFileSync } from 'node:fs';
import { parseBsp } from '../../src/collision/bsp.js';
import { buildCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import { buildEntities, findSpawn } from '../../src/game/entities.js';

const path = process.argv[2];
const raw = readFileSync(path);
const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
const bsp = parseBsp(buf);
const world = buildCollisionModel(bsp);
const entities = buildEntities(parseEntities(bsp.entities));
const spawn = findSpawn(entities);

const hull = world.submodels[0];
console.log(`brushes=${world.brushes.length} surfaces=${bsp.surfaces.length} ents=${entities.length}`);
console.log(`bounds  mins=${hull.mins.map(Math.round).join(',')}  maxs=${hull.maxs.map(Math.round).join(',')}`);
console.log(`spawn   ${spawn ? spawn.origin.map(Math.round).join(',') + ' yaw ' + spawn.yaw : 'NONE'}`);

const byClass = new Map<string, number>();
for (const e of entities) {
  byClass.set(e.classname, (byClass.get(e.classname) ?? 0) + 1);
}
console.log('entities:', [...byClass].map(([k, v]) => `${k}x${v}`).join(' '));
