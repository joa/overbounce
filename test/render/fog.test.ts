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
  FOG_TABLE_SIZE,
  fogFactor,
  fogIndexOf,
  fogPassOf,
  fogTexCoords,
  initFogTable,
  loadFogs,
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
};

function pakFor(map: string): string | null {
  return PAKS[map].find((p) => existsSync(p)) ?? null;
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
   * it. de4th_run1's `hellfogdense` escaped only because it happens to carry
   * cloud stages for its own sake, which is why this went unnoticed.
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
