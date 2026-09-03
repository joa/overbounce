/**
 * Fog volumes: `R_LoadFogs`, `RB_CalcFogTexCoords`, `R_FogFactor`.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Every expected number here is hand-derived from the C in
 * `refs/quake3/renderer/`, not read off the implementation. The two that matter
 * most, and the reason this file exists:
 *
 *  - **A lightmap-first floor is OPAQUE.** `FinishShader` only assigns a
 *    translucent sort when the stage in hand AND stage 0 both carry blend bits,
 *    so `clangdark`'s `blendFunc GL_DST_COLOR GL_ZERO` texture stage does not
 *    make the floor translucent. Read that condition as "any blended stage" and
 *    every ordinary floor and wall inside a fog volume silently loses its fog --
 *    which is most of what a fog volume contains.
 *  - **`fogNum + 1` can point past the end of the table.** q3dm6 and q3dm17 have
 *    an empty `LUMP_FOGS` and still carry surfaces claiming `fogNum 0`. Fog has
 *    to be a provable no-op there, not an observed one.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import type { BspFile } from '../../src/collision/bsp.js';
import { mergeShaderFiles, parseShaderFile, shaderKey } from '../../src/assets/shader.js';
import type { Shader } from '../../src/assets/shader.js';
import {
  DEFAULT_FOG_OPTIONS,
  FOG_FEATHER,
  FOG_TABLE_SIZE,
  fogFactor,
  fogFeather,
  fogFeatherDistance,
  fogIndexOf,
  fogPassOf,
  fogPlaneDepth,
  fogRayDepth,
  fogTexCoords,
  fogThickness,
  initFogTable,
  isFogOnlyShader,
  loadFogs,
  parseFogOptions,
} from '../../src/render/fog.js';
import type { Fog } from '../../src/render/fog.js';

/**
 * de4th_run1's ground fog, as `R_LoadFogs` builds it.
 *
 * Taken from the map itself: brush 1230, `visibleSide 5` (the +Z top), plane
 * `(0,0,1) dist 208`, shader `textures/sfx/mkc_fog_ctfred` with
 * `fogparms ( 0.3 0.2 0.2 ) 320`. The volume is the whole map floor,
 * `[-1592,-760,8] .. [1592,760,208]`.
 */
const GROUND_FOG: Fog = {
  originalBrushNumber: 1230,
  bounds: [
    [-1592, -760, 8],
    [1592, 760, 208],
  ],
  color: [0.3, 0.2, 0.2],
  depthForOpaque: 320,
  // 1 / (320 * 8)
  tcScale: 1 / 2560,
  hasSurface: true,
  // VectorSubtract( vec3_origin, normal ) and -dist.
  surface: [0, 0, -1, -208],
};

describe('R_InitFogTable', () => {
  const table = initFogTable();

  it('is a discretised square root', () => {
    // exp = 0.5 in tr_image.c:1957. This is the whole shape of a fog ramp: get
    // the exponent wrong and fog either creeps in too late or slams on at the
    // first unit.
    expect(table.length).toBe(FOG_TABLE_SIZE);
    expect(table[0]).toBe(0);
    expect(table[FOG_TABLE_SIZE - 1]).toBe(1);
    expect(table[128]).toBeCloseTo(Math.sqrt(128 / 255), 6);
  });
});

describe('R_FogFactor', () => {
  // With the eye and the point both inside the volume, `t` is 31/32 and
  // `R_FogFactor` reduces to sqrt(min(1, distance / depthForOpaque)): the
  // `tcScale` 1/(d*8) and the `s *= 8` cancel, as do +1/512 and -1/512.
  const inside = (distance: number): number =>
    fogFactor(distance * GROUND_FOG.tcScale + 1 / 512, 31 / 32);

  it('is zero at zero distance', () => {
    expect(inside(0)).toBe(0);
  });

  it('reaches full opacity at exactly depthForOpaque', () => {
    expect(inside(320)).toBe(1);
  });

  it('saturates beyond depthForOpaque rather than overshooting', () => {
    // `if ( s > 1.0 ) s = 1.0;`
    expect(inside(5000)).toBe(1);
  });

  it('is a square root of the fraction travelled, not linear', () => {
    // 80/320 = 1/4, and sqrt(1/4) = 1/2. A linear ramp would give 0.25, so this
    // number alone separates the two.
    expect(inside(80)).toBeCloseTo(0.5, 2);
  });

  it('returns nothing for a point the T axis marked as outside', () => {
    // `if ( t < 1.0/32 ) return 0;` -- the clipped-fog branch sets exactly this
    // value for a vertex on the wrong side of the fog plane.
    expect(fogFactor(320 * GROUND_FOG.tcScale + 1 / 512, 1 / 32 - 1e-6)).toBe(0);
  });
});

describe('RB_CalcFogTexCoords', () => {
  it('gives a point inside the volume the full 31/32 when the eye is inside', () => {
    // Eye at z = 60 -> eyeT = 208 - 60 = 148 >= 0, so eyeOutside is false. The
    // vertex is below the plane, so `t < 0` is false and it takes 31/32.
    const [s, t] = fogTexCoords([300, 0, 8], [0, 0, 60], [1, 0, 0], GROUND_FOG);
    expect(t).toBeCloseTo(31 / 32, 9);
    expect(s).toBeCloseTo(300 * GROUND_FOG.tcScale + 1 / 512, 9);
  });

  it('clips the distance at the fog plane when the eye is outside', () => {
    // Eye 100 units ABOVE the plane (z = 308) looking straight down at the
    // floor (z = 8), 200 units below it.
    //
    //   eyeT = 208 - 308 = -100        -> eyeOutside
    //   t    = 208 -   8 =  200        -> >= 1, so the clipped branch
    //   t'   = 1/32 + 30/32 * 200/(200 - -100)
    //        = 1/32 + 30/32 * 2/3 = 21/32
    //
    // Two thirds of the eye->vertex ray is inside the volume, and 21/32 is how
    // that fraction is spelled once it is mapped onto the fog image's T axis.
    const eye: [number, number, number] = [0, 0, 308];
    const down: [number, number, number] = [0, 0, -1];
    const [s, t] = fogTexCoords([0, 0, 8], eye, down, GROUND_FOG);

    expect(t).toBeCloseTo(21 / 32, 9);
    expect(s).toBeCloseTo(300 * GROUND_FOG.tcScale + 1 / 512, 9);

    // And the factor is the 200 units actually spent in fog, not the 300 the
    // eye is away: `R_FogFactor` scales s by (t - 1/32)/(30/32) = 2/3.
    expect(fogFactor(s, t)).toBeCloseTo(Math.sqrt(200 / 320), 2);
  });

  it('gives no fog to a point outside the volume when the eye is outside', () => {
    // Vertex at z = 250, above the plane: t = 208 - 250 = -42, which is < 1.
    const [s, t] = fogTexCoords([0, 0, 250], [0, 0, 308], [0, 0, -1], GROUND_FOG);
    expect(t).toBe(1 / 32);
    expect(fogFactor(s, t)).toBe(0);
  });

  it('measures distance from the eye along the view axis, not from the origin', () => {
    // fogDistanceVector[3] is `dot(or.origin - viewOrigin, viewAxis[0])` and
    // `or.origin` is zero for the world, so the term is -dot(eye, forward). Drop
    // it and fog would be measured from the map origin -- which looks plausible
    // until you walk toward a wall and it does not clear.
    const a = fogTexCoords([500, 0, 8], [200, 0, 60], [1, 0, 0], GROUND_FOG);
    expect(a[0]).toBeCloseTo(300 * GROUND_FOG.tcScale + 1 / 512, 9);
  });

  it('treats a fog with no visible side as one the eye is always inside', () => {
    // `visibleSide == -1` -> hasSurface false -> `eyeT = 1`. id leaves
    // fogDepthVector uninitialised on this path; pinned here as zero, which puts
    // every vertex on the full-distance 31/32.
    const noSurface: Fog = { ...GROUND_FOG, hasSurface: false, surface: [0, 0, 0, 0] };
    const [, t] = fogTexCoords([0, 0, 9000], [0, 0, 308], [0, 0, -1], noSurface);
    expect(t).toBe(31 / 32);
  });
});

/** A `.shader` body parsed into one Shader, for the sort tests. */
function shaderOf(text: string): Shader {
  const parsed = parseShaderFile(text);
  const first = [...parsed.values()][0];
  expect(first).toBeDefined();
  return first;
}

describe('the fogPass gate (GeneratePermanentShader)', () => {
  it('fogs a surface with no shader script at all', () => {
    // The overwhelmingly common case: a plain lightmapped image, sort SS_OPAQUE.
    expect(fogPassOf(null, 0)).toBe('equal');
  });

  it('fogs a lightmap-first floor even though a later stage is blended', () => {
    // THE regression this file exists for. `FinishShader` requires stage 0 to
    // carry blend bits too, so this shader never leaves SS_OPAQUE.
    const floor = shaderOf(`
      textures/base_floor/clangdark
      {
        { map $lightmap  rgbGen identity }
        { map textures/base_floor/clangdark.tga
          blendFunc GL_DST_COLOR GL_ZERO
          rgbGen identity }
      }
    `);
    expect(fogPassOf(floor, 0)).toBe('equal');
  });

  it('treats GL_ONE GL_ZERO as no blend at all', () => {
    // tr_shader.c:1026 clears both blend bits for that pair explicitly.
    const wall = shaderOf(`
      textures/base_wall/x
      { { map textures/base_wall/x.tga  blendFunc GL_ONE GL_ZERO } }
    `);
    expect(fogPassOf(wall, 0)).toBe('equal');
  });

  it('fogs an alpha-tested grate, which is still SS_OPAQUE', () => {
    // alphaFunc sets no blend bits, so the sort branch is never entered.
    const grate = shaderOf(`
      textures/base_support/x
      { { map textures/base_support/x.tga  alphaFunc GE128  depthWrite } }
    `);
    expect(fogPassOf(grate, 0)).toBe('equal');
  });

  it('gives a fog brush its own FP_LE pass', () => {
    // de4th_run1's actual fog shader. Stage 0 is `blendfunc filter`, so the sort
    // is past SS_OPAQUE, but CONTENTS_FOG catches it on the second branch.
    const fog = shaderOf(`
      textures/sfx/mkc_fog_ctfred
      {
        surfaceparm trans
        surfaceparm nonsolid
        surfaceparm fog
        surfaceparm nolightmap
        fogparms ( 0.3 0.2 0.2 ) 320
        { map textures/liquids/kc_fogcloud3.tga  blendfunc gl_dst_color gl_zero }
        { map textures/liquids/kc_fogcloud3.tga  blendfunc gl_dst_color gl_zero }
      }
    `);
    expect(fogPassOf(fog, 0)).toBe('le');
  });

  it('gives a fogonly shader FP_LE, since SS_FOG is past SS_OPAQUE', () => {
    // "fogonly shaders don't have any normal passes" -> shader.sort = SS_FOG.
    const fogonly = shaderOf(`
      textures/sfx/fogonly
      {
        surfaceparm fog
        fogparms ( 0.5 0.5 0.5 ) 512
      }
    `);
    expect(fogonly.stages.length).toBe(0);
    expect(fogPassOf(fogonly, 0)).toBe('le');
  });

  it('does NOT fog a translucent surface that is not a fog volume', () => {
    // `fogPass` stays 0. Glass and glows inside a fog brush are simply unfogged
    // in Quake -- it looks like a bug and is the behaviour.
    const glow = shaderOf(`
      textures/sfx/flare
      { { map textures/sfx/flare.tga  blendFunc GL_ONE GL_ONE } }
    `);
    expect(fogPassOf(glow, 0)).toBeNull();
  });

  it('takes CONTENTS_FOG from the BSP shader lump when the script is missing', () => {
    // 64 is CONTENTS_FOG in surfaceflags.h.
    expect(fogPassOf(null, 64)).toBe('equal'); // no script -> opaque wins first
    const glow = shaderOf(`
      textures/sfx/x
      { { map textures/sfx/x.tga  blendFunc GL_ONE GL_ONE } }
    `);
    expect(fogPassOf(glow, 64)).toBe('le');
  });
});

describe('fogIndexOf', () => {
  const fogs: (Fog | null)[] = [null, GROUND_FOG];

  it('maps fogNum -1 to the no-fog sentinel', () => {
    expect(fogIndexOf(-1, fogs)).toBe(0);
  });

  it('maps fogNum 0 to the first real fog', () => {
    expect(fogIndexOf(0, fogs)).toBe(1);
  });

  it('rejects an index past the end of the table', () => {
    // q3dm6 and q3dm17: fogNum 0 on a map whose LUMP_FOGS is empty, so the
    // table is just the sentinel.
    expect(fogIndexOf(0, [null])).toBe(0);
    expect(fogIndexOf(7, fogs)).toBe(0);
  });
});

describe('R_LoadFogs', () => {
  /**
   * A BSP with one axial fog brush, laid out the way the compiler emits one:
   * six sides, axial first, in -X +X -Y +Y -Z +Z order, and the plane for a
   * negative-facing side stores the NEGATED coordinate.
   */
  const bspWithFog = (visibleSide: number): BspFile =>
    ({
      fogs: [{ shader: 'textures/sfx/testfog', brushNum: 0, visibleSide }],
      brushes: [{ firstSide: 0, numSides: 6, shaderNum: 0 }],
      brushSides: [0, 1, 2, 3, 4, 5].map((planeNum) => ({ planeNum, shaderNum: 0 })),
      planes: [
        { normal: [-1, 0, 0] as [number, number, number], dist: 16 }, // mins x = -16
        { normal: [1, 0, 0] as [number, number, number], dist: 32 }, // maxs x =  32
        { normal: [0, -1, 0] as [number, number, number], dist: 64 },
        { normal: [0, 1, 0] as [number, number, number], dist: 128 },
        { normal: [0, 0, -1] as [number, number, number], dist: 8 },
        { normal: [0, 0, 1] as [number, number, number], dist: 208 },
      ],
    }) as unknown as BspFile;

  const shaders = mergeShaderFiles([
    `textures/sfx/testfog
     {
       surfaceparm fog
       fogparms ( 0.3 0.2 0.2 ) 320
     }`,
  ]);

  it('leaves entry 0 as the no-fog sentinel', () => {
    // `s_worldData.numfogs = count + 1; out = s_worldData.fogs + 1;`
    const fogs = loadFogs(bspWithFog(5), shaders);
    expect(fogs.length).toBe(2);
    expect(fogs[0]).toBeNull();
  });

  it('gives a map with no fog brushes a table of length 1', () => {
    const empty = { ...bspWithFog(5), fogs: [] } as BspFile;
    expect(loadFogs(empty, shaders)).toEqual([null]);
  });

  it('negates the even sides when reading the bounds', () => {
    // bounds[0][n] = -dist(2n), bounds[1][n] = dist(2n+1). Skip the negation and
    // the volume ends up mirrored about the origin.
    const fog = loadFogs(bspWithFog(5), shaders)[1];
    expect(fog?.bounds).toEqual([
      [-16, -64, -8],
      [32, 128, 208],
    ]);
  });

  it('scales tcScale by eight, not by depthForOpaque alone', () => {
    // `out->tcScale = 1.0f / ( d * 8 )`. The eight is paid back by `s *= 8` in
    // R_FogFactor; dropping both would work, dropping one would not.
    const fog = loadFogs(bspWithFog(5), shaders)[1];
    expect(fog?.tcScale).toBeCloseTo(1 / (320 * 8), 12);
  });

  it('floors depthForOpaque at 1', () => {
    // `d = fogParms.depthForOpaque < 1 ? 1 : fogParms.depthForOpaque`.
    const thin = mergeShaderFiles([
      'textures/sfx/testfog { surfaceparm fog  fogparms ( 1 1 1 ) 0.25 }',
    ]);
    const fog = loadFogs(bspWithFog(5), thin)[1];
    expect(fog?.tcScale).toBeCloseTo(1 / 8, 12);
  });

  it('negates the visible side plane into the gradient vector', () => {
    // `VectorSubtract( vec3_origin, plane.normal, out->surface )` and
    // `out->surface[3] = -plane.dist`. Side 5 here is the +Z top at dist 208.
    const fog = loadFogs(bspWithFog(5), shaders)[1];
    expect(fog?.hasSurface).toBe(true);
    expect(fog?.surface).toEqual([0, 0, -1, -208]);
  });

  it('marks visibleSide -1 as having no surface', () => {
    const fog = loadFogs(bspWithFog(-1), shaders)[1];
    expect(fog?.hasSurface).toBe(false);
  });

  it('drops a fog whose shader has no fogParms rather than fogging to black', () => {
    // Deliberate deviation: `R_FindShader(..., qtrue)` would hand back a default
    // shader with a zeroed fogParms, i.e. black fog opaque at one unit.
    const noParms = mergeShaderFiles(['textures/sfx/testfog { surfaceparm fog }']);
    expect(loadFogs(bspWithFog(5), noParms)[1]).toBeNull();
  });

  it('drops a fog whose brush is out of range instead of failing the map', () => {
    const broken = { ...bspWithFog(5), fogs: [{ shader: 'x', brushNum: 99, visibleSide: 5 }] };
    expect(loadFogs(broken as BspFile, shaders)[1]).toBeNull();
  });
});

// --- real maps, opt-in -----------------------------------------------------
//
// No map is committed (see .gitignore for why). `dev-de4th_run1.pk3` comes out
// of `npm run build-devpak`; the plain `de4th_run1.pk3` comes from the asset
// manifest. Whichever is present is enough.
const PAKS: Record<string, string[]> = {
  de4th_run1: ['public/dev-de4th_run1.pk3', 'public/de4th_run1.pk3'],
  q3dm6: ['public/dev-q3dm6.pk3'],
  q3dm17: ['public/dev-q3dm17.pk3'],
  q3dm4: ['public/dev-q3dm4.pk3'],
  q3dm7: ['public/dev-q3dm7.pk3'],
};

function pakFor(map: string): string | null {
  return PAKS[map].find((p) => existsSync(p)) ?? null;
}

/** Every `.shader` in the map's pak, keyed the way `shaderKey` keys them. */
async function loadShaders(map: string): Promise<Map<string, Shader>> {
  const path = pakFor(map);
  if (!path) {
    throw new Error(`no pak for ${map}`);
  }
  const fs = new Pk3FileSystem();
  await fs.mount(basename(path), await openAsBlob(path));
  const texts: string[] = [];
  for (const entry of fs.list({ prefix: 'scripts/' })) {
    if (entry.endsWith('.shader')) {
      const text = await fs.readText(entry);
      if (text) {
        texts.push(text);
      }
    }
  }
  return mergeShaderFiles(texts);
}

async function loadMap(map: string): Promise<BspFile> {
  const path = pakFor(map);
  if (!path) {
    throw new Error(`no pak for ${map}`);
  }
  const fs = new Pk3FileSystem();
  await fs.mount(basename(path), await openAsBlob(path));
  const name = fs.listMaps()[0];
  const bytes = await fs.readFile(`maps/${name}.bsp`);
  if (!bytes) {
    throw new Error(`no .bsp inside ${path}`);
  }
  return parseBsp(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

describe.each(['q3dm6', 'q3dm17'])('%s has no fog and must stay that way', (map) => {
  it.skipIf(!pakFor(map))('resolves every surface to the no-fog sentinel', async () => {
    const bsp = await loadMap(map);

    // LUMP_FOGS is empty, so the table is the sentinel alone.
    expect(bsp.fogs.length).toBe(0);
    const fogs = loadFogs(bsp, new Map());
    expect(fogs).toEqual([null]);

    // ...and yet the map DOES carry surfaces claiming fogNum 0, which is index
    // 1 into that one-entry table. This asserts the range guard is
    // load-bearing, not that the map is tidy.
    expect(bsp.surfaces.some((s) => s.fogNum === 0)).toBe(true);
    for (const surface of bsp.surfaces) {
      expect(fogIndexOf(surface.fogNum, fogs)).toBe(0);
    }
  });
});

describe('de4th_run1 ground fog', () => {
  it.skipIf(!pakFor('de4th_run1'))('loads both volumes with the shape the map has', async () => {
    const bsp = await loadMap('de4th_run1');
    expect(bsp.fogs.length).toBe(2);
    for (const f of bsp.fogs) {
      expect(f.shader).toBe('textures/sfx/mkc_fog_ctfred');
      // The +Z top of the brush: you look DOWN into this fog.
      expect(f.visibleSide).toBe(5);
    }

    const shaders = mergeShaderFiles([
      `textures/sfx/mkc_fog_ctfred
       {
         surfaceparm fog
         fogparms ( 0.3 0.2 0.2 ) 320
         { map textures/liquids/kc_fogcloud3.tga  blendfunc gl_dst_color gl_zero }
       }`,
    ]);
    const fogs = loadFogs(bsp, shaders);
    // numfogs = count + 1
    expect(fogs.length).toBe(3);

    // Fog 2 is the ground layer: the whole map floor, 200 units thick, with its
    // top plane at z = 208. Read straight out of the .bsp's brush sides.
    expect(fogs[2]?.bounds).toEqual([
      [-1592, -760, 8],
      [1592, 760, 208],
    ]);
    expect(fogs[2]?.surface).toEqual([0, 0, -1, -208]);
    expect(fogs[2]?.tcScale).toBeCloseTo(1 / 2560, 12);

    // Some surfaces are inside it and most are not -- a fog volume tags the
    // surfaces the compiler found inside the brush, nothing more.
    const fogged = bsp.surfaces.filter((s) => fogIndexOf(s.fogNum, fogs) !== 0);
    expect(fogged.length).toBeGreaterThan(0);
    expect(fogged.length).toBeLessThan(bsp.surfaces.length);
  });
});

describe('fogonly shaders draw nothing of their own', () => {
  /**
   * `FinishShader` gives a stage-less fog shader `SS_FOG`, and the C says why
   * outright: "fogonly shaders don't have any normal passes". Its faces exist
   * to bound the volume; the fog pass is what makes them visible.
   *
   * Drawing one as ordinary geometry put a magenta checkerboard on the ceiling
   * of every fog box, because with no stages there is no `map` to resolve and
   * it fell through to the missing-texture marker. Two shipped maps are this
   * shape -- q3dm4's `xdensegreyfog` and q3dm7's `fog_intel` -- and both showed
   * it. q3dm7's `hellfogdense` and de4th_run1's `mkc_fog_ctfred` escaped only
   * because they happen to carry cloud stages for their own sake, which is why
   * this went unnoticed.
   */
  const fogonly = `textures/sfx/xdensegreyfog
{
  qer_editorimage textures/sfx/fog_grey1.tga
  surfaceparm trans
  surfaceparm nonsolid
  surfaceparm fog
  surfaceparm nolightmap
  fogparms ( 0.7 0.7 0.7 ) 1700
}`;

  const foggyClouds = `textures/sfx/hellfogdense
{
  surfaceparm fog
  surfaceparm nolightmap
  fogparms ( 0.55 0.11 0.1 ) 128
  {
    map textures/liquids/kc_fogcloud3.tga
    blendfunc gl_dst_color gl_zero
  }
}`;

  it('recognises the stage-less form', () => {
    const s = parseShaderFile(fogonly).get(shaderKey('textures/sfx/xdensegreyfog'))!;
    expect(s.stages).toHaveLength(0);
    expect(s.surfaceparms.has('fog')).toBe(true);
    expect(s.fogParms).not.toBeNull();
  });

  it('does not mistake a fog shader that DOES have stages for one', () => {
    // The distinction is stages, not `surfaceparm fog`. Skipping every fog
    // shader would delete de4th_run1's drifting cloud layers, which are the
    // shader's whole visible contribution.
    const s = parseShaderFile(foggyClouds).get(shaderKey('textures/sfx/hellfogdense'))!;
    expect(s.surfaceparms.has('fog')).toBe(true);
    expect(s.stages.length).toBeGreaterThan(0);
  });

  it('still gives the stage-less form a usable fog volume', () => {
    // Skipping the geometry must not skip the FOG. The volume is the entire
    // point of the shader.
    const s = parseShaderFile(fogonly).get(shaderKey('textures/sfx/xdensegreyfog'))!;
    expect(s.fogParms!.color).toEqual([0.7, 0.7, 0.7]);
    expect(s.fogParms!.depthForOpaque).toBe(1700);
  });
});

// --- the fogonly geometry, which RB_FogPass needs ---------------------------

describe('isFogOnlyShader', () => {
  const fogonly = `textures/sfx/xdensegreyfog
{
  surfaceparm fog
  fogparms ( 0.7 0.7 0.7 ) 1700
}`;
  const staged = `textures/sfx/hellfogdense
{
  surfaceparm fog
  fogparms ( 0.55 0.11 0.1 ) 128
  { map textures/liquids/kc_fogcloud3.tga  blendfunc gl_dst_color gl_zero }
}`;
  const empty = `textures/common/nodraw
{
  surfaceparm nodraw
}`;

  const shader = (text: string, name: string): Shader =>
    parseShaderFile(text).get(shaderKey(name))!;

  it('is true only for `surfaceparm fog` with no stages', () => {
    expect(isFogOnlyShader(shader(fogonly, 'textures/sfx/xdensegreyfog'))).toBe(true);
    expect(isFogOnlyShader(shader(staged, 'textures/sfx/hellfogdense'))).toBe(false);
    // Stage-less but not a fog volume: not fogonly, and nothing draws it either.
    expect(isFogOnlyShader(shader(empty, 'textures/common/nodraw'))).toBe(false);
    expect(isFogOnlyShader(null)).toBe(false);
  });

  it('is FP_LE, which is what makes its faces visible at all', () => {
    // `FinishShader`: stage == 0 -> sort = SS_FOG, well past SS_OPAQUE. Then
    // `GeneratePermanentShader` falls through to the CONTENTS_FOG branch.
    const s = shader(fogonly, 'textures/sfx/xdensegreyfog');
    expect(fogPassOf(s, 0)).toBe('le');
  });
});

describe('q3dm4: one fogonly volume, and its faces must survive', () => {
  it.skipIf(!pakFor('q3dm4'))('keeps the geometry RB_FogPass draws', async () => {
    const bsp = await loadMap('q3dm4');
    const shaders = await loadShaders('q3dm4');

    expect(bsp.fogs).toHaveLength(1);
    const fogs = loadFogs(bsp, shaders);
    expect(fogs).toHaveLength(2);
    expect(fogs[1]?.color).toEqual([0.7, 0.7, 0.7]);
    expect(fogs[1]?.depthForOpaque).toBe(1700);

    // The volume's own faces are a stage-less `xdensegreyfog`, and the compiler
    // emits each one TWICE: an outward-facing copy with `fogNum -1` and an
    // inward-facing copy carrying the volume's own index. Only the second
    // passes `RB_StageIteratorGeneric`'s `tess.fogNum &&` gate, so only the
    // second is ever drawn -- by `RB_FogPass`, since there are no stages.
    const own = bsp.surfaces.filter((surface) =>
      isFogOnlyShader(shaders.get(shaderKey(bsp.shaders[surface.shaderNum].shader))),
    );
    expect(own.length).toBe(2);

    const inside = own.filter((s) => fogIndexOf(s.fogNum, fogs) === 1);
    const outside = own.filter((s) => fogIndexOf(s.fogNum, fogs) === 0);
    expect(inside).toHaveLength(1);
    expect(outside).toHaveLength(1);

    // Both copies are the CEILING of the pit, at the top of the volume. That is
    // what makes deleting them so visible: skipping the surface as geometry --
    // which an earlier fix did, to stop the missing-texture checkerboard --
    // leaves a hole in a dense grey volume through which the unfogged room
    // above is perfectly crisp.
    for (const surface of own) {
      expect(surface.numIndexes).toBeGreaterThan(0);
      for (let k = 0; k < surface.numVerts; k++) {
        expect(bsp.drawVerts[(surface.firstVert + k) * 3 + 2]).toBeCloseTo(
          fogs[1]!.bounds[1][2],
          3,
        );
      }
    }

    const declared = shaders.get(shaderKey(bsp.shaders[inside[0].shaderNum].shader))!;
    expect(fogPassOf(declared, bsp.shaders[inside[0].shaderNum].contentFlags)).toBe('le');
  });
});

describe('q3dm7: two volumes with very different parameters', () => {
  it.skipIf(!pakFor('q3dm7'))('gives every surface the parameters of ITS OWN fog', async () => {
    const bsp = await loadMap('q3dm7');
    const shaders = await loadShaders('q3dm7');

    expect(bsp.fogs).toHaveLength(2);
    const fogs = loadFogs(bsp, shaders);

    // The index convention, asserted directly rather than defensively: the
    // table is 1-based with a sentinel at 0, so raw `fogNum n` is entry n + 1.
    // With an empty table this was untestable; with two real entries it is
    // load-bearing, and off by one would swap a 128-unit blood fog for an
    // 800-unit orange one.
    expect(fogs).toHaveLength(3);
    expect(fogs[0]).toBeNull();
    expect(fogIndexOf(-1, fogs)).toBe(0);
    expect(fogIndexOf(0, fogs)).toBe(1);
    expect(fogIndexOf(1, fogs)).toBe(2);

    // textures/sfx/hellfogdense, then textures/sfx/fog_intel, in LUMP_FOGS
    // order.
    expect(fogs[1]?.color.map((c) => +c.toFixed(2))).toEqual([0.55, 0.11, 0.1]);
    expect(fogs[1]?.depthForOpaque).toBe(128);
    expect(fogs[2]?.color.map((c) => +c.toFixed(2))).toEqual([0.75, 0.38, 0]);
    expect(fogs[2]?.depthForOpaque).toBe(800);

    // 1 / (depthForOpaque * 8), so the dense one ramps up 6.25x faster.
    expect(fogs[1]!.tcScale / fogs[2]!.tcScale).toBeCloseTo(800 / 128, 9);

    // Both volumes really do own surfaces, and the two sets are disjoint --
    // which is the property a single shared fog uniform would break.
    const inFog = [0, 0, 0];
    for (const surface of bsp.surfaces) {
      inFog[fogIndexOf(surface.fogNum, fogs)]++;
    }
    expect(inFog[1]).toBeGreaterThan(0);
    expect(inFog[2]).toBeGreaterThan(0);
    expect(inFog[0] + inFog[1] + inFog[2]).toBe(bsp.surfaces.length);

    // A vertex 128 units into hellfogdense is fully fogged; the same distance
    // into fog_intel is barely a third of the way there. Same geometry, same
    // eye: the difference is entirely which fog the surface belongs to.
    const dense = fogFactor(128 * fogs[1]!.tcScale + 1 / 512, 31 / 32);
    const thin = fogFactor(128 * fogs[2]!.tcScale + 1 / 512, 31 / 32);
    expect(dense).toBeCloseTo(1, 6);
    expect(thin).toBeCloseTo(Math.sqrt(128 / 800), 2);
  });
});

describe('a model in a map with several fog volumes', () => {
  /*
   * The regression this guards is a shader VARYING NAME COLLISION, and it is
   * worth stating because the symptom pointed nowhere near the cause.
   *
   * `fogFactorNode` wraps its texture coordinate in `varying(..., name)`. A
   * world material compiles exactly one fog term -- batches are keyed by fog
   * index, so two volumes can never share a program -- so one fixed name was
   * fine while that was the only caller. `applyEntityFog` broke it: a MODEL
   * material compiles one term per volume in the map, so on q3dm7 two terms
   * both declared `vFogTexCoord` in one program and the first one won.
   *
   * Every model in fog 2 was then shaded against fog 1's distance plane, which
   * is on the far side of the map, so the factor came out zero and the model
   * rendered completely unfogged: q3dm7's red armour sat bright red in a
   * corridor of orange soup while every surface around it was tinted.
   *
   * The name is now `vFogTexCoord${fog.originalBrushNumber}`. That is only
   * unique if the brush numbers are, which is what this asserts against the
   * real table rather than against a synthetic one.
   */
  it.skipIf(!pakFor('q3dm7'))('gives every volume a distinct brush number to name its varying with', async () => {
    const fogs = loadFogs(await loadMap('q3dm7'), await loadShaders('q3dm7'));
    const real = fogs.filter((f): f is Fog => f !== null);

    // Two volumes, which is what makes q3dm7 the map that exposed this.
    expect(real).toHaveLength(2);

    const numbers = real.map((f) => f.originalBrushNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it.skipIf(!pakFor('q3dm7'))('keeps the volumes distinguishable by their own parameters', async () => {
    // The other half of the same bug: sharing a varying meant sharing a
    // distance plane. These two volumes are nothing alike, so a model taking
    // the wrong one is not a subtle error -- 128 units to opaque against 800,
    // and dark red against orange.
    const fogs = loadFogs(await loadMap('q3dm7'), await loadShaders('q3dm7'));
    const real = fogs.filter((f): f is Fog => f !== null);

    const depths = real.map((f) => f.depthForOpaque).sort((a, b) => a - b);
    expect(depths).toEqual([128, 800]);
    // And their bounds do not overlap, so `entityFogNum` can never return both.
    const [a, b] = real;
    const separated =
      a.bounds[1][0] < b.bounds[0][0] ||
      b.bounds[1][0] < a.bounds[0][0] ||
      a.bounds[1][1] < b.bounds[0][1] ||
      b.bounds[1][1] < a.bounds[0][1] ||
      a.bounds[1][2] < b.bounds[0][2] ||
      b.bounds[1][2] < a.bounds[0][2];
    expect(separated).toBe(true);
  });
});


/**
 * The feather -- the one thing in `fog.ts` that is NOT a port.
 *
 * These assert the SHAPE the file header argues for, not a picture: that the
 * ramp starts flat (which is what cancels `sqrt`'s infinite slope, and the
 * whole reason a `smoothstep` and not a `clamp`), that it scales with each
 * volume so a shallow fog is not erased by a distance tuned on a deep one, and
 * that zero is not "a very short ramp" but `R_FogFactor` untouched.
 */
describe('the fog feather', () => {
  it('is off at the plane and full a feather-distance below it', () => {
    expect(fogFeather(0, 100)).toBe(0);
    expect(fogFeather(100, 100)).toBe(1);
    // Above the plane at all is outside, and stays outside.
    expect(fogFeather(-50, 100)).toBe(0);
    // Past the far end it saturates rather than overshooting.
    expect(fogFeather(1000, 100)).toBe(1);
  });

  it('starts flat, which is the point of it', () => {
    // A linear ramp would give 0.1 at a tenth of the way in; `sqrt` on top of
    // a linear ramp would give more. `smoothstep` gives much less, and that
    // near-zero slope at the plane is what removes the visible edge.
    expect(fogFeather(10, 100)).toBeCloseTo(0.028, 3);
    expect(fogFeather(50, 100)).toBe(0.5);
    expect(fogFeather(90, 100)).toBeCloseTo(0.972, 3);
  });

  it('is disabled, not shortened, at zero', () => {
    expect(fogFeather(0, 0)).toBe(1);
    expect(fogFeather(-1000, 0)).toBe(1);
    expect(fogFeatherDistance(GROUND_FOG, 0)).toBe(0);
  });

  it('measures thickness along the visible-side normal', () => {
    // The volume is 3184 x 1520 x 200 and its visible side is the +Z top, so
    // the thickness that matters is the 200.
    expect(fogThickness(GROUND_FOG)).toBe(200);
    expect(fogFeatherDistance(GROUND_FOG, 0.75)).toBe(150);
    expect(fogFeatherDistance(GROUND_FOG)).toBe(200 * FOG_FEATHER);
  });

  it('scales with the volume, so a shallow fog keeps its density', () => {
    // A 32-unit fog sheet -- the case a fixed distance tuned on a 200-unit
    // volume would very nearly erase. Scaled, and with a fraction below 1, its
    // far face gets exactly the density Quake gives it.
    const sheet: Fog = {
      ...GROUND_FOG,
      bounds: [
        [-512, -512, 0],
        [512, 512, 32],
      ],
      surface: [0, 0, -1, -32],
    };
    expect(fogThickness(sheet)).toBe(32);
    const d = fogFeatherDistance(sheet);
    expect(d).toBe(24);
    expect(fogFeather(32, d)).toBe(1);
    // The deep quarter of every volume is untouched, whatever its thickness:
    // the same holds for the 200-unit ground fog.
    expect(fogFeather(200, fogFeatherDistance(GROUND_FOG))).toBe(1);
  });

  it('has no plane to feather against without a visible side', () => {
    const noSurface: Fog = { ...GROUND_FOG, hasSurface: false, surface: [0, 0, 0, 0] };
    expect(fogThickness(noSurface)).toBe(0);
    expect(fogFeatherDistance(noSurface)).toBe(0);
    // ...and `fogPlaneDepth` says the same thing the other way round: every
    // point is infinitely far inside a volume with no plane.
    expect(fogPlaneDepth([0, 0, 0], noSurface)).toBe(Number.POSITIVE_INFINITY);
  });

  /*
   * The case every screenshot of this missed, and the one that would have
   * reintroduced a bug the project already fixed once.
   *
   * With the eye INSIDE a volume, a vertex on the fog's own ceiling has
   * `fogPlaneDepth` exactly 0 while the ray reaching it has crossed the whole
   * distance from the eye up to that face. Quake fogs it (`t >= 0` takes
   * `31/32`); a feather measured on the vertex alone would multiply it by
   * `smoothstep(0) == 0` and delete the ceiling -- `isFogOnlyShader`'s hole in
   * the fog, where you stand in a pit and look up through an unfogged window.
   */
  it('measures the deeper end of the ray, not the vertex', () => {
    // Eye 100 units under the top plane (z = 208), vertex ON the plane.
    const eye: [number, number, number] = [0, 0, 108];
    const onCeiling: [number, number, number] = [0, 0, 208];
    expect(fogPlaneDepth(onCeiling, GROUND_FOG)).toBe(0);
    expect(fogRayDepth(onCeiling, eye, GROUND_FOG)).toBe(100);
    // ...and that is what keeps the ceiling visible.
    const d = fogFeatherDistance(GROUND_FOG);
    expect(fogFeather(fogPlaneDepth(onCeiling, GROUND_FOG), d)).toBe(0);
    expect(fogFeather(fogRayDepth(onCeiling, eye, GROUND_FOG), d)).toBeGreaterThan(0.2);
  });

  it('is the vertex depth whenever the eye is outside, unchanged', () => {
    // Eye above the plane: `eyeT` is negative, so the deeper end is always the
    // vertex and every picture taken from outside is bit-identical.
    const eye: [number, number, number] = [0, 0, 400];
    for (const z of [300, 208, 200, 108, 8]) {
      const v: [number, number, number] = [0, 0, z];
      expect(fogRayDepth(v, eye, GROUND_FOG)).toBe(fogPlaneDepth(v, GROUND_FOG));
    }
  });

  it('measures depth below the plane in world units', () => {
    // The top of de4th_run1's ground fog is z = 208.
    expect(fogPlaneDepth([0, 0, 208], GROUND_FOG)).toBe(0);
    expect(fogPlaneDepth([0, 0, 108], GROUND_FOG)).toBe(100);
    expect(fogPlaneDepth([0, 0, 300], GROUND_FOG)).toBe(-92);
    // Same dot product `fogTexCoords` takes before squeezing it onto the fog
    // image's T axis, which is what makes one testable against the other.
    expect(fogPlaneDepth([0, 0, 108], GROUND_FOG)).toBe(
      108 * GROUND_FOG.surface[2] - GROUND_FOG.surface[3],
    );
  });
});

describe('?fogfeather', () => {
  const parse = (q: string): number => parseFogOptions(new URLSearchParams(q)).feather;

  it('defaults to FOG_FEATHER when absent', () => {
    expect(parse('')).toBe(FOG_FEATHER);
    expect(DEFAULT_FOG_OPTIONS.feather).toBe(FOG_FEATHER);
  });

  it('takes zero, which is the faithful picture', () => {
    expect(parse('fogfeather=0')).toBe(0);
  });

  it('takes a fraction', () => {
    expect(parse('fogfeather=0.25')).toBe(0.25);
    expect(parse('fogfeather=2')).toBe(2);
  });

  it('falls back to the default on nonsense rather than removing the fog', () => {
    expect(parse('fogfeather=lots')).toBe(FOG_FEATHER);
    expect(parse('fogfeather=-1')).toBe(FOG_FEATHER);
  });
});
