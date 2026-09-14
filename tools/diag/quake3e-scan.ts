/**
 * The two Quake3e renderer ideas that can be measured headlessly, measured.
 *
 *     npx tsx tools/diag/quake3e-scan.ts [lattice-step]
 *
 * Reads every bundled map (maps/*.bsp, public/maps/*.bsp, and the .bsp inside
 * public/dev-q3*.pk3, acc_fuzzle.pk3 and de4th_*.pk3) and prints, per map:
 *
 *   - world batches keyed (shader, lightmap page, fog) as bsp-mesh keys them,
 *     against the same key with every lightmap page merged into one atlas.
 *     Surface-level keys, so an upper bound on bsp-mesh's own count.
 *   - how far `sampleLightGrid` (id: at the +edge the neighbour step wraps to
 *     the next row) differs from Quake3e's guarded loop (neighbour skipped),
 *     over a lattice of points in the world bounds.
 *   - which item / weapon / spawn / target_position / misc_model origins sit
 *     in a cell where the two disagree, since those are what the grid lights.
 *
 * Written for `.agent/plans/QUAKE3E.md`, sections 1 and 3.
 */
import { openAsBlob, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseBsp } from '../../src/collision/bsp.js';
import type { BspFile } from '../../src/collision/bsp.js';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import {
  AMBIENT_SCALE,
  MIN_LIGHT_ADD,
  gridSizeFromEntities,
  parseLightGrid,
  sampleLightGrid,
} from '../../src/render/light-grid.js';
import type { LightGrid } from '../../src/render/light-grid.js';

const STEP = Number(process.argv[2] ?? 24);

/**
 * id's `R_SetupEntityLightingGrid`, WITHOUT the neighbour guard `light-grid.ts`
 * now carries: at the +edge the step wraps into the next row or layer. Only the
 * end of the lump is guarded, which is what the port did before the guard went
 * in. `sampleLightGrid` is the guarded (Quake3e) side of the comparison.
 */
function sampleUnguarded(grid: LightGrid, point: ArrayLike<number>): { amb: number[]; dir: number[]; lit: boolean } {
  const pos = [0, 0, 0];
  const frac = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = (point[i] - grid.origin[i]) / grid.size[i];
    pos[i] = Math.floor(v);
    frac[i] = v - pos[i];
    if (pos[i] < 0) {
      pos[i] = 0;
    } else if (pos[i] > grid.bounds[i] - 1) {
      pos[i] = grid.bounds[i] - 1;
    }
  }
  const step = [8, 8 * grid.bounds[0], 8 * grid.bounds[0] * grid.bounds[1]];
  const base = pos[0] * step[0] + pos[1] * step[1] + pos[2] * step[2];
  const amb = [0, 0, 0];
  const dir = [0, 0, 0];
  let total = 0;
  for (let i = 0; i < 8; i++) {
    let factor = 1;
    let at = base;
    let j = 0;
    for (; j < 3; j++) {
      if (i & (1 << j)) {
        factor *= frac[j];
        at += step[j];
      } else {
        factor *= 1 - frac[j];
      }
    }
    if (j !== 3 || at + 8 > grid.data.length) {
      continue;
    }
    const d = grid.data;
    if (!(d[at] + d[at + 1] + d[at + 2])) {
      continue;
    }
    total += factor;
    for (let c = 0; c < 3; c++) {
      amb[c] += factor * d[at + c];
      dir[c] += factor * d[at + 3 + c];
    }
  }
  if (total > 0 && total < 0.99) {
    for (let c = 0; c < 3; c++) {
      amb[c] /= total;
      dir[c] /= total;
    }
  }
  for (let c = 0; c < 3; c++) {
    amb[c] = Math.min(amb[c] * AMBIENT_SCALE + MIN_LIGHT_ADD, 255);
  }
  return { amb, dir, lit: total > 0 };
}

function disagreement(grid: LightGrid, p: ArrayLike<number>): { d: number; lit: boolean } {
  const a = sampleLightGrid(grid, p);
  const b = sampleUnguarded(grid, p);
  let d = 0;
  for (let c = 0; c < 3; c++) {
    d = Math.max(d, Math.abs(a.ambient[c] - b.amb[c]), Math.abs(a.directed[c] - b.dir[c]));
  }
  return { d, lit: b.lit || a.ambient[0] !== MIN_LIGHT_ADD };
}

const GRID_LIT = /^(item_|weapon_|ammo_|holdable_|info_player|team_CTF|target_position|misc_model)/;

function scan(name: string, bsp: BspFile): void {
  const m0 = bsp.models[0];
  const pages = Math.floor(bsp.lightmaps.length / (128 * 128 * 3));
  const perPage = new Set<string>();
  const atlas = new Set<string>();
  for (let s = m0.firstSurface; s < m0.firstSurface + m0.numSurfaces; s++) {
    const surf = bsp.surfaces[s];
    if (surf.surfaceType === 0 || surf.surfaceType === 4) {
      continue; // BAD, FLARE
    }
    perPage.add(`${surf.shaderNum}|${surf.lightmapNum}|${surf.fogNum}`);
    atlas.add(`${surf.shaderNum}|${surf.lightmapNum >= 0 ? 'atlas' : surf.lightmapNum}|${surf.fogNum}`);
  }
  console.log(`${name}: ${pages} lightmap pages, world batches ${perPage.size} -> ${atlas.size} with an atlas`);

  const grid = parseLightGrid(bsp.lightGrid, m0.mins, m0.maxs, gridSizeFromEntities(bsp.entities));
  if (!grid) {
    console.log('  light grid: absent');
    return;
  }
  const band = [0, 1, 2].map((i) => m0.maxs[i] - (grid.origin[i] + (grid.bounds[i] - 1) * grid.size[i]));
  let lit = 0;
  let differ = 0;
  let max = 0;
  const p = [0, 0, 0];
  for (p[2] = m0.mins[2]; p[2] < m0.maxs[2]; p[2] += STEP) {
    for (p[1] = m0.mins[1]; p[1] < m0.maxs[1]; p[1] += STEP) {
      for (p[0] = m0.mins[0]; p[0] < m0.maxs[0]; p[0] += STEP) {
        const r = disagreement(grid, p);
        if (!r.lit) {
          continue;
        }
        lit++;
        if (r.d > 0.5) {
          differ++;
        }
        max = Math.max(max, r.d);
      }
    }
  }
  console.log(
    `  light grid ${grid.bounds.join('x')}, +edge strip ${band.map((b) => b.toFixed(0)).join(',')}u: ` +
      `${differ}/${lit} lit lattice points differ (${((100 * differ) / Math.max(lit, 1)).toFixed(2)}%), max ${max.toFixed(1)}`,
  );

  let total = 0;
  for (const block of bsp.entities.split('}')) {
    const cls = /"classname"\s*"([^"]*)"/.exec(block)?.[1];
    const org = /"origin"\s*"([^"]*)"/.exec(block)?.[1];
    if (!cls || !org || !GRID_LIT.test(cls)) {
      continue;
    }
    total++;
    const o = org.trim().split(/\s+/).map(Number);
    const r = disagreement(grid, [o[0], o[1], o[2] + 24]);
    if (r.d > 0.5) {
      console.log(`  ENTITY ${cls} @ ${org}: differs by ${r.d.toFixed(1)}`);
    }
  }
  console.log(`  ${total} entity origins checked`);
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function main(): Promise<void> {
  // public/maps carries copies of the committed maps/*.bsp; scan each name once.
  const seen = new Set<string>();
  for (const dir of ['maps', 'public/maps']) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.bsp'))) {
      const name = basename(f, '.bsp');
      if (!seen.has(name)) {
        seen.add(name);
        scan(name, parseBsp(arrayBufferOf(readFileSync(join(dir, f)))));
      }
    }
  }
  const paks = readdirSync('public').filter(
    (f) => f.startsWith('dev-q3') || f === 'acc_fuzzle.pk3' || f.startsWith('de4th_run'),
  );
  for (const pak of paks) {
    const fs = new Pk3FileSystem();
    await fs.mount(pak, await openAsBlob(join('public', pak)));
    const map = basename(pak, '.pk3').replace(/^dev-/, '');
    const bytes = await fs.readFile(`maps/${map}.bsp`);
    if (bytes) {
      scan(map, parseBsp(arrayBufferOf(bytes)));
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
