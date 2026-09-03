/**
 * A synthetic BOX sky, so the box path can actually be looked at.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npx tsx tools/diag/sky-testpak.ts textures/skies/xtoxicskytim_q3dm5
 *   npm run dev  # then ?devpak=dev-q3dm6.pk3,dev-skytest.pk3&map=q3dm6
 *
 * NOT ONE COMMITTED MAP HAS A BOX SKY. Every map in `public/` resolves to
 * `skyparms - <height> -`, the cloud path, so `buildSky`'s box branch -- the
 * one with the six images, the face mapping and the clamp -- cannot be seen in
 * this repository at all without making a pak for it. Retail q3dm1 has one,
 * and retail content is never committed (see NOTICE), so this generates one.
 *
 * ## Why the faces are generated from a 3D function
 *
 * Six IDENTICAL images are not a seamless box, which is worth stating because
 * it is the obvious first idea and it is wrong: the top row of `_rt` has to
 * equal the bottom row of `_up`, and in one image those are different rows.
 * A first version of this tool used one gradient on all six faces and
 * produced a hard line exactly where a real seam would be -- an artefact of
 * the fixture, indistinguishable by eye from the bug it was built to find.
 *
 * So each texel is coloured by a function of the DIRECTION it represents,
 * reconstructed through the same `MakeSkyVec` mapping `sky.ts` uses. Two
 * faces meeting at an edge look up the same 3D directions there, so they
 * agree by construction however the box is oriented -- which is also how a
 * real skybox is authored. Any line left on screen is the renderer's.
 *
 * The function is a smooth ramp in `z` plus a high-frequency 3D ripple. The
 * ramp makes a mip-level mismatch show as a step in brightness; the ripple is
 * what a coarse mip averages away, so a face sampled from a lower level reads
 * visibly flatter than the one beside it. That combination is deliberate:
 * a flat colour would hide the most likely artefact entirely, since every mip
 * of a flat image is the same flat colour.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeZip } from '../pk3-writer.js';

const shaderName = process.argv[2] ?? 'textures/skies/xtoxicskytim_q3dm5';
const out = resolve(process.argv[3] ?? 'public/dev-skytest.pk3');
/**
 * `--cloud` emits `skyparms - 512 -` with one tiling layer instead of a box,
 * which is the OTHER half of `buildSky` and the half every committed map
 * actually takes. Same generated content either way, so the two are directly
 * comparable: a seam that shows here and not in the box is the flattening
 * rather than the sampler.
 */
const cloud = process.argv.includes('--cloud');
const SIZE = 256;

/** Uncompressed 32-bit top-down TGA. */
function tga(pixels: Uint8Array, size: number): Uint8Array {
  const header = new Uint8Array(18);
  header[2] = 2;
  header[12] = size & 0xff;
  header[13] = size >> 8;
  header[14] = size & 0xff;
  header[15] = size >> 8;
  header[16] = 32;
  // 0x20 is the top-left origin bit and 8 is the alpha depth. WITHOUT the
  // 0x20 a TGA is bottom-up and `tga.ts` flips it on load, which turns
  // every face upside down -- self-consistently for the four sides, so the
  // vertical seams still match, and NOT against the up and down faces. That
  // is a horizontal seam produced entirely by the fixture, and it looks
  // exactly like the renderer bug this tool exists to find.
  header[17] = 0x28;
  const out = new Uint8Array(header.length + pixels.length);
  out.set(header);
  out.set(pixels, header.length);
  return out;
}

/**
 * `st_to_vec`, as in `sky.ts` and `tr_sky.c`. Repeated rather than imported:
 * a fixture that shares the mapping with the code under test cannot detect a
 * mistake in it, and this one is generated so an error would show as a seam.
 */
const ST_TO_VEC = [
  [3, -1, 2],
  [-3, 1, 2],
  [1, 3, 2],
  [-1, -3, 2],
  [-2, -1, 3],
  [2, -1, -3],
];

/** The unit direction a texel of one face looks along. */
function direction(axis: number, s: number, t: number): [number, number, number] {
  const b = [s, t, 1];
  const out = [0, 0, 0];
  for (let j = 0; j < 3; j++) {
    const k = ST_TO_VEC[axis][j];
    out[j] = k < 0 ? -b[-k - 1] : b[k - 1];
  }
  const len = Math.hypot(out[0], out[1], out[2]);
  return [out[0] / len, out[1] / len, out[2] / len];
}

/** Smooth ramp plus a high-frequency ripple, both continuous in 3D. */
function sample(d: readonly [number, number, number]): number {
  const ramp = 128 + d[2] * 70;
  const ripple = 34 * Math.sin(38 * d[0]) * Math.sin(38 * d[1]) * Math.sin(38 * d[2]);
  return Math.max(0, Math.min(255, Math.round(ramp + ripple)));
}

function face(axis: number): Uint8Array {
  const px = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // The inverse of `sky.ts`'s `u = (s+1)/2, v = 1 - (t+1)/2`, at texel
      // centres.
      const u = (x + 0.5) / SIZE;
      const v = (y + 0.5) / SIZE;
      const value = sample(direction(axis, 2 * u - 1, 1 - 2 * v));
      const i = (y * SIZE + x) * 4;
      px[i] = value;
      px[i + 1] = value;
      px[i + 2] = value;
      px[i + 3] = 255;
    }
  }
  return tga(px, SIZE);
}

/** `sky_texorder`: which image belongs to which axis. */
const SKY_TEXORDER = [0, 2, 1, 3, 4, 5];
const suffixes = ['rt', 'bk', 'lf', 'ft', 'up', 'dn'];
/** Image `i` is the one axis `SKY_TEXORDER.indexOf(i)` draws. */
const images = suffixes.map((_, image) => face(SKY_TEXORDER.indexOf(image)));
const cloudShader =
  `${shaderName}\n` +
  `{\n\tqer_editorimage env/skytest/skytest_rt.tga\n` +
  `\tsurfaceparm noimpact\n\tsurfaceparm nolightmap\n\tsurfaceparm sky\n` +
  `\tq3map_globaltexture\n\tskyparms - 512 -\n` +
  `\t{\n\t\tmap env/skytest/skytest_rt.tga\n\t\ttcMod scroll 0.01 0.01\n\t}\n}\n`;

const boxShader =
  `${shaderName}\n` +
  `{\n\tqer_editorimage env/skytest/skytest_rt.tga\n` +
  `\tsurfaceparm noimpact\n\tsurfaceparm nolightmap\n\tsurfaceparm sky\n` +
  `\tq3map_globaltexture\n\tq3map_sun 1 1 1 100 0 75\n` +
  `\tskyparms env/skytest/skytest 512 -\n}\n`;

const zip = writeZip([
  {
    path: 'scripts/skytest.shader',
    data: new TextEncoder().encode(cloud ? cloudShader : boxShader),
  },
  ...suffixes.map((s, i) => ({ path: `env/skytest/skytest_${s}.tga`, data: images[i] })),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zip);
console.log(`wrote ${out}: ${cloud ? 'cloud' : 'box'} sky overriding ${shaderName}`);
console.log('  ?devpak=dev-q3dm6.pk3,dev-skytest.pk3&map=q3dm6&camera=fpv');
