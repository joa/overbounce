/**
 * Quake blendfuncs as three.js blend state.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Shared by the world and the model renderers so a shader composites the same
 * way whichever one drew it. That is not tidiness: the two paths disagreeing is
 * how an ammo box ends up lit differently from the crate it is standing on.
 *
 * THE POINT OF THIS FILE: three's named blending modes are not the GL blendfuncs
 * they are named after. `WebGPUPipelineUtils._getBlending` only maps them to the
 * obvious factors when `material.premultipliedAlpha` is true, and takes a
 * different branch otherwise:
 *
 *   MultiplyBlending  -> error(), and NO blend state is emitted at all, so the
 *                        surface draws opaque. A fog sheet meant to stain the
 *                        floor covers it instead -- which is exactly how
 *                        de4th_run1's ground fog became a white slab.
 *   AdditiveBlending  -> srcFactor SrcAlpha, dstFactor One. Quake's
 *                        `GL_ONE GL_ONE` is One/One. Every additive pass comes
 *                        out scaled by its own alpha, so a glow with a real
 *                        alpha channel is dimmer than Quake draws it.
 *
 * Setting `premultipliedAlpha` would fix the factors but route the colour
 * through three's premultiply step, which Quake does not do. So the factors are
 * written out literally instead: what `tr_shader.c` parsed, and nothing else.
 */

import {
  AddEquation,
  CustomBlending,
  DstColorFactor,
  OneFactor,
  OneMinusSrcColorFactor,
  ZeroFactor,
} from 'three/webgpu';
import type { Material } from 'three/webgpu';

/**
 * `blendfunc GL_ONE GL_ONE` — add to what is already there.
 *
 * Glows, flares, lamp coronas, energy shells. The texture is a bright shape on
 * black and the black is meant to vanish.
 */
export function applyAdditiveBlend(material: Material): void {
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = OneFactor;
  material.blendDst = OneFactor;
  material.transparent = true;
  // Additive surfaces are glows hanging in front of geometry. One occluding
  // another is never right.
  material.depthWrite = false;
}

/**
 * `blendfunc filter` / `GL_DST_COLOR GL_ZERO` — multiply what is behind it.
 *
 * Decals, grime, shadow patches, and the "fake fog" sheets a lot of maps use.
 * `GL_ZERO GL_SRC_COLOR` is the same product written the other way round and
 * maps here too.
 */
export function applyFilterBlend(material: Material): void {
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = DstColorFactor;
  material.blendDst = ZeroFactor;
  material.transparent = true;
  // A multiplied surface stains what is behind it, so it must not occlude it.
  material.depthWrite = false;
}

/**
 * `blendfunc blend` / `GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA`.
 *
 * three's `NormalBlending` already maps to these factors without
 * `premultipliedAlpha`, so this only has to set the flags around it.
 */
export function applyAlphaBlend(material: Material): void {
  material.transparent = true;
  // A translucent surface that writes depth occludes whatever is behind it,
  // and for a shell that surrounds an item, "behind it" is the item.
  material.depthWrite = false;
}

/**
 * `blendfunc GL_ZERO GL_ONE_MINUS_SRC_COLOR` — darken what is behind it by the
 * texture's own colour. NOT the same product `applyFilterBlend` writes: that
 * one is `dst*src` (multiply); this is `dst*(1-src)`, so a bright texel
 * darkens the surface toward black and a black texel leaves it untouched.
 * `burn_med_mrk`/`hole_lg_mrk`/`markShadow` all use this — id draws its scorch
 * marks and the ground shadow blob as a BRIGHT shape on the source texture
 * specifically because this blendfunc inverts it. Drawing that texture with
 * ordinary alpha blending instead shows the source shape directly -- a burn
 * mark that should read as a dark scorch reads as a light smear, which is
 * this-not-that-blend, not a geometry bug.
 */
export function applyDarkenBlend(material: Material): void {
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = ZeroFactor;
  material.blendDst = OneMinusSrcColorFactor;
  material.transparent = true;
  material.depthWrite = false;
}

/**
 * `blendfunc GL_ONE GL_ZERO` — replace what is behind it, from the transparent
 * pass.
 *
 * Not the same as leaving a material opaque, and the difference is the whole
 * reason this exists. An opaque material draws in the opaque pass, BEFORE the
 * scene behind it is on screen; a surface that samples what is behind it — the
 * refractive water in `water.ts` — has to draw late, with depth testing on and
 * depth writing off, and then take the pixel over completely because it has
 * already done the compositing itself in the shader.
 *
 * `transparent = true` is what buys the late draw. The blend factors then undo
 * the blending that flag would otherwise imply.
 */
export function applyReplaceBlend(material: Material): void {
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = OneFactor;
  material.blendDst = ZeroFactor;
  material.transparent = true;
  material.depthWrite = false;
}
