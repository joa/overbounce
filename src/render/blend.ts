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
 *
 * SECOND TRAP, same function, and the one that actually blacked out the burn
 * marks: `_getBlending`'s `CustomBlending` branch defaults `blendSrcAlpha`/
 * `blendDstAlpha` to `blendSrc`/`blendDst` (the COLOR factors) whenever they
 * are left at Material's own default of `null`. Quake's blendfuncs are written
 * for RGB only -- id never thought about the alpha channel of an OpenGL
 * default framebuffer with no alpha to speak of -- so every function below
 * used to leave `blendSrcAlpha`/`blendDstAlpha` unset, and the alpha channel
 * silently inherited whatever COLOR factor happened to be in `blendSrc`/
 * `blendDst`. For `applyDarkenBlend` that COLOR factor is
 * `OneMinusSrcColorFactor` on the destination side -- meaningless applied to
 * alpha, but not harmless: `burn_med_mrk`/`hole_lg_mrk` are fully OPAQUE
 * textures (alpha 255 everywhere, including their black "background" -- the
 * masking is done entirely through RGB, not alpha), so `1 - srcAlpha`
 * evaluates to ~0 across the ENTIRE quad. `renderer.ts` never passes
 * `alpha: false` to `WebGPURenderer`, so the canvas is `alphaMode:
 * "premultiplied"` -- and a stored pixel with correct RGB but alpha ~0
 * composites to solid black on screen, uniformly, with no trace of the
 * texture's own crackle detail. That is the "100% black slab" bug: reproduced
 * in an isolated render (synthetic floor, one mark, no gameplay noise) once
 * the diagnostic there also inspected `blendSrcAlpha`/`blendDstAlpha` instead
 * of stopping at `blendSrc`/`blendDst` looking correct.
 *
 * The fix is the same shape everywhere it applies: SET `blendSrcAlpha`/
 * `blendDstAlpha` explicitly rather than let them fall through to a COLOR
 * factor. None of Quake's blendfuncs describe an alpha operation, and the
 * semantically right one is always "leave the destination's own opacity
 * alone" -- `Zero`/`One`, i.e. `outputAlpha = dst.a`. A decal darkening or
 * multiplying a wall does not make that wall transparent, whatever its own
 * texture's alpha channel says.
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
  // Explicit, not left to fall through to `blendSrc`/`blendDst` (`DstColorFactor`
  // is meaningless applied to alpha) -- see the file header's "second trap".
  // `Zero`/`One` leaves the destination's own opacity untouched.
  material.blendSrcAlpha = ZeroFactor;
  material.blendDstAlpha = OneFactor;
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
  // Explicit, not left to fall through to `blendSrc`/`blendDst` -- see the
  // file header's "second trap". Without this, alpha inherits
  // `OneMinusSrcColorFactor` on the destination side, and a fully-opaque
  // source texture (burn_med_mrk/hole_lg_mrk have no real alpha channel --
  // the masking is entirely in RGB) collapses output alpha to ~0 across the
  // whole quad. `renderer.ts` never passes `alpha: false`, so the canvas
  // composites as premultiplied and that near-zero alpha turned the mark
  // into a solid black slab, independent of anything the texture's RGB says.
  // `Zero`/`One` leaves the destination's own opacity untouched instead.
  material.blendSrcAlpha = ZeroFactor;
  material.blendDstAlpha = OneFactor;
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
