/**
 * The blend state a Quake blendfunc turns into.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `buildWorldSurfaces` needs a GPU device, so the material it builds cannot be
 * asserted end to end in Node. The decision that goes wrong, though, is pure:
 * which three blend state a `blendFunc` maps to. This pins it.
 *
 * The bug being guarded against is nastier than a wrong colour. three's WebGPU
 * backend (`WebGPUPipelineUtils._getBlending`) only emits a multiply blend for a
 * material with `premultipliedAlpha = true`. Given `MultiplyBlending` on an
 * ordinary material it logs
 *
 *     "MultiplyBlending" requires "material.premultipliedAlpha = true"
 *     Invalid blending: 4
 *
 * and returns NO blend state, so the surface draws OPAQUE. That is the exact
 * inverse of the intent: a pass that should darken what is behind it covers it
 * instead, and the only warning is two console lines nobody reads.
 *
 * de4th_run1's ground fog is what found it. `textures/sfx/mkc_fog_ctfred` is
 * two counter-scrolling `GL_DST_COLOR GL_ZERO` cloud layers; with the blend
 * dropped, the entire floor of the map vanished under a flat white sheet.
 */

import { describe, it, expect } from 'vitest';
import {
  AddEquation,
  CustomBlending,
  DstColorFactor,
  MeshBasicNodeMaterial,
  MultiplyBlending,
  ZeroFactor,
} from 'three/webgpu';
import { applyFilterBlend } from '../../src/render/blend.js';
import {
  isFilterStage,
  parseShaderFile,
  shaderBlendBase,
} from '../../src/assets/shader.js';

/**
 * `textures/sfx/mkc_fog_ctfred`, verbatim from `scripts/sfx.shader`.
 *
 * Inlined rather than read from a pak because retail Quake III content is not
 * redistributable and cannot be committed. The shape is what matters: no
 * lightmap at all, and two identical cloud layers multiplied over the scene
 * with opposed `tcMod scale` signs so they drift against each other.
 */
const MKC_FOG_CTFRED = `
textures/sfx/mkc_fog_ctfred
{
	qer_editorimage textures/sfx/fog_timdm1.tga
	surfaceparm	trans
	surfaceparm	nonsolid
	surfaceparm	fog
	surfaceparm 	nodrop
	surfaceparm 	nolightmap
	q3map_globaltexture
	fogparms ( 0.3 0.2 0.2 ) 320

	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc gl_dst_color gl_zero
		tcmod scale -.05 -.05
		tcmod scroll .01 -.01
		rgbgen identity
	}

	{
		map textures/liquids/kc_fogcloud3.tga
		blendfunc gl_dst_color gl_zero
		tcmod scale .05 .05
		tcmod scroll .01 -.01
		rgbgen identity
	}
}
`;

describe('a fog shader resolves to two multiplied cloud layers', () => {
  const shader = parseShaderFile(MKC_FOG_CTFRED).get('textures/sfx/mkc_fog_ctfred')!;

  it('honours surfaceparm nolightmap', () => {
    // A `fogparms` shader has no lightmap stage and no lightmap coordinates.
    // Multiply one in and the fog picks up the lighting of whatever surface the
    // compiler happened to give it, which is not a thing Quake ever does.
    expect(shader.lightmapped).toBe(false);
    expect(shader.stages.some((s) => s.isLightmap)).toBe(false);
  });

  it('reads both cloud layers, and their opposed scales', () => {
    // The two layers are the effect. Drop the second -- as "the diffuse stage
    // plus the additive ones" would -- and the fog is one static-looking sheet
    // rather than two sheets sliding through each other.
    expect(shader.stages).toHaveLength(2);
    expect(shader.stages[0].map).toBe('textures/liquids/kc_fogcloud3.tga');
    expect(shader.stages[1].map).toBe('textures/liquids/kc_fogcloud3.tga');
    expect(shader.stages[0].tcMods).toEqual([
      { type: 'scale', s: -0.05, t: -0.05 },
      { type: 'scroll', s: 0.01, t: -0.01 },
    ]);
    expect(shader.stages[1].tcMods).toEqual([
      { type: 'scale', s: 0.05, t: 0.05 },
      { type: 'scroll', s: 0.01, t: -0.01 },
    ]);
  });

  it('meets the scene as a multiply, not as an opaque surface', () => {
    // Stage 0 decides how the SURFACE meets the framebuffer. Here it is
    // `GL_DST_COLOR GL_ZERO`, so the fog stains the room behind it.
    const base = shaderBlendBase(shader)!;
    expect(isFilterStage(base)).toBe(true);
  });
});

describe('applyFilterBlend', () => {
  it('transcribes GL_DST_COLOR GL_ZERO literally', () => {
    const material = new MeshBasicNodeMaterial();
    applyFilterBlend(material);

    // dst * src, spelled out the way `tr_shader.c` spells it. Written as blend
    // factors rather than as a named three constant so that what three's named
    // constants happen to expand to cannot change the picture.
    expect(material.blending).toBe(CustomBlending);
    expect(material.blendEquation).toBe(AddEquation);
    expect(material.blendSrc).toBe(DstColorFactor);
    expect(material.blendDst).toBe(ZeroFactor);
  });

  it('never asks for the one combination the WebGPU backend rejects', () => {
    // THIS is the regression. `MultiplyBlending` on a material whose
    // `premultipliedAlpha` is false makes three's WebGPU backend emit no blend
    // state at all and the surface draws opaque -- so the pairing must never be
    // produced, whichever way a future edit chooses to express the multiply.
    const material = new MeshBasicNodeMaterial();
    applyFilterBlend(material);

    expect(material.blending === MultiplyBlending && !material.premultipliedAlpha).toBe(
      false,
    );
  });

  it('does not occlude what it is meant to stain', () => {
    // A multiplied surface is a filter over the geometry behind it. Writing
    // depth would let it hide the very surface it modulates, and leaving it out
    // of the transparent pass would draw it before that surface exists.
    const material = new MeshBasicNodeMaterial();
    applyFilterBlend(material);

    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
  });
});
