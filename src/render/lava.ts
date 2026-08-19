/**
 * Lava: bloom and heat shimmer.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * **Neither of these is Quake III.** Quake has no bloom and no refractive
 * distortion; its lava is a scrolling texture and nothing more. This is item B5
 * of `.agent/plans/VISUALS.md`, which is the deliberate-additions track, and it
 * must stay switchable for the reason recorded there: this is a speedrunning
 * game, and anything that blooms into a doorway or wobbles a ledge edge costs
 * the player information they navigate by.
 *
 * Lava is the right target for it, though, and worth saying why. It is
 * *emissive* — a light source in the fiction — so bloom and a heat haze are the
 * two effects that make it read as hot rather than as an orange floor. Water
 * wants the opposite treatment (refraction and reflection), which is why B5
 * covers both liquids separately rather than as one "liquid material".
 *
 * WHAT LIVES HERE, AND WHAT DOES NOT
 *
 * This module owns classification and the shimmer maths — the parts that are
 * self-contained and testable without a GPU. The wiring lives where it belongs:
 *
 *   - `bsp-mesh.ts` collects lava meshes into `WorldSurfaces.lava`;
 *   - `main.ts` hands that list to `post.markLava`;
 *   - `post.ts` writes a second MRT attachment from it, and reads it back for
 *     the bloom and the heat haze.
 *
 * A SECOND attachment, not another channel of the SSAO g-buffer, and the reason
 * is worth keeping: the g-buffer exists only when SSAO is on, its alpha is
 * already the AO world mask, and `?lavabloom` has to work under `?ssao=off`.
 *
 * WHERE EACH STAGE SITS IN THE CHAIN, and why:
 *
 *   shimmer   FIRST, before AO. It is a resample of the scene at a displaced
 *             coordinate, so it has to run while the colour is still a texture
 *             that can be sampled somewhere other than at this fragment. One
 *             stage later it is an expression.
 *   bloom     After AO, before the tone curve — in LINEAR. Bloom is light
 *             scattering in a lens, which happens to radiance, not to the
 *             display values a curve produces. Bloom after tone mapping is the
 *             classic way to get a milky picture that never quite goes bright.
 *
 * `threshold` on the bloom is 0, because the MASK does the thresholding: the
 * input is the scene colour multiplied by the lava mask, so lava is the only
 * thing that can bloom. A luminance threshold would also catch every lamp,
 * every rocket and the sky.
 *
 * Cost at the defaults, q3dm7 at -3,-560,-300 looking at the big pool, 1280x720:
 * 169 draws -> 183, and the GPU time did not resolve above run-to-run noise
 * (1.97ms against 1.83ms, in the wrong direction). That is not a claim that it
 * is free — it is a statement that this measurement cannot see it.
 */

import { float, sin, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Shader } from '../assets/shader.js';

/**
 * Is this shader lava?
 *
 * `surfaceparm lava` is the reliable signal and the only one worth using. The
 * texture name is not: the rotation alone carries `flatlavahell_1500`,
 * `lavahelldark`, `lavahell_1000` and `protolava`, and a name match would both
 * miss custom maps and catch `textures/gothic_wall/oct20clava`, which is a WALL
 * with lava in its name.
 */
export function isLavaShader(shader: Shader | null): boolean {
  return shader?.surfaceparms.has('lava') ?? false;
}

/** The same, for water. B5's other half wants refraction rather than bloom. */
export function isWaterShader(shader: Shader | null): boolean {
  return shader?.surfaceparms.has('water') ?? false;
}

/** And slime, which Quake treats as its own content type. */
export function isSlimeShader(shader: Shader | null): boolean {
  return shader?.surfaceparms.has('slime') ?? false;
}

/**
 * How hard lava blooms, 0..1.
 *
 * Deliberately modest. Lava is often a floor the player has to judge a jump
 * across, and a bloom that spills over its own edge moves where that edge
 * appears to be. Err low; `?lavabloom=` can raise it.
 */
export const LAVA_BLOOM_STRENGTH = 0.35;

/**
 * How far the bloom spreads, in fractions of screen height.
 *
 * Small, for the same reason. A wide radius turns a lava pit into a glow that
 * washes over the platforms beside it.
 */
export const LAVA_BLOOM_RADIUS = 0.12;

/** Peak screen-space displacement of the heat haze, in UV units. */
export const SHIMMER_AMPLITUDE = 0.0025;

/** How fast the haze rolls, in cycles per second. */
export const SHIMMER_SPEED = 0.6;

/** Spatial frequency of the haze, in cycles across the screen. */
export const SHIMMER_FREQUENCY = 14;

/**
 * The heat-haze offset to add to a screen UV, before sampling the scene.
 *
 * Two sine waves at different frequencies and speeds, crossed so the pattern
 * does not read as a moving grid. Real heat distortion is turbulent and this is
 * not; what it has to be is *plausible and cheap*, because it runs per fragment
 * over whatever part of the screen the mask allows.
 *
 * The vertical term is deliberately stronger than the horizontal one: hot air
 * rises, so the distortion should look like it is travelling upward rather than
 * sloshing sideways.
 *
 * `mask` is how much haze applies here, 0..1 — normally a blurred lava mask, so
 * the effect fades out with distance above the surface instead of stopping at a
 * hard line.
 */
export function shimmerOffset(
  uv: Node<'vec2'>,
  timeSeconds: Node<'float'>,
  mask: Node<'float'>,
  amplitude: number = SHIMMER_AMPLITUDE,
): Node<'vec2'> {
  const f = float(SHIMMER_FREQUENCY);
  const t = timeSeconds.mul(SHIMMER_SPEED);

  // Cross the axes: x wobbles with the vertical coordinate and vice versa, so
  // neighbouring pixels on a horizontal edge do not all move together.
  const dx = sin(uv.y.mul(f).add(t.mul(2.1))).mul(0.6);
  const dy = sin(uv.x.mul(f.mul(0.8)).sub(t.mul(1.7))).mul(1.0);

  return vec2(dx, dy).mul(amplitude).mul(mask);
}
