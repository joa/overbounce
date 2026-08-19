/**
 * Watch a map's doors open, headlessly.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npx tsx tools/diag/doors.ts public/dev-q3dm7.pk3 q3dm7 1644,-600,-160
 *   npx tsx tools/diag/doors.ts <pak> <map> <x,y,z> <ticks> --walk 180
 *   npx tsx tools/diag/doors.ts <pak> <map> <x,y,z> <ticks> --use t2
 *
 * `--walk <yaw>` runs forward at that heading, which is the only way to test a
 * `func_button`: a button is a SOLID and fires from `pm.touchents`, so it needs
 * a real collision and standing inside it proves nothing. `--use <targetname>`
 * fires a target directly, which separates "the mover is broken" from "nothing
 * ever reached it".
 *
 * Runs the real `Game` on the real BSP from a given spawn point and prints
 * every mover's origin as it changes, with the level time each change happened
 * at. This is the check that belongs headless: whether a door opens is a
 * gameplay question, and the renderer can neither prove nor disprove it.
 *
 * Also prints the surface range each mover owns, which is what `bsp-mesh.ts`
 * splits out of the static world batch -- a mover with zero surfaces moves
 * invisibly however correct the physics is.
 */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { buildCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import { buildEntities, findSpawn } from '../../src/game/entities.js';
import { Game } from '../../src/game/game.js';
import { Weapon } from '../../src/game/weapons.js';

const [pak, mapArg, atArg, ticksArg] = process.argv.slice(2);
if (!pak) {
  console.error('usage: doors.ts <pak.pk3> [map] [x,y,z] [ticks]');
  process.exit(1);
}

const fs = new Pk3FileSystem();
await fs.mount(basename(pak), await openAsBlob(pak));
const map = mapArg ?? fs.listMaps()[0];
if (!map) {
  throw new Error(`no maps in ${pak}`);
}
const bytes = await fs.readFile(`maps/${map}.bsp`);
if (!bytes) {
  throw new Error(`no maps/${map}.bsp in ${pak}`);
}
const bsp = parseBsp(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
);
const model = buildCollisionModel(bsp);
const entities = buildEntities(parseEntities(bsp.entities));

// `findSpawn` returns null on a map with no `info_player_deathmatch`, which is
// most defrag maps -- they use `info_player_start`. Pass a coordinate for those.
const spawn = findSpawn(entities);
const at: [number, number, number] = atArg
  ? (atArg.split(',').map(Number) as [number, number, number])
  : spawn
    ? [spawn.origin[0], spawn.origin[1], spawn.origin[2]]
    : [0, 0, 0];

const game = new Game({
  world: model,
  origin: at,
  weapon: Weapon.ROCKET_LAUNCHER,
  entities,
  spawn: { origin: at, yaw: 0 },
});

const movers = game.movers;
if (!movers || !movers.movers.length) {
  console.log(`${map}: no movers`);
  process.exit(0);
}

console.log(`${map}: standing at ${at.join(',')}`);
for (const m of movers.movers) {
  const bmodel = bsp.models[m.submodel];
  console.log(
    `  #${m.entityNum} ${m.entity.classname} *${m.submodel} ` +
      `targetname=${m.targetname ?? '-'} target=${m.target ?? '-'} ` +
      `pos1=[${[...m.pos1].map(Math.round)}] pos2=[${[...m.pos2].map(Math.round)}] ` +
      `dur=${m.pos.trDuration}ms wait=${m.wait}ms ` +
      `surfaces=${bmodel ? bmodel.numSurfaces : 0}` +
      `${bmodel && bmodel.numSurfaces === 0 ? '  <-- NOTHING TO DRAW' : ''}`,
  );
}

const last = movers.movers.map(() => '');
const ticks = Number(ticksArg ?? 1500);

const walkIndex = process.argv.indexOf('--walk');
const walkYaw = walkIndex >= 0 ? Number(process.argv[walkIndex + 1]) : null;
const useIndex = process.argv.indexOf('--use');
const useName = useIndex >= 0 ? process.argv[useIndex + 1] : null;

if (useName) {
  movers.useTargets(useName);
  console.log(`  used "${useName}"`);
}

let touchLog = 0;
for (let i = 0; i < ticks; i++) {
  const frame = game.step(
    walkYaw === null ? {} : { forward: 127, yaw: walkYaw },
  );
  void frame;
  // What the move bumped into. This is the button's whole mechanism, so seeing
  // it empty is the answer when a button never fires.
  for (let t = 0; t < game.sim.pm.numtouch && touchLog < 12; t++) {
    console.log(`  ${String(game.time).padStart(6)}ms  touched entity ${game.sim.pm.touchents[t]}`);
    touchLog++;
  }
  if (i === 0 || i === ticks - 1) {
    const o = game.ps.origin;
    console.log(
      `  ${String(game.time).padStart(6)}ms  player at ` +
        `${[...o].map((v) => v.toFixed(1)).join(',')} ground=${game.onGround}`,
    );
  }
  movers.movers.forEach((m, n) => {
    const now = [...m.currentOrigin].map((v) => v.toFixed(1)).join(',');
    if (now !== last[n]) {
      last[n] = now;
      console.log(`  ${String(game.time).padStart(6)}ms  #${m.entityNum} -> ${now}`);
    }
  });
}
