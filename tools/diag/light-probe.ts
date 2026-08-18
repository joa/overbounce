/** Sample the BSP light grid at a map's item positions. */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { buildCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import { buildEntities } from '../../src/game/entities.js';
import { ItemWorld } from '../../src/game/item-world.js';
import { gridSizeFromEntities, parseLightGrid, sampleLightGrid } from '../../src/render/light-grid.js';

const [pak, map] = process.argv.slice(2);
const fs = new Pk3FileSystem();
await fs.mount(basename(pak), await openAsBlob(pak));
const bytes = (await fs.readFile(`maps/${map}.bsp`))!;
const bsp = parseBsp(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
);
const world = buildCollisionModel(bsp);
const hull = world.submodels[0];

const size = gridSizeFromEntities(bsp.entities);
const grid = parseLightGrid(bsp.lightGrid, hull.mins, hull.maxs, size);
console.log(
  `gridsize ${size.join('x')}  lump ${bsp.lightGrid.length} bytes  ` +
    (grid ? `bounds ${grid.bounds.join('x')} origin ${grid.origin.join(',')}` : 'MISMATCH -> null'),
);
if (!grid) {
  process.exit(1);
}

const entities = buildEntities(parseEntities(bsp.entities));
for (const p of new ItemWorld(world, entities).items.slice(0, 12)) {
  const l = sampleLightGrid(grid, p.origin);
  const r = (v: number): string => String(Math.round(v)).padStart(3);
  console.log(
    `${p.item.classname.padEnd(24)} @ ${p.origin.map(Math.round).join(',').padEnd(20)}` +
      ` ambient ${r(l.ambient[0])},${r(l.ambient[1])},${r(l.ambient[2])}` +
      `  directed ${r(l.directed[0])},${r(l.directed[1])},${r(l.directed[2])}` +
      `  dir ${l.dir.map((v) => v.toFixed(2)).join(',')}`,
  );
}
