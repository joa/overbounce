/** Try to load every map in a .pk3 the way the game does, and report failures. */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { buildCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import { buildEntities } from '../../src/game/entities.js';

const path = process.argv[2];
const fs = new Pk3FileSystem();
try {
  await fs.mount(basename(path), await openAsBlob(path));
} catch (e) {
  console.log('MOUNT FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
}

console.log('files:', fs.list({}).length, ' maps:', fs.listMaps());

for (const map of fs.listMaps()) {
  try {
    const bytes = await fs.readFile(`maps/${map}.bsp`);
    if (!bytes) {
      console.log(`${map}: readFile returned null`);
      continue;
    }
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const bsp = parseBsp(buf);
    const world = buildCollisionModel(bsp);
    const ents = buildEntities(parseEntities(bsp.entities));
    console.log(
      `${map}: OK  brushes=${world.brushes.length} ents=${ents.length}` +
        ` surfaces=${bsp.surfaces.length} lightmaps=${bsp.lightmaps.length}` +
        ` lightgrid=${bsp.lightGrid.length}`,
    );
  } catch (e) {
    console.log(`${map}: FAILED  ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof Error && e.stack) {
      console.log(e.stack.split('\n').slice(1, 4).join('\n'));
    }
  }
}
