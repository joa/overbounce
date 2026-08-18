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
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pk3FileSystem } from '../src/assets/pk3.js';
import { mergeShaderFiles, skyBoxImages } from '../src/assets/shader.js';
import { ITEMS } from '../src/game/items.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Minimal store-only ZIP writer. Q3 paks are plain zips and read fine. */
function writeZip(entries: { path: string; data: Uint8Array }[]): Buffer {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const { path, data } of entries) {
    const nb = enc.encode(path);

    const local = new Uint8Array(30 + nb.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // stored, not deflated
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
  const player = arg('player', 'phobos');
  const out = arg('out', `public/dev-${map}.pk3`);

  const fs = new Pk3FileSystem();
  for (const name of readdirSync(baseq3).filter((f) => f.toLowerCase().endsWith('.pk3')).sort()) {
    await fs.mount(name, await openAsBlob(join(baseq3, name)));
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
  add(fs.list({ prefix: 'models/ammo/rocket/' }));
  add(fs.list({ prefix: 'models/weapons2/rocketl/' }));
  add(['sound/player/land1.wav', 'sound/world/jumppad.wav', 'sound/world/telein.wav'].filter((p) => fs.has(p)));
  add(fs.list({ prefix: 'scripts/' }).filter((p) => p.endsWith('.shader')));

  // Every item model and pickup sound, so a map's pickups are actually there.
  // The item table is small and shared by every map; packing all of it costs
  // little and removes a whole class of "why is this one invisible".
  for (const item of ITEMS) {
    for (const model of item.models) {
      if (fs.has(model)) {
        wanted.add(model);
      }
      // Item models carry their own skins, which findImage resolves.
      const image = fs.findImage(model.replace(/\.md3$/i, ''));
      if (image) {
        wanted.add(image);
      }
    }
    if (item.pickupSound && fs.has(item.pickupSound)) {
      wanted.add(item.pickupSound);
    }
  }
  add(fs.list({ prefix: 'sound/items/' }));

  // Every texture the map needs, INCLUDING the ones only a .shader names.
  // Packing the directly-named images alone is not enough: light strips and
  // liquids reference their real texture from inside a shader script, so a dev
  // pak built that way renders them untextured and looks like a renderer bug.
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
      `  http://localhost:5173/?devpak=${out.replace(/^public\//, '')}&map=${map}&player=${player}`,
  );
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
