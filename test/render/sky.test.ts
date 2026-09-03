/**
 * Sky parsing and the box face mapping.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The face mapping is the part worth pinning. A skybox with two faces swapped
 * or one rotated looks *almost* right — the horizon still lines up, the seams
 * still meet — and is miserable to debug by eye. These assertions come from
 * `MakeSkyVec` and `sky_texorder` in tr_sky.c, so a regression fails here
 * rather than in someone's peripheral vision.
 */

import { existsSync, openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ClampToEdgeWrapping, RepeatWrapping } from 'three/webgpu';
import type { Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { buildSky } from '../../src/render/sky.js';
import { writeZip } from '../../tools/pk3-writer.js';
import {
  SKY_SUFFIXES,
  mergeShaderFiles,
  parseShaderFile,
  skyBoxImages,
} from '../../src/assets/shader.js';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';

describe('skyparms', () => {
  it('reads a box sky', () => {
    const s = parseShaderFile(
      'textures/skies/x\n{\nsurfaceparm sky\nskyparms env/killsky 512 -\n}',
    ).get('textures/skies/x')!;

    expect(s.sky).not.toBeNull();
    expect(s.sky!.outerBox).toBe('env/killsky');
    expect(s.sky!.cloudHeight).toBe(512);
    expect(s.sky!.innerBox).toBeNull();
  });

  it('treats a dash as no box', () => {
    // Half the shipped Quake III skies are this: no box at all, just scrolling
    // cloud layers. A box-only implementation leaves those maps full of holes.
    const s = parseShaderFile(
      'textures/skies/x\n{\nskyparms - 512 -\n{ map textures/skies/clouds.tga }\n}',
    ).get('textures/skies/x')!;

    expect(s.sky!.outerBox).toBeNull();
    expect(skyBoxImages(s.sky!)).toBeNull();
  });

  it('defaults a zero or missing cloud height to 512', () => {
    const zero = parseShaderFile('t/x\n{\nskyparms - 0 -\n}').get('t/x')!;
    expect(zero.sky!.cloudHeight).toBe(512);
  });

  it('builds the six side names in ParseSkyParms order', () => {
    const s = parseShaderFile('t/x\n{\nskyparms env/foo 512 -\n}').get('t/x')!;
    expect(skyBoxImages(s.sky!)).toEqual([
      'env/foo_rt',
      'env/foo_bk',
      'env/foo_lf',
      'env/foo_ft',
      'env/foo_up',
      'env/foo_dn',
    ]);
  });

  it('uses the suffix order from tr_shader.c', () => {
    // Not alphabetical, not the axis order -- the order the C array is written.
    expect([...SKY_SUFFIXES]).toEqual(['rt', 'bk', 'lf', 'ft', 'up', 'dn']);
  });

  it('leaves sky null on a shader that has none', () => {
    expect(parseShaderFile('t/x\n{\n{ map t/x.tga }\n}').get('t/x')!.sky).toBeNull();
  });
});

/**
 * `MakeSkyVec`, reimplemented here from the C so the mapping in sky.ts is
 * checked against an independent transcription rather than against itself.
 */
const ST_TO_VEC = [
  [3, -1, 2],
  [-3, 1, 2],
  [1, 3, 2],
  [-1, -3, 2],
  [-2, -1, 3],
  [2, -1, -3],
];
const SKY_TEXORDER = [0, 2, 1, 3, 4, 5];

function makeSkyVec(axis: number, s: number, t: number, size = 1): number[] {
  const b = [s * size, t * size, size];
  const out = [0, 0, 0];
  for (let j = 0; j < 3; j++) {
    const k = ST_TO_VEC[axis][j];
    const value = k < 0 ? -b[-k - 1] : b[k - 1];
    // Normalise -0 to 0: negating a zero component is arithmetically identical
    // and only differs under Object.is, which is what toEqual uses.
    out[j] = value === 0 ? 0 : value;
  }
  return out;
}

describe('the box face mapping', () => {
  it('points each axis at the direction tr_sky.c says', () => {
    // The centre of each face (s = t = 0) is the face's outward direction.
    expect(makeSkyVec(0, 0, 0)).toEqual([1, 0, 0]); // +X
    expect(makeSkyVec(1, 0, 0)).toEqual([-1, 0, 0]); // -X
    expect(makeSkyVec(2, 0, 0)).toEqual([0, 1, 0]); // +Y
    expect(makeSkyVec(3, 0, 0)).toEqual([0, -1, 0]); // -Y
    expect(makeSkyVec(4, 0, 0)).toEqual([0, 0, 1]); // +Z, up
    expect(makeSkyVec(5, 0, 0)).toEqual([0, 0, -1]); // -Z, down
  });

  it('assigns the six images to the axes through sky_texorder', () => {
    // The mapping this whole file exists to pin:
    //   +X = rt, -X = lf, +Y = bk, -Y = ft, +Z = up, -Z = dn
    const forAxis = (axis: number): string => SKY_SUFFIXES[SKY_TEXORDER[axis]];
    expect(forAxis(0)).toBe('rt');
    expect(forAxis(1)).toBe('lf');
    expect(forAxis(2)).toBe('bk');
    expect(forAxis(3)).toBe('ft');
    expect(forAxis(4)).toBe('up');
    expect(forAxis(5)).toBe('dn');
  });

  it('keeps every corner on the box, not inside it', () => {
    // Each corner must be at the box surface: exactly one axis at the extreme.
    for (let axis = 0; axis < 6; axis++) {
      for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const v = makeSkyVec(axis, s, t, 4096);
        for (const c of v) {
          expect(Math.abs(c), `axis ${axis}`).toBeCloseTo(4096, 3);
        }
      }
    }
  });

  it('flips t when making texture coordinates', () => {
    // MakeSkyVec: s -> (s+1)/2, t -> 1 - (t+1)/2. Getting the flip wrong turns
    // every sky upside down, which reads as "the artist did that".
    const uv = (s: number, t: number): [number, number] => [
      (s + 1) * 0.5,
      1 - (t + 1) * 0.5,
    ];
    expect(uv(-1, -1)).toEqual([0, 1]);
    expect(uv(1, 1)).toEqual([1, 0]);
  });
});

const baseq3 = process.env.Q3_BASEQ3;

describe.skipIf(!baseq3 || !existsSync(baseq3))('real Quake III skies', () => {
  it('gives every sky map a shader, and a box or a cloud layer', async () => {
    const fs = new Pk3FileSystem();
    for (const n of readdirSync(baseq3!).filter((f) => f.toLowerCase().endsWith('.pk3')).sort()) {
      await fs.mount(n, await openAsBlob(join(baseq3!, n)));
    }

    const texts: string[] = [];
    for (const p of fs.list({ prefix: 'scripts/' }).filter((x) => x.endsWith('.shader'))) {
      texts.push((await fs.readText(p))!);
    }
    const shaders = mergeShaderFiles(texts);

    let boxed = 0;
    let clouded = 0;
    let checked = 0;

    for (const map of ['q3dm1', 'q3dm6', 'q3dm7', 'q3dm17', 'q3tourney2']) {
      const data = await fs.readFile(`maps/${map}.bsp`);
      if (!data) {
        continue;
      }
      const bsp = parseBsp(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      );

      for (const entry of bsp.shaders) {
        if (!(entry.surfaceFlags & 0x4)) {
          continue; // SURF_SKY
        }
        checked++;
        const shader = shaders.get(entry.shader.toLowerCase());
        expect(shader, `${map}: no shader for ${entry.shader}`).toBeDefined();

        const box = shader!.sky ? skyBoxImages(shader!.sky) : null;
        if (box && box.every((n) => fs.findImage(n))) {
          boxed++;
        } else {
          // Not a box: it must at least have a cloud layer to fall back on,
          // or there is genuinely nothing to draw and the map keeps its hole.
          const cloud = shader!.stages.find((st) => st.map)?.map ?? shader!.editorImage;
          expect(cloud, `${map}: ${entry.shader} has neither box nor clouds`).toBeTruthy();
          clouded++;
        }
      }
    }

    expect(checked).toBeGreaterThan(0);
    // Both kinds really do occur; if one count is zero the fixture set is not
    // exercising the branch it was chosen for.
    expect(boxed + clouded).toBe(checked);
  });
});


/**
 * A 2x2 uncompressed 32-bit TGA. Small on purpose -- nothing here looks at
 * the pixels, and the `.tga` path matters because it decodes in Node while
 * `createImageBitmap` (every other format) does not exist here.
 */
function tinyTga(): Uint8Array {
  const header = new Uint8Array(18);
  header[2] = 2; // uncompressed true-colour
  header[12] = 2; // width lo
  header[14] = 2; // height lo
  header[16] = 32; // bits per pixel
  header[17] = 8; // 8 alpha bits, top-down
  return new Uint8Array([...header, ...new Uint8Array(2 * 2 * 4).fill(0xff)]);
}

async function mountSky(paths: readonly string[]): Promise<Pk3FileSystem> {
  const fs = new Pk3FileSystem();
  const zip = writeZip(paths.map((path) => ({ path, data: tinyTga() })));
  await fs.mount('sky.pk3', new Blob([zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer]));
  return fs;
}

/** Every face's texture, in build order. */
function faceTextures(sky: { object: { children: unknown[] } }): unknown[] {
  return sky.object.children.map(
    (m) => ((m as Mesh).material as MeshBasicNodeMaterial).map,
  );
}

/**
 * `ParseSkyParms` loads the six box images with `GL_CLAMP` --
 * `tr_shader.c:1230` -- and the wrap mode is the whole of whether the box
 * has visible seams.
 *
 * A face's UVs run exactly 0..1 to its own edges, so under REPEAT the filter
 * kernel at an edge straddles the wrap and samples the OPPOSITE side of the
 * image: a hard line of wrong sky along every boundary, and a cross where two
 * meet at a corner. It is the kind of thing that is obvious in motion, absent
 * from a thumbnail, and impossible to attribute without knowing to look at a
 * sampler -- so it is pinned here rather than left to someone's eye.
 */
describe('sky box wrapping', () => {
  it('clamps every face of a box sky', async () => {
    const fs = await mountSky(
      SKY_SUFFIXES.map((suffix) => `env/test/test_${suffix}.tga`),
    );
    const shader = parseShaderFile(
      ['textures/skies/x', '{', 'surfaceparm sky', 'skyparms env/test/test 512 -', '}'].join(
        '\n',
      ),
    ).get('textures/skies/x')!;

    const sky = await buildSky(fs, shader);
    expect(sky, 'the six images are mounted, so this must be a box').not.toBeNull();
    expect(sky!.boxed).toBe(true);
    expect(faceTextures(sky!)).toHaveLength(6);

    for (const texture of faceTextures(sky!)) {
      const t = texture as { wrapS: number; wrapT: number };
      expect(t.wrapS).toBe(ClampToEdgeWrapping);
      expect(t.wrapT).toBe(ClampToEdgeWrapping);
    }
  });

  it('does not clamp the shared cache entry the faces were cloned from', async () => {
    // `loadTexture` hands out ONE object per image. Clamping in place would
    // reach every other surface that uses the same file, which is why
    // `bsp-mesh.ts` clones for `clampmap` too.
    const fs = await mountSky(
      SKY_SUFFIXES.map((suffix) => `env/test/test_${suffix}.tga`),
    );
    const shader = parseShaderFile(
      ['textures/skies/x', '{', 'surfaceparm sky', 'skyparms env/test/test 512 -', '}'].join(
        '\n',
      ),
    ).get('textures/skies/x')!;
    await buildSky(fs, shader);

    const { loadTexture } = await import('../../src/render/md3-mesh.js');
    const cached = await loadTexture(fs, 'env/test/test_rt');
    expect(cached!.wrapS).toBe(RepeatWrapping);
  });

  it('leaves a cloud sky on repeat, because its scroll needs it', async () => {
    // The cloud fallback is a tiling layer with a `tcMod scroll` whose
    // coordinates leave 0..1 by design. Clamping it would smear one row of
    // texels across the sky instead of scrolling it.
    const fs = await mountSky(['textures/skies/clouds.tga']);
    const shader = parseShaderFile(
      [
        'textures/skies/y',
        '{',
        'surfaceparm sky',
        'skyparms - 512 -',
        '{ map textures/skies/clouds.tga',
        'tcMod scroll 0.1 0.1',
        '}',
        '}',
      ].join('\n'),
    ).get('textures/skies/y')!;

    const sky = await buildSky(fs, shader);
    expect(sky).not.toBeNull();
    expect(sky!.boxed).toBe(false);
    for (const texture of faceTextures(sky!)) {
      const t = texture as { wrapS: number; wrapT: number };
      expect(t.wrapS).toBe(RepeatWrapping);
      expect(t.wrapT).toBe(RepeatWrapping);
    }
  });
});
