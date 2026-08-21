/**
 * Build `public/ob_basics.pk3` from OpenArena assets.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run download-assets      # fetches the five images
 *   npm run build-oapak
 *
 * ## Why this exists at all
 *
 * `ob_basics` is the tutorial course, and it is the one map that has to work on
 * a clean clone with no Quake III installation. A first map that needs
 * commercial assets is not a first map. It was retextured onto OpenArena names
 * for exactly that reason, and this assembles what it now asks for.
 *
 * Unlike `build-devpak`, nothing here comes from the user's own Quake III: OA
 * content is GPLv2 and freely redistributable, so this pak can be shared,
 * committed or served without the licensing problem retail assets carry. That
 * is the whole point of the exercise.
 *
 * ## What goes in
 *
 * The map references eight shaders. Three are `common/` nodraw -- caulk, clip,
 * trigger -- and never render, so the requirement is five images and one shader
 * script:
 *
 *   textures/base_floor/{achtung_clang,clang_floor,clang_floor2,clangdark}.jpg
 *   textures/skies/dimclouds.jpg
 *   scripts/oasky.shader
 *
 * The images come from OpenArena's texture SVN through the asset manifest. The
 * SHADER is taken out of `oa-pak0.pk3`, which already carries it -- that
 * download is a libsdl-android build with models, sounds and scripts but no map
 * texture sets at all, which is why the images had to be fetched separately and
 * why "just use the OA pak we already have" does not work.
 *
 * `textures/skies/toxicskytim_dm8` is a `skyParms full 700 -` shader whose two
 * `dimclouds` layers ARE the sky; there is no skybox to fetch.
 *
 * The compiled `maps/ob_basics.bsp` goes in too, at the normal Quake path
 * `maps/ob_basics.bsp` inside the zip. Without it this was a texture-only pak
 * that course select could not do anything with: listing a course means
 * finding a `maps/*.bsp` entry in a mounted `Pk3FileSystem`
 * (`Pk3FileSystem.listMaps`), and a pak with only images and a shader has none.
 * Bundling the bsp turns this into what a player's own map pack already is --
 * a self-contained course -- rather than something course select needs a
 * special case for.
 *
 * `scripts/ob_basics.cam` goes in too, straight from the repo root (a plain
 * text sidecar, not compiled) -- its presence is what makes `camera: auto`
 * resolve to the side view instead of `chase` at Start Run
 * (`course-select.ts`'s `resolveAutoCamera`). See
 * `.agent/docs/side-locked-courses.md` for why this course, specifically, is
 * built to earn that: its `mcp-clips` brushes wall the whole thing into a
 * flat Y corridor, so the side view has no depth left to fight.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { openAsBlob } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pk3FileSystem } from '../src/assets/pk3.js';
import { writeZip } from './pk3-writer.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What the manifest downloads, relative to the repo root. */
const IMAGES = [
  'textures/base_floor/achtung_clang.jpg',
  'textures/base_floor/clang_floor.jpg',
  'textures/base_floor/clang_floor2.jpg',
  'textures/base_floor/clangdark.jpg',
  'textures/skies/dimclouds.jpg',
];

/** Scripts lifted out of oa-pak0, which already has them. */
const SCRIPTS = ['scripts/oasky.shader'];

const OA_PAK = 'assets/pk3/oa-pak0.pk3';
const OUT = 'public/ob_basics.pk3';
const MAP_BSP = 'public/maps/ob_basics.bsp';
const CAM_SCRIPT = 'scripts/ob_basics.cam';

async function main(): Promise<void> {
  const entries: { path: string; data: Uint8Array }[] = [];
  const missing: string[] = [];

  for (const rel of IMAGES) {
    const full = join(root, 'assets/oa', rel);
    if (!existsSync(full)) {
      missing.push(rel);
      continue;
    }
    entries.push({ path: rel, data: new Uint8Array(readFileSync(full)) });
  }

  if (missing.length) {
    console.error(
      `Missing ${missing.length} image(s) under assets/oa/:\n` +
        missing.map((m) => `  ${m}`).join('\n') +
        '\n\nRun `npm run download-assets` first -- they are in the manifest.',
    );
    process.exit(1);
  }

  if (!existsSync(join(root, OA_PAK))) {
    console.error(
      `${OA_PAK} not found, and it is where the sky shader comes from.\n` +
        'Run `npm run download-assets` first.',
    );
    process.exit(1);
  }

  if (!existsSync(join(root, MAP_BSP))) {
    console.error(
      `${MAP_BSP} not found. It is not fetched by download-assets -- it is this ` +
        "project's own map, compiled from maps/ob_basics.map -- so there is " +
        'nothing to run here except compiling it yourself and placing the ' +
        'result there.',
    );
    process.exit(1);
  }
  entries.push({ path: 'maps/ob_basics.bsp', data: new Uint8Array(readFileSync(join(root, MAP_BSP))) });

  if (!existsSync(join(root, CAM_SCRIPT))) {
    console.error(`${CAM_SCRIPT} not found. It is this project's own file, not fetched.`);
    process.exit(1);
  }
  entries.push({ path: CAM_SCRIPT, data: new Uint8Array(readFileSync(join(root, CAM_SCRIPT))) });

  const fs = new Pk3FileSystem();
  await fs.mount('oa-pak0.pk3', await openAsBlob(join(root, OA_PAK)));
  for (const script of SCRIPTS) {
    const bytes = await fs.readFile(script);
    if (!bytes) {
      console.error(`${script} is not in ${OA_PAK}.`);
      process.exit(1);
    }
    entries.push({ path: script, data: bytes });
  }

  const zip = writeZip(entries);
  mkdirSync(join(root, dirname(OUT)), { recursive: true });
  writeFileSync(join(root, OUT), zip);

  console.log(`${OUT}`);
  console.log(`  ${entries.length} files, ${(zip.length / 1024).toFixed(0)}KB`);
  for (const e of entries) {
    console.log(`    ${e.path}  ${(e.data.length / 1024).toFixed(0)}KB`);
  }
  console.log(
    `\n  http://localhost:5173/?devpak=ob_basics.pk3&map=ob_basics\n\n` +
      '  All GPLv2 OpenArena content -- no Quake III installation needed.',
  );
}

await main();
