/**
 * Build `public/<course>.pk3` for each bundled course, from OpenArena assets.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run download-assets      # fetches the images
 *   npm run build-oapak
 *
 * ## Why this exists at all
 *
 * `ob_basics` is the tutorial course, and it is the one map that has to work on
 * a clean clone with no Quake III installation. A first map that needs
 * commercial assets is not a first map. It was retextured onto OpenArena names
 * for exactly that reason, and this assembles what it now asks for. `ob_rockets`
 * (the rocket/grenade-jump tutorial) is built the same way and happens to need
 * the exact same texture set; `ob_crypt` (pads, strafe gaps, two overbounces,
 * two rocket walls, a scripted camera -- see .agent/plans/OB-CRYPT.md) uses a
 * different set on purpose, so the kit is now per course rather than shared.
 *
 * Unlike `build-devpak`, nothing here comes from the user's own Quake III: OA
 * content is GPLv2 and freely redistributable, so these paks can be shared,
 * committed or served without the licensing problem retail assets carry. That
 * is the whole point of the exercise.
 *
 * ## What goes in
 *
 * Per course, in `COURSES` below. The two tutorials reference the same eight
 * shaders -- three are `common/` nodraw (caulk, clip, trigger) and never
 * render, so their requirement is five images and one shader script:
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
 * `dimclouds` layers ARE the sky; there is no skybox to fetch. `ob_crypt`'s
 * `skies/nitesky` is the same shape with `stars` + `nitesky` layers.
 *
 * `ob_crypt` also ships `scripts/ob_crypt.shader` from the repo root: three
 * OpenArena shader definitions copied out of oalite.shader/liquid_lavas.shader
 * rather than those files whole, because a mounted pak's shader scripts apply
 * to every course by NAME, and the whole files would attach ~200 definitions
 * with unbundled stage images to any other map using the same texture names.
 * `ob_yard` does the same with `scripts/ob_yard.shader` (the pulsing pad and
 * the blue light strip) and is the first course on a real six-image skybox.
 *
 * Whatever a kit lists, the compiled BSP is the authority: `checkShaders`
 * reads its shader lump and refuses to build a pak that leaves any
 * non-`common/` shader without either a bundled image of the same name or a
 * definition in a bundled script. Earlier this was done by hand ("confirmed by
 * reading both compiled BSPs' LUMP_SHADERS"); now it is mechanical, and a
 * texture added in the editor but not here fails the build instead of drawing
 * a checkerboard.
 *
 * Item pickups (`ob_rockets` places a rocket launcher, a grenade launcher,
 * ammo and health; `ob_crypt` and `ob_yard` a rocket launcher, ammo and
 * health) are NOT
 * bundled here -- `build-startpak.ts`'s `pak0.pk3` already carries every model
 * the project's `ITEMS` table names, mounted alongside this pak at the same
 * `PakGroup.Fallback`, so there is nothing course-specific to add for them.
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
 *
 * `levelshots/<course>.{jpg,png}` goes in too when the repo's `levelshots/`
 * directory has one (jpg preferred -- it is the smaller file and the engine's
 * `findImage` resolves either). It is the backdrop course-select's tile, the
 * loading screen and the results bar all look up as `levelshots/<mapName>`, so
 * bundling it is what makes a bundled course show its own screenshot instead of
 * the placeholder. It is optional: a course with no shot yet still builds.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { openAsBlob } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pk3FileSystem } from '../src/assets/pk3.js';
import { parseBsp } from '../src/collision/bsp.js';
import { writeZip } from './pk3-writer.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface CourseKit {
  /** Images the manifest downloads under assets/oa/, relative to the repo root. */
  images: readonly string[];
  /** Shader scripts lifted out of oa-pak0, which already has them. */
  oaScripts: readonly string[];
  /** Shader scripts kept in this repo's own scripts/ directory. */
  repoScripts: readonly string[];
}

const CLANG_KIT: CourseKit = {
  images: [
    'textures/base_floor/achtung_clang.jpg',
    'textures/base_floor/clang_floor.jpg',
    'textures/base_floor/clang_floor2.jpg',
    'textures/base_floor/clangdark.jpg',
    'textures/skies/dimclouds.jpg',
  ],
  oaScripts: ['scripts/oasky.shader'],
  repoScripts: [],
};

const CRYPT_KIT: CourseKit = {
  images: [
    'textures/gothic_floor/largerblock3b3.jpg',
    'textures/gothic_floor/metalbridge06.jpg',
    'textures/gothic_block/blocks18c.jpg',
    'textures/gothic_block/blocks15.jpg',
    'textures/gothic_block/blocks11b.jpg',
    'textures/gothic_wall/iron01_e.jpg',
    'textures/gothic_wall/streetbricks10.jpg',
    'textures/gothic_trim/pitted_rust3.jpg',
    'textures/gothic_trim/metalsupport4b.jpg',
    'textures/sfx/bouncepad01_block17.jpg',
    'textures/gothic_light/ironcrosslt2_5000.jpg',
    'textures/gothic_light/ironcrosslt2_5000_blend.jpg',
    'textures/gothic_light/pentagram_light1_3k.jpg',
    'textures/gothic_light/pentagram_light1_3k_blend.jpg',
    'textures/skies/stars.jpg',
    'textures/skies/nitesky.jpg',
    'textures/liquids/lavahell.jpg',
  ],
  oaScripts: ['scripts/oasky.shader'],
  repoScripts: ['scripts/ob_crypt.shader'],
};

/**
 * ob_yard (.agent/plans/OB-YARD.md): q3dm17's base_* palette over a real
 * skybox. `skies2/nebula3` is `skyparms env/nebulae/nebulae2 2048 -`, so its
 * six faces live under env/ rather than textures/ -- the one kit entry that
 * is not a texture.
 */
const YARD_KIT: CourseKit = {
  images: [
    'textures/base_floor/diamond2c.jpg',
    'textures/base_trim/pewter.jpg',
    'textures/base_wall/bluemetal2.jpg',
    'textures/base_support/support1_1.jpg',
    'textures/base_trim/xred1_2.jpg',
    'textures/base_light/proto_lightblue.jpg',
    'textures/sfx/bouncepad01_diamond2cTGA.jpg',
    'textures/clown/circ4glow.tga',
    'env/nebulae/nebulae2_bk.jpg',
    'env/nebulae/nebulae2_dn.jpg',
    'env/nebulae/nebulae2_ft.jpg',
    'env/nebulae/nebulae2_lf.jpg',
    'env/nebulae/nebulae2_rt.jpg',
    'env/nebulae/nebulae2_up.jpg',
  ],
  oaScripts: ['scripts/oasky.shader'],
  repoScripts: ['scripts/ob_yard.shader'],
};

const OA_PAK = 'assets/pk3/oa-pak0.pk3';

/** Every bundled course this script builds a pak for. */
const COURSES: Record<string, CourseKit> = {
  ob_basics: CLANG_KIT,
  ob_rockets: CLANG_KIT,
  ob_crypt: CRYPT_KIT,
  ob_yard: YARD_KIT,
};

/**
 * Shader names a BSP may reference without the pak carrying anything for
 * them: the `common/` tool shaders, and the flare shaders `q3map_flare`
 * directives write into the lump (`flareShader`, `flares/lava`) -- the
 * renderer draws no flares at all (bsp-mesh.ts: "Deliberately NOT included").
 */
function isToolShader(name: string): boolean {
  return name.startsWith('common/') || name === 'noshader' || name === 'flareshader' || name.startsWith('flares/');
}

/** Shader definitions (`textures/x/y` header lines) declared in one script's text. */
function declaredShaders(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*textures\/(\S+)\s*$/.exec(line);
    if (m) {
      out.add(m[1]!);
    }
  }
  return out;
}

/**
 * The BSP's shader lump against what is going into the pak. Returns the
 * shaders that would draw as a missing-texture checkerboard.
 */
function checkShaders(
  bsp: Uint8Array,
  entries: readonly { path: string; data: Uint8Array }[],
): string[] {
  // Case-insensitive throughout: Quake hashes shader names with Q_stricmp and
  // pk3.ts lowercases every path it resolves, so `pentagram_light1_3K` (how
  // the compiler's retail shader list spells it, and therefore how the BSP
  // does) finds OpenArena's lowercase image and definition at runtime.
  const images = new Set(entries.map((e) => e.path.replace(/\.(jpg|tga|png)$/, '').toLowerCase()));
  const declared = new Set<string>();
  for (const e of entries) {
    if (e.path.endsWith('.shader')) {
      for (const name of declaredShaders(new TextDecoder().decode(e.data))) {
        declared.add(name.toLowerCase());
      }
    }
  }
  const missing: string[] = [];
  const buffer = bsp.buffer.slice(bsp.byteOffset, bsp.byteOffset + bsp.byteLength) as ArrayBuffer;
  for (const shader of parseBsp(buffer).shaders) {
    const name = shader.shader.replace(/^textures\//, '').toLowerCase();
    if (isToolShader(name) || images.has(`textures/${name}`) || declared.has(name)) {
      continue;
    }
    missing.push(name);
  }
  return missing;
}

async function buildCoursePak(oaPak: Pk3FileSystem, course: string, kit: CourseKit): Promise<void> {
  const out = `public/${course}.pk3`;
  const mapBsp = `public/maps/${course}.bsp`;
  const camScript = `scripts/${course}.cam`;

  const entries: { path: string; data: Uint8Array }[] = [];
  const missing: string[] = [];

  for (const rel of kit.images) {
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
  const bsp = new Uint8Array(readFileSync(join(root, mapBsp)));
  entries.push({ path: `maps/${course}.bsp`, data: bsp });

  if (!existsSync(join(root, camScript))) {
    console.error(`${camScript} not found. It is this project's own file, not fetched.`);
    process.exit(1);
  }
  entries.push({ path: camScript, data: new Uint8Array(readFileSync(join(root, camScript))) });

  // jpg first: it is the smaller file and `findImage` tries .jpg before .png,
  // so a jpg placed later wins over a png without having to remove the png.
  const levelshot = ['jpg', 'png']
    .map((ext) => `levelshots/${course}.${ext}`)
    .find((rel) => existsSync(join(root, rel)));
  if (levelshot) {
    entries.push({ path: levelshot, data: new Uint8Array(readFileSync(join(root, levelshot))) });
  } else {
    console.warn(`  (no levelshots/${course}.{jpg,png} -- course-select will show the placeholder)`);
  }

  for (const script of kit.oaScripts) {
    const bytes = await oaPak.readFile(script);
    if (!bytes) {
      console.error(`${script} is not in ${OA_PAK}.`);
      process.exit(1);
    }
    entries.push({ path: script, data: bytes });
  }
  for (const script of kit.repoScripts) {
    if (!existsSync(join(root, script))) {
      console.error(`${script} not found. It is this project's own file, not fetched.`);
      process.exit(1);
    }
    entries.push({ path: script, data: new Uint8Array(readFileSync(join(root, script))) });
  }

  const unresolved = checkShaders(bsp, entries);
  if (unresolved.length) {
    console.error(
      `${mapBsp} references ${unresolved.length} shader(s) this pak would not resolve:\n` +
        unresolved.map((s) => `  ${s}`).join('\n') +
        "\n\nAdd the image to the course's kit in tools/build-oapak.ts (and to " +
        'tools/assets.manifest.json), or the shader definition to a bundled script.',
    );
    process.exit(1);
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

  for (const [course, kit] of Object.entries(COURSES)) {
    await buildCoursePak(oaPak, course, kit);
  }

  console.log('\n  All GPLv2 OpenArena content -- no Quake III installation needed.');
}

await main();
