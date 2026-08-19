/**
 * Build a small .pk3 from a local Quake III installation, for development.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   Q3_BASEQ3="D:/.../Quake 3 Arena/baseq3" npm run build-devpak
 *   Q3_BASEQ3=... npm run build-devpak -- --map q3dm6 --player phobos
 *
 * `?devpak=` downloads the whole archive over HTTP, so pointing it at a 460MB
 * pak0.pk3 is not viable. This carves out just what a dev session needs — one
 * map, one player model, the sounds — into something small enough to serve.
 *
 * THE OUTPUT IS NOT REDISTRIBUTABLE. It contains retail Quake III assets, and
 * `public/*.pk3` is gitignored for that reason. This tool exists so that a
 * session can rebuild the dev pak from the user's own installation rather than
 * depending on a file someone happened to leave lying around. See NOTICE.
 */

import { openAsBlob, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PakGroup, Pk3FileSystem } from '../src/assets/pk3.js';
import { mergeShaderFiles, skyBoxImages } from '../src/assets/shader.js';
import { ITEMS } from '../src/game/items.js';
import { parseMd3 } from '../src/assets/md3.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Every `--<name> <value>`, so a flag can be repeated. */
function args(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) {
      values.push(process.argv[i + 1]);
    }
  }
  return values;
}

/**
 * CRC-32, the one field a zip cannot omit.
 *
 * fflate -- which is what the browser side reads paks with -- does not verify
 * it, so a pak written with a zero CRC loads in the game and looks fine while
 * being rejected by every standard tool: Python's zipfile, 7-zip, and Quake
 * itself. That makes the dev pak impossible to inspect, which is exactly when
 * you most want to inspect it.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal store-only ZIP writer. Q3 paks are plain zips and read fine. */
function writeZip(entries: { path: string; data: Uint8Array }[]): Buffer {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const { path, data } of entries) {
    const nb = enc.encode(path);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nb.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // stored, not deflated
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nb.length, true);
    local.set(nb, 30);
    local.set(data, 30 + nb.length);
    locals.push(local);

    const central = new Uint8Array(46 + nb.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nb.length, true);
    cv.setUint32(42, offset, true);
    central.set(nb, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return Buffer.concat([...locals, ...centrals, eocd].map((u) => Buffer.from(u)));
}

async function main(): Promise<void> {
  const baseq3 = process.env.Q3_BASEQ3;
  if (!baseq3 || !existsSync(baseq3)) {
    console.error(
      'Set Q3_BASEQ3 to a baseq3 directory containing .pk3 files, e.g.\n' +
        '  Q3_BASEQ3="D:/SteamLibrary/steamapps/common/Quake 3 Arena/baseq3" npm run build-devpak\n\n' +
        'Retail Quake III content is not downloadable and is not committed; this\n' +
        'tool reads your own installation. See NOTICE.',
    );
    process.exit(1);
  }

  const map = arg('map', 'q3dm6');
  /*
   * `model` or `model/skin`, and the split is not optional.
   *
   * The default used to be the bare string `phobos`, which produced a pak with
   * NO PLAYER MODEL IN IT: phobos is a SKIN of doom, so
   * `models/players/phobos/` does not exist and the two `fs.list` calls below
   * silently matched nothing. The paks in the repo predated that default and
   * hid it; regenerating them all is what surfaced it, as a player-shaped hole
   * in the middle of every screenshot.
   *
   * Sound is per MODEL too -- `sound/player/doom/`, not per skin.
   */
  const requested = arg('player', 'doom/phobos');
  const player = requested.split('/')[0];

  const out = arg('out', `public/dev-${map}.pk3`);

  const fs = new Pk3FileSystem();
  for (const name of readdirSync(baseq3).filter((f) => f.toLowerCase().endsWith('.pk3')).sort()) {
    await fs.mount(name, await openAsBlob(join(baseq3, name)));
  }

  // `--pk3 <path>` mounts a downloaded map pack ON TOP of baseq3, so its map
  // can be built into a dev pak that also carries the common textures it
  // references. A defrag map ships its own trim and almost nothing else --
  // loaded alone it renders as a missing-texture checkerboard.
  //
  //   npm run build-devpak -- --pk3 assets/pk3/de4th_run1.pk3 --map de4th_run1
  for (const path of args('pk3')) {
    if (!existsSync(path)) {
      console.error(`--pk3 ${path}: not found`);
      process.exit(1);
    }
    await fs.mount(basename(path), await openAsBlob(path), PakGroup.Addon);
  }

  // Textures are pulled by walking the map's shader names, so a dev pak is
  // renderable rather than just walkable.
  const wanted = new Set<string>();
  const add = (paths: string[]): void => paths.forEach((p) => wanted.add(p));

  add([`maps/${map}.bsp`].filter((p) => fs.has(p)));
  add(fs.list({ prefix: `models/players/${player}/` }));
  add(fs.list({ prefix: `sound/player/${player}/` }));
  add(fs.list({ prefix: 'sound/player/footsteps/' }));
  add(fs.list({ prefix: 'sound/weapons/rocket/' }));
  add(fs.list({ prefix: 'sound/weapons/grenade/' }));
  add(fs.list({ prefix: 'sound/weapons/plasma/' }));
  // Doors and buttons. `SP_func_door` names dr1_strt/dr1_end and
  // `SP_func_button` names butn2 (g_mover.c:952, 1204); without these the
  // movers open in total silence and nothing says why.
  add(fs.list({ prefix: 'sound/movers/' }));
  // The blob shadow's art. `markShadow` has no shader script, so it resolves
  // to this image through R_FindShader's default-shader path.
  add(fs.list({ prefix: 'gfx/damage/' }));
  add(fs.list({ prefix: 'models/ammo/rocket/' }));
  add(fs.list({ prefix: 'models/weapons2/rocketl/' }));
  add(['sound/player/land1.wav', 'sound/world/jumppad.wav', 'sound/world/telein.wav'].filter((p) => fs.has(p)));
  add(fs.list({ prefix: 'scripts/' }).filter((p) => p.endsWith('.shader')));

  // Parsed once and used by both the item models below and the map's own
  // shaders further down.
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

  // Every item model and pickup sound, so a map's pickups are actually there.
  // The item table is small and shared by every map; packing all of it costs
  // little and removes a whole class of "why is this one invisible".
  for (const item of ITEMS) {
    for (const model of item.models) {
      if (!fs.has(model)) {
        continue;
      }
      wanted.add(model);
      // The textures a model needs are the ones its SURFACES name, baked into
      // the MD3 -- models/powerups/armor/newred.tga, not the model's own path.
      // Guessing from the path finds 9 of 99 and leaves the rest grey.
      for (const ref of await md3TextureRefs(fs, model)) {
        const direct = fs.findImage(ref);
        if (direct) {
          wanted.add(direct);
        }
        // ...and the surface may name a shader instead, as the Quad does.
        //
        // Shader names carry no extension, but an MD3 surface may name its
        // texture as `foo.tga`. Looking that up verbatim silently misses the
        // shader and packs only the direct image, which is how the yellow
        // armour lost the second half of its animation.
        const shader = shaders.get(ref.toLowerCase().replace(/\.(tga|jpg|jpeg|png)$/, ''));
        for (const stage of shader?.stages ?? []) {
          for (const name of [stage.map, ...stage.animFrames]) {
            const image = name ? fs.findImage(name) : null;
            if (image) {
              wanted.add(image);
            }
          }
        }
      }
    }
    if (item.pickupSound && fs.has(item.pickupSound)) {
      wanted.add(item.pickupSound);
    }
  }
  add(fs.list({ prefix: 'sound/items/' }));
  // The spheremaps every envmap shader samples.
  add(fs.list({ prefix: 'textures/effects/' }));

  // Every texture the map needs, INCLUDING the ones only a .shader names.
  // Packing the directly-named images alone is not enough: light strips and
  // liquids reference their real texture from inside a shader script, so a dev
  // pak built that way renders them untextured and looks like a renderer bug.
  const bsp = await fs.readFile(`maps/${map}.bsp`);
  if (bsp) {
    for (const name of shaderNames(bsp)) {
      const direct = fs.findImage(name);
      if (direct) {
        wanted.add(direct);
      }

      const shader = shaders.get(name.toLowerCase());
      if (!shader) {
        continue;
      }
      // EVERY image the shader names, not just the diffuse: the glow and
      // pulse layers that carry a map's animation live on later stages, and a
      // dev pak missing those renders a still bounce pad that looks like a
      // broken animation rather than a missing file. Plus animMap frames and
      // the six sky sides.
      const referenced: string[] = shader.sky ? (skyBoxImages(shader.sky) ?? []) : [];
      for (const stage of shader.stages) {
        if (stage.map) {
          referenced.push(stage.map);
        }
        referenced.push(...stage.animFrames);
      }
      if (shader.editorImage) {
        referenced.push(shader.editorImage);
      }

      for (const ref of referenced) {
        const image = fs.findImage(ref);
        if (image) {
          wanted.add(image);
        }
      }
    }
  }

  const entries: { path: string; data: Uint8Array }[] = [];
  for (const path of [...wanted].sort()) {
    const data = await fs.readFile(path);
    if (data) {
      entries.push({ path, data });
    }
  }

  const zip = writeZip(entries);
  writeFileSync(join(root, out), zip);

  console.log(
    `${out}\n  ${entries.length} files, ${(zip.length / 1024 / 1024).toFixed(1)}MB\n` +
      `  map=${map} player=${player}\n\n` +
      `  http://localhost:5173/?devpak=${out.replace(/^public\//, '')}&map=${map}&player=${requested}`,
  );
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

/** Read LUMP_SHADERS (lump 1) directly: 64-byte name, then two ints. */
function shaderNames(bsp: Uint8Array): string[] {
  const view = new DataView(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  const ofs = view.getInt32(8 + 1 * 8, true);
  const len = view.getInt32(8 + 1 * 8 + 4, true);
  const names: string[] = [];

  for (let i = 0; i < len / 72; i++) {
    let name = '';
    for (let c = 0; c < 64; c++) {
      const ch = view.getUint8(ofs + i * 72 + c);
      if (!ch) {
        break;
      }
      name += String.fromCharCode(ch);
    }
    if (name) {
      names.push(name);
    }
  }
  return names;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
