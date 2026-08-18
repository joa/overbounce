/** Where a map's items are, for `?at=` repro URLs. */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { buildCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import { buildEntities } from '../../src/game/entities.js';
import { ItemWorld } from '../../src/game/item-world.js';

const [pak, map, filter] = process.argv.slice(2);
const fs = new Pk3FileSystem();
await fs.mount(basename(pak), await openAsBlob(pak));
const bytes = (await fs.readFile(`maps/${map}.bsp`))!;
const bsp = parseBsp(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
);
const world = buildCollisionModel(bsp);
const entities = buildEntities(parseEntities(bsp.entities));
for (const p of new ItemWorld(world, entities).items) {
  if (filter && !p.item.classname.includes(filter)) {
    continue;
  }
  const [x, y, z] = p.origin.map(Math.round);
  console.log(`${p.item.classname.padEnd(26)} ${x},${y},${z}`);
}
