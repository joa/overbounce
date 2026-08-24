/**
 * Build `public/<course>.pk3` for each bundled tutorial course, from
 * OpenArena assets.
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
 * for exactly that reason, and this assembles what it now asks for. `ob_rockets`
 * (the rocket/grenade-jump tutorial) is built the same way and happens to need
 * the exact same texture set -- confirmed by reading both compiled BSPs'
 * `LUMP_SHADERS`, not assumed from the name -- so one script builds both rather
 * than duplicating this file per course.
 *
 * Unlike `build-devpak`, nothing here comes from the user's own Quake III: OA
 * content is GPLv2 and freely redistributable, so these paks can be shared,
 * committed or served without the licensing problem retail assets carry. That
 * is the whole point of the exercise.
 *
 * ## What goes in
 *
 * Both maps reference the same eight shaders. Three are `common/` nodraw --
 * caulk, clip, trigger -- and never render, so the requirement is five images
 * and one shader script:
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
 * Item pickups (`ob_rockets` places a rocket launcher, a grenade launcher,
 * ammo and health) are NOT bundled here -- `build-startpak.ts`'s `pak0.pk3`
 * already carries every model the project's `ITEMS` table names, mounted
 * alongside this pak at the same `PakGroup.Fallback`, so there is nothing
 * course-specific to add for them.
 *
 * The compiled `maps/<course>.bsp` goes in too, at the normal Quake path
 * `maps/<course>.bsp` inside the zip. Without it this was a texture-only pak
 * that course select could not do anything with: listing a course means
 * finding a `maps/*.bsp` entry in a mounted `Pk3FileSystem`
 * (`Pk3FileSystem.listMaps`), and a pak with only images and a shader has none.
 * Bundling the bsp turns this into what a player's own map pack already is --
 * a self-contained course -- rather than something course select needs a
 * special case for.
 *
 * `scripts/<course>.cam` goes in too, straight from the repo root (a plain
 * text sidecar, not compiled) -- its presence is what makes `camera: auto`
 * resolve to the side view instead of `chase` at Start Run
 * (`course-select.ts`'s `resolveAutoCamera`). See
 * `.agent/docs/side-locked-courses.md` for why these courses, specifically,
 * are built to earn that: their `mcp-clips` brushes wall the whole thing into
 * a flat Y corridor, so the side view has no depth left to fight.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { openAsBlob } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pk3FileSystem } from '../src/assets/pk3.js';
import { writeZip } from './pk3-writer.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What the manifest downloads, relative to the repo root. Shared by every course. */
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

/** One bundled tutorial course. */
const COURSES = ['ob_basics', 'ob_rockets'];

async function buildCoursePak(oaPak: Pk3FileSystem, course: string): Promise<void> {
  const out = `public/${course}.pk3`;
  const mapBsp = `public/maps/${course}.bsp`;
  const camScript = `scripts/${course}.cam`;

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

  if (!existsSync(join(root, mapBsp))) {
    console.error(
      `${mapBsp} not found. It is not fetched by download-assets -- it is this ` +
        `project's own map, compiled from maps/${course}.map -- so there is ` +
        'nothing to run here except compiling it yourself and placing the ' +
        'result there.',
    );
    process.exit(1);
  }
  entries.push({ path: `maps/${course}.bsp`, data: new Uint8Array(readFileSync(join(root, mapBsp))) });

  if (!existsSync(join(root, camScript))) {
    console.error(`${camScript} not found. It is this project's own file, not fetched.`);
    process.exit(1);
  }
  entries.push({ path: camScript, data: new Uint8Array(readFileSync(join(root, camScript))) });

  for (const script of SCRIPTS) {
    const bytes = await oaPak.readFile(script);
    if (!bytes) {
      console.error(`${script} is not in ${OA_PAK}.`);
      process.exit(1);
    }
    entries.push({ path: script, data: bytes });
  }

  const zip = writeZip(entries);
  mkdirSync(join(root, dirname(out)), { recursive: true });
  writeFileSync(join(root, out), zip);

  console.log(`${out}`);
  console.log(`  ${entries.length} files, ${(zip.length / 1024).toFixed(0)}KB`);
  for (const e of entries) {
    console.log(`    ${e.path}  ${(e.data.length / 1024).toFixed(0)}KB`);
  }
  console.log(`  http://localhost:5173/?devpak=${course}.pk3&map=${course}`);
}

async function main(): Promise<void> {
  if (!existsSync(join(root, OA_PAK))) {
    console.error(
      `${OA_PAK} not found, and it is where the sky shader comes from.\n` +
        'Run `npm run download-assets` first.',
    );
    process.exit(1);
  }
  const oaPak = new Pk3FileSystem();
  await oaPak.mount('oa-pak0.pk3', await openAsBlob(join(root, OA_PAK)));

  for (const course of COURSES) {
    await buildCoursePak(oaPak, course);
  }

  console.log('\n  All GPLv2 OpenArena content -- no Quake III installation needed.');
}

await main();
