/**
 * Water: the faithful fold, and the modern refraction on top of it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `lava.ts` is this file's sibling and the split is the same: classification
 * and the maths live here, where they are testable without a GPU; the wiring
 * lives in `bsp-mesh.ts`, where the textures and the material are.
 *
 * ## Faithful mode is not implemented here, and that is the point
 *
 * Quake's water is a stack of `blendFunc GL_dst_color GL_one` passes, and once
 * that blendfunc is classified correctly (`isBrightenStage` in `shader.ts`) the
 * ordinary compositor folds the whole shader into one filter-blended draw with
 * no special case for liquids at all. `?water=faithful` is therefore the
 * absence of everything below rather than a mode of its own. See
 * `.agent/plans/WATER.md`.
 *
 * That matters for fidelity: it means the faithful picture is produced by the
 * same code path as every other surface in the map, so it cannot drift away
 * from Quake independently of them.
 *
 * ## Modern mode
 *
 * **This is not Quake III.** Quake's water does not refract; light passes
 * through it in a straight line and the only motion is the two scrolling
 * textures. Refraction is a deliberate addition, on the same track as bloom and
 * the heat shimmer, and it is switchable for the same reason.
 *
 * It is built as *the faithful factor applied to a displaced sample of the
 * scene* rather than as a new water material:
 *
 *     modern = sceneBehind(screenUV + offset) * F        F = (1+s1)(1+s2)*lm
 *     faithful = sceneBehind(screenUV)          * F      (done by the blender)
 *
 * so the two modes differ in exactly one term. The water keeps its own colour,
 * its scrolling textures and its lightmap in both; what changes is *where* the
 * pixel behind it is read from. A separate "modern water material" would have
 * been a second thing to keep in sync with the first, and it would have thrown
 * away the shader's own art.
 *
 * ### The waves are anchored in the WORLD, not on the screen
 *
 * The obvious version drives the distortion from `screenUV`, and it looks
 * correct until the camera moves: the ripples stay nailed to the screen and the
 * water appears to slide underneath them. Driving them from world XY instead
 * costs nothing and makes the surface sit still while the player walks past it,
 * which is most of what sells it as a surface rather than as a filter.
 *
 * Q3 is roughly one unit per inch, so `WAVE_LENGTH` is in inches: 96 is an
 * eight-foot swell, which is about right for a pool the size of q3ctf2's.
 */

import { cos, float, sin, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Shader } from '../assets/shader.js';

/** Which water treatment to use. */
export type WaterMode = 'faithful' | 'modern';

/**
 * The default, and the project owner asked for the modern effects to be on.
 *
 * `?water=faithful` is the reference picture: no refraction, exactly the
 * composite Quake draws.
 */
export const DEFAULT_WATER_MODE: WaterMode = 'modern';

/**
 * Peak screen-space displacement of the refraction, in UV units.
 *
 * Small on purpose, and this is a speedrunning game rather than a tech demo:
 * the thing under the water is usually a floor the player is about to land on,
 * and a displacement large enough to be admired is large enough to move where
 * that floor appears to be. 0.012 is about eight pixels at 720p.
 */
export const REFRACTION_AMPLITUDE = 0.012;

/** Wavelength of the swell, in Quake units (~inches). */
export const WAVE_LENGTH = 96;

/** How fast the swell travels, in cycles per second. */
export const WAVE_SPEED = 0.35;

/**
 * How much a grazing view STRETCHES the refraction.
 *
 * The Fresnel term this replaced was wrong in a way worth recording, because
 * the mistake is easy to repeat: it brightened the surface toward `color.rgb`
 * at grazing angles, and `color.rgb` here is not a colour. It is the
 * multiplicative factor `F = (1+s1)(1+s2)*lm`, which routinely exceeds 1 —
 * mixing toward it blew the whole pool out to white. A screenshot of that is
 * `shots/water-modern.png` in the history of this change.
 *
 * Real Fresnel swings a water surface from nearly transparent looking straight
 * down to nearly mirrored at the horizon, and the mirrored half needs a
 * REFLECTION to show. That is a third render pass — a mirrored camera below the
 * surface, on top of the portal pass this renderer already runs one of — and it
 * is deliberately not done. Claiming Fresnel without it produces exactly the
 * category error above.
 *
 * What is left is the half that costs nothing and cannot blow out: light
 * entering at a shallow angle travels further through the disturbed surface, so
 * the displacement it picks up is larger. `1 + REFRACTION_STRETCH` is the
 * multiplier at full grazing. 0 makes the refraction view-independent.
 *
 * A note on the "grazing" it measures, because the first version mixed
 * coordinate spaces: the facing term is `normalView . positionViewDirection`,
 * BOTH in view space. It used to dot `normalWorld` against the view-space
 * direction. For a horizontal pool seen by a LEVEL camera the two normals
 * coincide -- world up is view up -- so the old number happened to be about
 * right; it drifts as the camera pitches (12° down, and the true view normal
 * is `(0, 0.98, 0.21)`), and it is wrong outright for a vertical water face.
 *
 * 0.5 rather than the physical value, and the reason is worth writing down
 * because it argues against the physics: this is a SCREEN-SPACE refraction, and
 * a grazing view is exactly the case where a displaced sample is most likely to
 * land on something that is not behind the water at all. At 1.5 the far end of
 * q3ctf2's pool broke into chaotic black bands -- geometry from above the
 * waterline, dragged down into it. The physical argument is real; it just loses
 * to the sampling artefact it makes worse.
 */
export const REFRACTION_STRETCH = 0.5;

export interface WaterOptions {
  mode: WaterMode;
  /** Peak refraction displacement in screen UV units. 0 leaves the sample put. */
  refraction: number;
  /** How much a grazing view stretches the refraction. 0 removes it. */
  stretch: number;
}

export const DEFAULT_WATER_OPTIONS: Readonly<WaterOptions> = {
  mode: DEFAULT_WATER_MODE,
  refraction: REFRACTION_AMPLITUDE,
  stretch: REFRACTION_STRETCH,
};

/**
 * `?water=`, `?waterrefract=`, `?waterstretch=`.
 *
 * Separate knobs rather than one strength, because they failed separately: the
 * first version of this had a working refraction and a view-dependent term that
 * blew the surface out to white, and with a single knob there is no way to tell
 * those two apart from a screenshot. Two knobs turned a puzzling picture into a
 * two-command bisection.
 */
export function parseWaterOptions(params: URLSearchParams): WaterOptions {
  const num = (key: string, fallback: number): number => {
    const raw = params.get(key);
    if (raw === null) {
      return fallback;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      console.warn(`[overbounce] ignoring ?${key}=${raw}: expected a number >= 0`);
      return fallback;
    }
    return n;
  };

  return {
    mode: parseWaterMode(params),
    refraction: num('waterrefract', REFRACTION_AMPLITUDE),
    stretch: num('waterstretch', REFRACTION_STRETCH),
  };
}

/** `?water=`. Anything unrecognised falls back to the default, loudly. */
export function parseWaterMode(params: URLSearchParams): WaterMode {
  const raw = params.get('water');
  if (raw === null) {
    return DEFAULT_WATER_MODE;
  }
  if (raw === 'faithful' || raw === 'modern') {
    return raw;
  }
  console.warn(`[overbounce] ignoring ?water=${raw}: expected faithful or modern`);
  return DEFAULT_WATER_MODE;
}

/**
 * Is this shader water?
 *
 * `surfaceparm water`, and the texture name is not an acceptable substitute for
 * the same reason `isLavaShader` gives: `liquid.shader` alone spells it
 * `clear_calm1`, `clear_ripple1`, `xripplewater2`, `bloodwater`, `jello` and
 * `mercury`, and `textures/liquids/` also holds every lava and slime shader in
 * the game.
 *
 * Note this is a RENDERING question and is not the same as the physics one.
 * `CONTENTS_WATER` comes from the brush and decides whether the player swims;
 * this decides how a surface draws. A map can and does have one without the
 * other -- an out-of-reach decorative pool has no content flags at all.
 */
export function isWaterShader(shader: Shader | null): boolean {
  return shader?.surfaceparms.has('water') ?? false;
}

/**
 * The screen-space offset to add before sampling what is behind the water.
 *
 * Two crossed waves at different wavelengths, driven by WORLD position so the
 * ripples stay with the water rather than with the camera. `worldXy` is Quake's
 * X and Y at this fragment; the vertical axis is deliberately not involved,
 * because a water surface is horizontal and its swell runs across it.
 *
 * The crossing matters: a single wave makes every pixel on a horizontal edge
 * move together, which reads as the whole image sliding rather than as a
 * rippling surface.
 */
export function refractionOffset(
  worldXy: Node<'vec2'>,
  timeSeconds: Node<'float'>,
  amplitude: number = REFRACTION_AMPLITUDE,
): Node<'vec2'> {
  const k = float(2 * Math.PI / WAVE_LENGTH);
  const t = timeSeconds.mul(WAVE_SPEED * 2 * Math.PI);

  // x is driven by world Y and vice versa, so the two waves are not parallel.
  const dx = sin(worldXy.y.mul(k).add(t));
  const dy = cos(worldXy.x.mul(k.mul(0.73)).sub(t.mul(0.8)));

  return vec2(dx, dy).mul(amplitude);
}
