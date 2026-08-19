/**
 * Count mover entities (`func_door`, `func_plat`, `func_button`, `func_train`,
 * `func_bobbing`, `func_rotating`, `func_pendulum`, `func_static`) per map and
 * dump every spawn key they use.
 *
 * This is the "count it before you port it" step for movers: g_mover.c is one
 * file but five features, and the maps in rotation decide which of them are
 * worth having.
 *
 *   npx tsx tools/diag/movers.ts public/dev-q3dm7.pk3 ...
 */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { parseEntities } from '../../src/collision/cm-load.js';
import { buildEntities } from '../../src/game/entities.js';

const MOVERS = [
  'func_door',
  'func_plat',
  'func_button',
  'func_train',
  'func_bobbing',
  'func_rotating',
  'func_pendulum',
  'func_timer',
  'path_corner',
  'func_group',
];

const fs = new Pk3FileSystem();
for (const p of process.argv.slice(2)) {
  await fs.mount(basename(p), await openAsBlob(p));
}

for (const map of fs.listMaps()) {
  const bytes = await fs.readFile(`maps/${map}.bsp`);
  if (!bytes) continue;
  const bsp = parseBsp(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const entities = buildEntities(parseEntities(bsp.entities));

  const counts = new Map<string, number>();
  for (const e of entities) {
    if (MOVERS.includes(e.classname)) {
      counts.set(e.classname, (counts.get(e.classname) ?? 0) + 1);
    }
  }
  const summary = [...counts].map(([c, n]) => `${c}x${n}`).join(' ') || '(none)';
  console.log(`\n=== ${map}: ${summary}`);

  for (const e of entities) {
    if (!MOVERS.includes(e.classname)) continue;
    const model = e.submodel >= 0 ? bsp.models[e.submodel] : null;
    const size = model
      ? `size=[${model.maxs.map((v, i) => Math.round(v - model.mins[i])).join(',')}]`
      : 'size=point';
    const keys = Object.entries(e.raw)
      .filter(([k]) => k !== 'classname')
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    console.log(`  ${e.classname} ${size} ${keys}`);
  }

  // What fires what: a door with a targetname gets NO auto trigger, so the
  // entity that targets it is the only way it ever opens.
  const named = new Set(entities.filter((e) => e.targetname).map((e) => e.targetname));
  for (const e of entities) {
    if (e.target && named.has(e.target)) {
      console.log(`  link: ${e.classname}(${e.origin.map(Math.round).join(',')}) -> ${e.target}`);
    }
  }
}
