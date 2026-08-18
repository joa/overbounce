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
 * self-contained and testable without a GPU. It deliberately does NOT own the
 * wiring, because both integration points live in files that had other owners
 * when this was written:
 *
 *   - `bsp-mesh.ts` must tag lava materials so the post chain can find them.
 *   - `post.ts` must consume that tag to bloom and to distort.
 *
 * See `.agent/plans/VISUALS.md` B5 for the two calls that are needed.
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
