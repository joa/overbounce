/** Load a map out of a .pk3 headlessly: collision model, entities, items. */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { buildCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import { buildEntities, findSpawn } from '../../src/game/entities.js';
import { ItemWorld } from '../../src/game/item-world.js';

const fs = new Pk3FileSystem();
for (const p of process.argv.slice(2)) {
  await fs.mount(basename(p), await openAsBlob(p));
}
for (const map of fs.listMaps()) {
  const bytes = await fs.readFile(`maps/${map}.bsp`);
  if (!bytes) {
    console.log(`${map}: listMaps() named it but readFile could not find it`);
    continue;
  }
  const bsp = parseBsp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const world = buildCollisionModel(bsp);
  const entities = buildEntities(parseEntities(bsp.entities));
  const items = new ItemWorld(world, entities);
  const spawn = findSpawn(entities);

  const byClass = new Map<string, number>();
  for (const e of entities) {
    byClass.set(e.classname, (byClass.get(e.classname) ?? 0) + 1);
  }
  const notable = [...byClass]
    .filter(([c]) => /timer|checkpoint|push|teleport|hurt|weapon_|item_|holdable/.test(c))
    .map(([c, n]) => `${c}x${n}`)
    .join(' ');

  console.log(
    `${map}: brushes=${world.brushes.length} ents=${entities.length}` +
      ` items=${items.items.length} spawn=${spawn ? spawn.origin.map(Math.round).join(',') : 'NONE'}` +
      `
    ${notable}`,
  );
}
