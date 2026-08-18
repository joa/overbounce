/**
 * Overbounce heights, and where a map lets you fall from one.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Usage:
 *   npm run spots                                    # the height table alone
 *   npm run spots -- --paks "D:/.../baseq3" --map q3dm6
 *
 * WHAT AN OVERBOUNCE SPOT ACTUALLY IS
 *
 * An overbounce needs a fall to end with the player's feet between 0.125 and
 * 0.25 units above a surface. Measured against floors at z=0, 128, -304, 1000.5
 * and -2048.25, the set of drop heights that do this is IDENTICAL — the
 * absolute height of the floor is irrelevant, and so is its fractional part.
 *
 * So the height table is a property of the PHYSICS, not of any map. It can be
 * computed once. What a map contributes is only which of those heights you can
 * actually fall from: a famous "overbounce spot" is a place where a real ledge
 * happens to sit one of these distances above a real floor.
 *
 * That also means this tool cannot verify our spots against Quake's. The
 * community documents spots positionally, never numerically, and the physics
 * half is universal anyway. What it does show is that the mechanism behaves on
 * real id geometry exactly as it does on a test plane.
 */

import { openAsBlob, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pk3FileSystem } from '../src/assets/pk3.js';
import { parseBsp } from '../src/collision/bsp.js';
import { buildCollisionModel } from '../src/collision/cm-load.js';
import type { CollisionModel } from '../src/collision/model.js';
import { axialBrush } from '../src/collision/brush.js';
import { brushListModel } from '../src/collision/model.js';
import { boxTrace } from '../src/collision/trace.js';
import { createTrace } from '../src/physics/types.js';
import { vec3 } from '../src/math/vec3.js';
import { CONTENTS_SOLID, MASK_PLAYERSOLID } from '../src/physics/constants.js';
import { Simulation } from '../src/physics/simulate.js';

const PLAYER_MINS = vec3(-15, -15, -24);
const PLAYER_MAXS = vec3(15, 15, 32);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const num = (name: string, fallback: number): number => Number(arg(name, String(fallback)));

/** Contiguous run of drop heights that overbounce. */
export interface ObBand {
  from: number;
  to: number;
  /** Fastest horizontal speed reached in the band, from `hspeed` in. */
  speed: number;
}

/**
 * Compute the drop heights that overbounce, on a bare test plane.
 *
 * Valid for every floor in every map: see the note at the top of this file.
 */
export function overbounceBands(
  maxHeight: number,
  hspeed = 100,
  step = 0.0625,
): ObBand[] {
  const world = brushListModel([
    axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
  ]);

  const bands: ObBand[] = [];
  let current: ObBand | null = null;

  for (let h = 8; h <= maxHeight; h += step) {
    const sim = new Simulation({ world, origin: [0, 0, 24 + h], velocity: [hspeed, 0, 0] });
    let best = hspeed;
    let grounded = 0;
    for (let i = 0; i < 600; i++) {
      sim.step({});
      best = Math.max(best, sim.speed);
      if (sim.onGround) {
        if (++grounded > 3) break;
      } else {
        grounded = 0;
      }
    }

    if (best > hspeed * 1.6) {
      if (current && h - current.to <= step * 1.5) {
        current.to = h;
        current.speed = Math.max(current.speed, best);
      } else {
        current = { from: h, to: h, speed: best };
        bands.push(current);
      }
    }
  }

  return bands;
}

async function mountPaks(dir: string): Promise<Pk3FileSystem> {
  const fs = new Pk3FileSystem();
  for (const n of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pk3')).sort()) {
    await fs.mount(n, await openAsBlob(join(dir, n)));
  }
  return fs;
}

/** Every standable surface height in a column, from the top down. */
function surfacesInColumn(
  model: CollisionModel,
  tr: ReturnType<typeof createTrace>,
  x: number,
  y: number,
  top: number,
  bottom: number,
): number[] {
  const out: number[] = [];
  const probe = vec3(x, y, 0);
  let z = top;

  // A Quake map is a sealed box, so a trace from the top of the world bounds
  // starts inside the shell. Descend until the player would fit, then trace.
  while (z > bottom && out.length < 12) {
    probe[2] = z;
    boxTrace(model, tr, probe, PLAYER_MINS, PLAYER_MAXS, probe, MASK_PLAYERSOLID);
    if (tr.startsolid) {
      z -= 16;
      continue;
    }

    boxTrace(model, tr, vec3(x, y, z), PLAYER_MINS, PLAYER_MAXS, vec3(x, y, bottom), MASK_PLAYERSOLID);
    if (tr.fraction === 1) {
      break; // open all the way down
    }
    const feet = tr.endpos[2] - 24;
    if (tr.plane.normal[2] >= 0.7) {
      out.push(feet);
    }
    z = feet - 40; // drop below this surface and keep looking
  }

  return out;
}

async function main(): Promise<void> {
  const maxHeight = num('max', 512);
  const hspeed = num('hspeed', 100);

  console.log('Overbounce drop heights (identical for every floor, any map):\n');
  const t0 = Date.now();
  const bands = overbounceBands(maxHeight, hspeed);
  console.log(`  ${bands.length} bands up to ${maxHeight} units, found in ${Date.now() - t0}ms\n`);
  console.log(['from', 'to', 'width', 'gap', 'ups'].join('\t'));
  bands.slice(0, 18).forEach((b, i) => {
    const gap = i ? (b.from - bands[i - 1].from).toFixed(2) : '-';
    console.log(
      [b.from.toFixed(3), b.to.toFixed(3), (b.to - b.from).toFixed(3), gap, Math.round(b.speed)].join('\t'),
    );
  });
  if (bands.length > 18) console.log(`... and ${bands.length - 18} more`);

  const paksDir = arg('paks', '');
  const mapName = arg('map', '');
  if (!paksDir || !mapName) {
    console.log('\n(pass --paks and --map to scan a map for reachable drops)');
    return;
  }
  if (!existsSync(paksDir)) {
    console.error(`no such directory: ${paksDir}`);
    process.exit(1);
  }

  const fs = await mountPaks(paksDir);
  const data = await fs.readFile(`maps/${mapName}.bsp`);
  if (!data) {
    console.error(`"${mapName}" not found. Available: ${fs.listMaps().join(', ')}`);
    process.exit(1);
  }
  const model = buildCollisionModel(
    parseBsp(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer),
  );

  const step = num('step', 32);
  const world = model.submodels[0];
  const mins = world ? world.mins : [-4096, -4096, -4096];
  const maxs = world ? world.maxs : [4096, 4096, 4096];

  console.log(
    `\n\n${mapName}: ${model.brushes.length} brushes, ${model.numPatches} patches, ` +
      `scanning on a ${step}-unit grid`,
  );

  const tr = createTrace();
  const hits: { x: number; y: number; upper: number; lower: number; drop: number }[] = [];
  let columns = 0;
  let stacked = 0;

  for (let x = mins[0]; x <= maxs[0]; x += step) {
    for (let y = mins[1]; y <= maxs[1]; y += step) {
      columns++;
      const surfaces = surfacesInColumn(model, tr, x, y, maxs[2], mins[2]);
      if (surfaces.length < 2) continue;
      stacked++;

      // Every ledge above every floor beneath it.
      for (let i = 0; i < surfaces.length - 1; i++) {
        for (let j = i + 1; j < surfaces.length; j++) {
          const drop = surfaces[i] - surfaces[j];
          if (drop < 8 || drop > maxHeight) continue;
          if (bands.some((b) => drop >= b.from && drop <= b.to)) {
            hits.push({ x, y, upper: surfaces[i], lower: surfaces[j], drop });
          }
        }
      }
    }
  }

  console.log(
    `${columns} columns, ${stacked} with stacked surfaces, ` +
      `${hits.length} ledge/floor pairs land on an overbounce height.\n`,
  );

  console.log(['x', 'y', 'ledgeZ', 'floorZ', 'drop'].join('\t'));
  for (const h of hits.slice(0, 25)) {
    console.log(
      [Math.round(h.x), Math.round(h.y), h.upper.toFixed(2), h.lower.toFixed(2), h.drop.toFixed(3)].join('\t'),
    );
  }
  if (hits.length > 25) console.log(`... and ${hits.length - 25} more`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
