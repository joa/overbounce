/**
 * `blendFunc GL_DST_COLOR GL_ONE`, which is every body of water in the game.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The reported bug was "water in q3ctf2 renders as a black blob", and the cause
 * was entirely in this classification. Two rules combined to produce it:
 *
 *   - `isModulateStage` answered `multiply` for `GL_DST_COLOR GL_ONE`, which
 *     computes `dst * src`. GL computes `dst * src + dst * 1` = `dst * (1+src)`.
 *     Water is two dark blue textures and a lightmap, so the difference between
 *     the two is the difference between a pool and a hole.
 *   - `shaderComposition` forced the FIRST stage to `replace`, on the reasoning
 *     that nothing is underneath it. For a stage that multiplies the
 *     FRAMEBUFFER that reasoning does not hold: what is underneath is the pool
 *     floor, and replacing it is what made the surface opaque.
 *
 * The fixture is verbatim from `scripts/liquid.shader`, because the shape of a
 * real water shader -- no diffuse, no opaque stage anywhere, every pass a
 * modulation -- is exactly what a hand-written fixture would fail to capture.
 */

import { describe, it, expect } from 'vitest';
import {
  isBrightenStage,
  isFilterStage,
  isModulatedSurface,
  parseShaderFile,
  shaderComposition,
  stageOp,
} from '../../src/assets/shader.js';

/** `textures/liquids/clear_calm1`, the water in q3ctf2's central pool. */
const CLEAR_CALM1 = `
textures/liquids/clear_calm1
	{
		qer_editorimage textures/liquids/pool3d_3e.tga
		qer_trans .5
		q3map_globaltexture
		surfaceparm trans
		surfaceparm nonsolid
		surfaceparm water

		cull disable
		deformVertexes wave 64 sin .25 .25 0 .5
		{
			map textures/liquids/pool3d_5e.tga
			blendFunc GL_dst_color GL_one
			rgbgen identity
			tcmod scale .5 .5
			tcmod scroll .025 .01
		}

		{
			map textures/liquids/pool3d_3e.tga
			blendFunc GL_dst_color GL_one
			tcmod scale -.5 -.5
			tcmod scroll .025 .025
		}

		{
			map $lightmap
			blendFunc GL_dst_color GL_zero
			rgbgen identity
		}
	}
`;

const water = (): ReturnType<typeof parseShaderFile> => parseShaderFile(CLEAR_CALM1);

describe('GL_DST_COLOR GL_ONE', () => {
  const shader = () => water().get('textures/liquids/clear_calm1')!;

  it('parses as a brighten, and is neither an add nor a multiply', () => {
    const stage = shader().stages[0];
    expect(isBrightenStage(stage)).toBe(true);
    // The two it used to be mistaken for. `isFilterStage` in particular decides
    // how a SURFACE meets the scene, and widening it to cover this would
    // reclassify surfaces rather than stages.
    expect(isFilterStage(stage)).toBe(false);
  });

  it('keeps its own op as the FIRST stage', () => {
    /*
     * The exception, and the whole fix. Everywhere else the first drawable
     * stage owns the pixel; here it multiplies the framebuffer, so forcing
     * `replace` discards the pool floor and leaves the water's own dark texture
     * standing alone.
     */
    const ops = shaderComposition(shader()).map((c) => c.op);
    expect(ops).toEqual(['brighten', 'brighten', 'multiply']);
  });

  it('leaves a filter first stage replacing, which is the same expression', () => {
    // `GL_DST_COLOR GL_ZERO`'s factor is `src` alone, so starting from an
    // identity destination and starting from the texture agree. Only the
    // brighten form carries the `1 +` that makes the distinction matter.
    const decal = parseShaderFile(`
textures/base_wall/patch10floor
	{
		{
			map textures/base_wall/patch10.tga
			blendFunc GL_dst_color GL_zero
		}
	}
`).get('textures/base_wall/patch10floor')!;
    expect(shaderComposition(decal).map((c) => c.op)).toEqual(['replace']);
  });

  it('is a MODULATED surface, so it filters the scene rather than covering it', () => {
    /*
     * This is what `bsp-mesh.ts` reads to pick `applyFilterBlend` and to keep
     * the surface out of the lit pipeline. Before the fix nothing matched
     * stage 0 at all, so the material came out opaque -- the "blob" half of
     * "black blob", the "black" half being the multiply above.
     */
    expect(isModulatedSurface(shader())).toBe(true);
  });

  it('still reads the surfaceparms the game side needs', () => {
    // `isWaterShader` in `lava.ts` keys off this, and the physics keys off
    // CONTENTS_WATER, which is a different thing entirely and comes from the
    // brush rather than from the shader.
    expect(shader().surfaceparms.has('water')).toBe(true);
  });
});

describe('stageOp', () => {
  it('answers brighten before it falls back to multiply', () => {
    const stage = water().get('textures/liquids/clear_calm1')!.stages[0];
    expect(stageOp(stage)).toBe('brighten');
  });
});
