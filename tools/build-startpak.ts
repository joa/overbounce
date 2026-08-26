/**
 * Build a redistributable "start and play" pak from OpenArena assets.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run download-assets
 *   npm run build-startpak
 *
 * OpenArena is GPLv2 and freely redistributable, unlike retail Quake III
 * content -- see `build-devpak.ts`'s header for the contrast. That is what
 * makes this pak possible at all: a player with nothing of their own can
 * still see an avatar, hold a gun, hear it fire, and pick things up, without
 * pointing Overbounce at a Quake III install first.
 *
 * `assets/pk3/oa-pak0.pk3` (`tools/assets.manifest.json`'s `openarena-pak0`)
 * is a full libsdl-android OpenArena build, not a hand-picked subset --
 * curating it the way `build-devpak.ts` curates a retail baseq3 keeps this
 * pak to what Overbounce actually looks up (`.agent/docs/asset-shopping-list.md`)
 * instead of shipping menu art, gibs and weapon-impact decals nobody here
 * will ever see.
 *
 * No map goes in this pak. `ob_basics.pk3` (`build-oapak.ts`) is a separate
 * file with its own rebuild cadence and its own (original, not third-party)
 * provenance; `main.ts`'s loader mounts both at `PakGroup.Fallback`. Their
 * only overlap is `scripts/oasky.shader`, byte-identical either way since
 * both ultimately come from the same OA source -- harmless.
 *
 * PRECEDENCE NEEDS NO NEW CODE. `Pk3FileSystem` already ranks a mounted
 * archive by group before name (`src/assets/pk3.ts`'s `reindex`), and the
 * loader screen mounts whatever the player drops at `PakGroup.Base` -- one
 * tier above `Fallback`. A player's own Quake III or OpenArena paks win
 * automatically, path for path, with nothing here checking whose file is
 * whose.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pk3FileSystem } from '../src/assets/pk3.js';
import { writeZip } from './pk3-writer.js';
import { mergeShaderFiles, shaderKey } from '../src/assets/shader.js';
import { ITEMS } from '../src/game/items.js';
import { parseMd3 } from '../src/assets/md3.js';
import { listPlayerModels } from '../src/render/md3-mesh.js';
import { parseSkin } from '../src/assets/skin.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'assets/pk3/oa-pak0.pk3';
const OUT = 'public/pak0.pk3';

/**
 * Every fixed sound path `src/audio/sound.ts`'s `SOUNDS` table names directly
 * -- everything NOT keyed by a player model (handled separately, below) or an
 * item classname (handled by the `ITEMS` loop, which already knows its own
 * pickup sounds).
 */
const FIXED_SOUNDS = [
  'sound/player/footsteps/step1.wav',
  'sound/player/footsteps/step2.wav',
  'sound/player/footsteps/step3.wav',
  'sound/player/footsteps/step4.wav',
  'sound/player/footsteps/clank1.wav',
  'sound/player/footsteps/clank2.wav',
  'sound/player/footsteps/clank3.wav',
  'sound/player/footsteps/clank4.wav',
  'sound/player/footsteps/splash1.wav',
  'sound/player/footsteps/splash2.wav',
  'sound/player/footsteps/splash3.wav',
  'sound/player/footsteps/splash4.wav',
  'sound/player/land1.wav',
  'sound/world/jumppad.wav',
  'sound/world/telein.wav',
  'sound/items/wearoff.wav',
  'sound/items/respawn1.wav',
  'sound/items/poweruprespawn.wav',
  'sound/weapons/rocket/rocklf1a.wav',
  'sound/weapons/rocket/rocklx1a.wav',
  // The flyby whoosh -- load-bearing for hearing a double rocket jump.
  'sound/weapons/rocket/rockfly.wav',
  'sound/weapons/grenade/grenlf1a.wav',
  'sound/weapons/grenade/hgrenb1a.wav',
  'sound/weapons/plasma/hyprbf1a.wav',
  'sound/weapons/plasma/plasmx1a.wav',
];

async function main(): Promise<void> {
  if (!existsSync(join(root, SOURCE))) {
    console.error(`${SOURCE} not found.\n\nRun \`npm run download-assets\` first -- it's in the manifest.`);
    process.exit(1);
  }

  const fs = new Pk3FileSystem();
  await fs.mount('oa-pak0.pk3', new Blob([new Uint8Array(readFileSync(join(root, SOURCE)))]));

  const wanted = new Set<string>();
  const add = (paths: string[]): void => paths.forEach((p) => wanted.add(p));
  const missing: string[] = [];

  // The blob shadow's art -- `markShadow` has no shader script of its own,
  // see `src/render/shadow.ts`.
  add(fs.list({ prefix: 'gfx/damage/' }));
  add(fs.list({ prefix: 'scripts/' }).filter((p) => p.endsWith('.shader')));
  // The spheremaps every envmap shader samples (ammo boxes, powerup shells).
  add(fs.list({ prefix: 'textures/effects/' }));

  // Parsed once, used by every closure below.
  const shaderTexts: string[] = [];
  for (const path of fs.list({ prefix: 'scripts/' })) {
    if (path.endsWith('.shader')) {
      const text = await fs.readText(path);
      if (text) {
        shaderTexts.push(text);
      }
    }
  }
  const shaders = mergeShaderFiles(shaderTexts);

  /**
   * One shader/texture reference, resolved exactly the way the game itself
   * resolves it (`shaderForSurface`/`loadMd3` in `md3-mesh.ts`): a real
   * shader wins if one exists under this name, otherwise it's a direct
   * texture path.
   */
  const closeRef = (ref: string): void => {
    const direct = fs.findImage(ref);
    if (direct) {
      wanted.add(direct);
    }
    const shader = shaders.get(shaderKey(ref));
    for (const stage of shader?.stages ?? []) {
      for (const name of [stage.map, ...stage.animFrames]) {
        const image = name ? fs.findImage(name) : null;
        if (image) {
          wanted.add(image);
        }
      }
    }
  };

  /*
   * The plasma bolt's own visual. `CG_Missile` special-cases `WP_PLASMAGUN`
   * before the generic missile-model path: a camera-facing sprite, shader
   * `sprites/plasma1` (`scripts/oanew.shader`, already in `shaders` above),
   * not a model -- so it needs its own `closeRef` rather than falling out of
   * `models/ammo/rocket/`'s closure below. Without this, `main.ts`'s direct
   * `loadTexture(paks, 'sprites/plasmaa.tga')` finds nothing in the shipped
   * pak, `missilePlasmaBalls` stays all-null, and every plasma shot silently
   * renders as the rocket model instead -- the exact bug this closes.
   */
  closeRef('sprites/plasma1');

  /*
   * Every texture an MD3's own surfaces need, direct or shader-routed --
   * same technique as `build-devpak.ts`, see its comments for why guessing
   * from the model's path alone finds a fraction of what a shader-driven
   * surface needs. This is what turned up `rocketFlare`/`rocketThrust`
   * needing textures under textures/oafx/ and textures/flares/, nowhere
   * near models/ammo/rocket/ -- a flat prefix add would have missed them
   * and shipped a rocket with an invisible flare and thrust glow.
   */
  const closeMd3 = async (path: string): Promise<void> => {
    for (const ref of await md3TextureRefs(fs, path)) {
      closeRef(ref);
    }
  };

  /*
   * Every player model this pak ACTUALLY has, per the project's own
   * discovery logic -- not assumed from the directory listing. This pak also
   * carries loose textures under `models/players/grism/` with no `lower.md3`
   * behind them; they don't add up to a real model, and `fs.list` alone
   * cannot tell the difference. `listPlayerModels` can, because it is the
   * same function `main.ts` uses to decide what a player can actually look
   * like.
   *
   * A `.skin` file's own references are a SEPARATE closure from an MD3's
   * embedded ones, and skipping it is how sarge shipped pure white: its
   * default skin (`lower_default.skin`/`upper_default.skin`) points at
   * `models/players/grism/enkiskin.tga` -- a texture that lives in a
   * completely different, not-a-real-model directory a flat per-player
   * prefix add would never reach.
   */
  const players = new Set(listPlayerModels(fs).map((n) => n.split('/')[0]));
  for (const name of players) {
    add(fs.list({ prefix: `models/players/${name}/` }));
    add(fs.list({ prefix: `sound/player/${name}/` }));
    for (const path of fs.list({ prefix: `models/players/${name}/`, ext: '.skin' })) {
      const text = await fs.readText(path);
      if (!text) {
        continue;
      }
      for (const ref of parseSkin(text).surfaces.values()) {
        closeRef(ref);
      }
    }
  }
  add(fs.list({ prefix: 'sound/player/footsteps/' }));
  add(FIXED_SOUNDS.filter((p) => fs.has(p)));
  missing.push(...FIXED_SOUNDS.filter((p) => !fs.has(p)));

  /*
   * `rocketThrust` is defined TWICE across this pak's own shader scripts --
   * `scripts/weapon_rocketlauncher.shader` has real flare art, and
   * `scripts/weaponry.shader` has an empty `// do nothing` stub. This used to
   * be recorded here as "upstream OA content inconsistency, not a packing
   * gap" that resolved to the stub -- that reasoning was wrong.
   * `mergeShaderFiles` previously resolved duplicate shader names
   * last-file-wins; the real engine's `tr_shader.c` resolves them
   * first-file-wins (see that function's doc comment), and fixing the
   * mismatch flips this one, since `weapon_rocketlauncher.shader` sorts
   * before `weaponry.shader`.
   *
   * It flips to a shader that still doesn't render here, though: its three
   * stages map `textures/flares/{flarey,wide,newflare}.tga`, and none of the
   * three exists anywhere in `oa-pak0.pk3` -- OA's own kit never shipped
   * this art either. `applyModelShader` finds every stage unsampleable and
   * returns false exactly as it did for the mapless stub, so the surface
   * still falls through to the same flat "missing model texture" grey. No
   * visible change for this bundled pak; the fix only matters for a mount
   * set that actually supplies those three textures under those names.
   */
  if (fs.has('models/ammo/rocket/rocket.md3')) {
    add(fs.list({ prefix: 'models/ammo/rocket/' }));
    await closeMd3('models/ammo/rocket/rocket.md3');
  } else {
    missing.push('models/ammo/rocket/rocket.md3');
  }

  /*
   * Every item model and pickup sound this pak actually carries.
   *
   * Missing entries are recorded, not silently dropped: this is a libsdl
   * build of OpenArena, not the official pak0.pk3, and Overbounce's own
   * ITEMS table carries several weapons (nailgun, chaingun, prox launcher,
   * grapple) this pak never had model art for in the first place.
   */
  for (const item of ITEMS) {
    for (const model of item.models) {
      if (!fs.has(model)) {
        missing.push(model);
        continue;
      }
      wanted.add(model);
      await closeMd3(model);
    }
    if (item.pickupSound) {
      if (fs.has(item.pickupSound)) {
        wanted.add(item.pickupSound);
      } else {
        missing.push(item.pickupSound);
      }
    }
  }
  add(fs.list({ prefix: 'sound/items/' }));

  const entries: { path: string; data: Uint8Array }[] = [];
  for (const path of [...wanted].sort()) {
    const data = await fs.readFile(path);
    if (data) {
      entries.push({ path, data });
    }
  }

  const zip = writeZip(entries);
  writeFileSync(join(root, OUT), zip);

  console.log(
    `${OUT}\n  ${entries.length} files, ${(zip.length / 1024 / 1024).toFixed(1)}MB\n` +
      `  players: ${[...players].join(', ')}`,
  );
  if (missing.length) {
    console.log(
      `\n  Not in ${SOURCE} (this project's ITEMS table names more than any one OA ` +
        `build ships art for -- these pickups will render as nothing rather than ` +
        `breaking anything):\n` +
        missing.map((m) => `    ${m}`).join('\n'),
    );
  }
}

/** Every shader/texture name the surfaces of an MD3 reference. */
async function md3TextureRefs(fs: Pk3FileSystem, path: string): Promise<string[]> {
  const bytes = await fs.readFile(path);
  if (!bytes) {
    return [];
  }
  try {
    const model = parseMd3(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    const refs: string[] = [];
    for (const surface of model.surfaces) {
      for (const shader of surface.shaders) {
        if (shader) {
          refs.push(shader);
        }
      }
    }
    return refs;
  } catch {
    return [];
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
