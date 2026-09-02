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
 *     faithful = sceneBehind(screenUV) * F                F = (1+s1)(1+s2)*lm
 *     refracted = sceneBehind(screenUV + offset) * F      (the same F)
 *     modern = mix(refracted,
 *                  reflection(flipX(screenUV) + offset),
 *                  fresnel)
 *
 * so refraction alone differs from faithful in exactly one term: where the
 * pixel behind the water is read from. The water keeps its own colour, its
 * scrolling textures and its lightmap in both; a separate "modern water
 * material" would have been a second thing to keep in sync with the first, and
 * it would have thrown away the shader's own art.
 *
 * The reflection is the third render pass `REFRACTION_STRETCH` below used to
 * say was deliberately not done. `water-reflection.ts` renders it -- a mirrored
 * copy of the render camera below the surface, clipped at the surface -- and
 * `fresnelWeight` here decides how much of it shows.
 *
 * The reflection is NOT multiplied by `F`, and that is physics rather than
 * taste: Fresnel splits the light at the surface, and only the transmitted
 * part -- what the refraction samples -- passes through the water and picks up
 * its colour and its lightmap. The reflected part never enters. It also
 * decides whether dark water reflects at all: q3dm2's `calm_poollight` is a
 * stack of `GL_dst_color GL_zero` stages whose `F` is well under 1, and a
 * reflection attenuated by it was invisible in a screenshot -- the dark pool
 * mirroring the lit hall above it is exactly the picture this is for.
 *
 * Note what did NOT change: `F` still multiplies a scene sample and is never
 * itself a colour. That is the rule the failed first attempt at Fresnel
 * (below) established.
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
 * `?waterdebug=` -- draw one term of the modern water alone.
 *
 * `reflection` is the raw mirrored sample at full weight and without `F`;
 * `fresnel` is the weight as grey; `facing` is the cosine the weight is built
 * from, also as grey (white looking straight down, black at the horizon).
 *
 * The same idea as `?portaldebug=view`: a water surface is three samples and
 * a weight folded into one pixel, and when the picture is wrong there is no
 * way to tell from it whether the PASS is wrong or the MIX is burying it. It
 * earned its keep on the first run -- see `.agent/plans/WATER.md` on q3dm2.
 *
 * READ THE GREYS WITH A PIXEL PROBE, NOT BY EYE. A 0.35 weight through the
 * post chain's exposure and AgX comes out around sRGB 190 -- a light band
 * against a dark map that reads as "white, so the weight is 1" in a
 * screenshot viewer. It was misread exactly that way once, and the number
 * was right all along. `?post=off` gives the raw encode.
 */
export type WaterDebug = 'off' | 'reflection' | 'fresnel' | 'facing';

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
 * REFLECTION to show. Until 2026-09-02 that third render pass was deliberately
 * not done and the term stayed out for exactly that reason: claiming Fresnel
 * without a reflection produces the category error above. The pass exists now
 * (`water-reflection.ts`) and the weight is `fresnelWeight` below.
 *
 * This one is the half that costs nothing and cannot blow out: light entering
 * at a shallow angle travels further through the disturbed surface, so the
 * displacement it picks up is larger. `1 + REFRACTION_STRETCH` is the
 * multiplier at full grazing. 0 makes the refraction view-independent.
 *
 * A note on the "grazing" it measures, because the first version mixed
 * coordinate spaces: the facing term is `normalView . positionViewDirection`,
 * BOTH in view space. It used to dot `normalWorld` against the view-space
 * direction. For a horizontal pool seen by a LEVEL camera the two normals
 * coincide -- world up is view up -- so the old number happened to be about
 * right; it drifts as the camera pitches (12° down, and the true view normal
 * is `(0, 0.98, 0.21)`), and it is wrong outright for q3dm2's vertical water
 * face. The Fresnel weight is built on the same dot and needs it exact.
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

/**
 * Water's reflectance at normal incidence, for Schlick's approximation.
 *
 * `((n1 - n2) / (n1 + n2))^2` with air 1.0 and water 1.33 is 0.02: looking
 * straight down into a pool, two percent of what you see is the sky. The rest
 * of the curve rises with `(1 - cos)^5`, which is what makes a pool a mirror
 * toward the horizon and glass underfoot.
 */
export const WATER_F0 = 0.02;

/**
 * Multiplier on the Fresnel weight, and the switch for the whole reflection.
 *
 * 1 is the physical curve. Not defaulted below it, the way `REFRACTION_STRETCH`
 * is, because the argument against the physics there -- a displaced sample
 * that lands on something not behind the water -- does not apply: the
 * reflection comes from its own render pass and is a correct image of what is
 * above the surface wherever it is sampled. What is worth knowing is how much
 * the side camera sees of it: the default pose sits 110 above and 520 out from
 * the player, ~12 degrees off grazing for a pool at the player's feet, and
 * Schlick gives ~0.35 there. `?waterreflect=0.5` halves that; `0` removes the
 * pass entirely rather than merely weighting it to nothing, so it costs
 * nothing either.
 */
export const REFLECTION_STRENGTH = 1;

/**
 * A floor under the Fresnel curve, and this one IS a departure from the
 * physics, so here is the argument.
 *
 * Schlick gives water two percent looking straight down. In a photograph that
 * two percent still reads, because the sky and the lamps are hundreds of
 * times brighter than the pool floor; in this scene nothing is, the content
 * is display-referred and a lamp is at most a few times the floor. So two
 * percent of a lit hall on a dark pool is nothing at all, and the first thing
 * reported after play was that the reflection was "not shown until the angle
 * works" -- which, once a real bug behind it was fixed (`.agent/plans/WATER.md`),
 * was the physics being invisible. The second report was that the player
 * must be in the reflection: they were, at two percent, looking down at their
 * own feet in first person.
 *
 * The weight is `floor + (1 - floor) * schlick`, so the curve keeps its
 * shape and still runs to a full mirror at the horizon; it just starts at
 * `floor` instead of at `F0`. 0.2 is where a pool seen from above shows the
 * room in it without hiding its own floor -- the thing under the water is
 * usually a floor the player is about to land on, the same argument
 * `REFRACTION_AMPLITUDE` makes. `?waterreflectmin=0` is the physical curve.
 */
export const REFLECTION_FLOOR = 0.2;

/**
 * The reflection target's size as a fraction of the drawing buffer.
 *
 * Not a fixed 512 square like the portal's: a portal is a small quad, a pool
 * can be most of the screen. Half resolution in each axis is a quarter of the
 * pixels, and the surface's own ripple displacement hides the difference. The
 * pass also draws the whole world again, so this is the knob for the cost.
 */
export const REFLECTION_RESOLUTION = 0.5;

export interface WaterOptions {
  mode: WaterMode;
  /** Peak refraction displacement in screen UV units. 0 leaves the sample put. */
  refraction: number;
  /** How much a grazing view stretches the refraction. 0 removes it. */
  stretch: number;
  /** Multiplier on the Fresnel reflection weight. 0 disables the pass. */
  reflection: number;
  /** Floor under the Fresnel weight, in [0, 1]. 0 is the physical curve. */
  reflectionFloor: number;
  /** Reflection target size as a fraction of the drawing buffer, in (0, 1]. */
  reflectionScale: number;
  /** `?waterdebug=`. `off` is the real picture. */
  debug: WaterDebug;
}

export const DEFAULT_WATER_OPTIONS: Readonly<WaterOptions> = {
  mode: DEFAULT_WATER_MODE,
  refraction: REFRACTION_AMPLITUDE,
  stretch: REFRACTION_STRETCH,
  reflection: REFLECTION_STRENGTH,
  reflectionFloor: REFLECTION_FLOOR,
  reflectionScale: REFLECTION_RESOLUTION,
  debug: 'off',
};

/**
 * `?water=`, `?waterrefract=`, `?waterstretch=`, `?waterreflect=`,
 * `?waterreflectmin=`, `?waterreflectres=`.
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

  // A zero-sized target is not a resolution, and a target larger than the
  // screen is a cost with nothing to show for it.
  const res = num('waterreflectres', REFLECTION_RESOLUTION);
  const reflectionScale = res > 0 && res <= 1 ? res : REFLECTION_RESOLUTION;
  if (reflectionScale !== res) {
    console.warn(`[overbounce] ignoring ?waterreflectres=${res}: expected 0 < n <= 1`);
  }

  return {
    mode: parseWaterMode(params),
    refraction: num('waterrefract', REFRACTION_AMPLITUDE),
    stretch: num('waterstretch', REFRACTION_STRETCH),
    reflection: num('waterreflect', REFLECTION_STRENGTH),
    // Above 1 the water would be a mirror from every angle, which is a
    // different effect; clamped rather than rejected because 1 itself is a
    // legitimate "show me the pass" setting.
    reflectionFloor: Math.min(1, num('waterreflectmin', REFLECTION_FLOOR)),
    reflectionScale,
    debug: parseWaterDebug(params),
  };
}

/** `?waterdebug=`. Anything unrecognised is `off`, loudly. */
export function parseWaterDebug(params: URLSearchParams): WaterDebug {
  const raw = params.get('waterdebug');
  if (raw === null || raw === 'off') {
    return 'off';
  }
  if (raw === 'reflection' || raw === 'fresnel' || raw === 'facing') {
    return raw;
  }
  console.warn(`[overbounce] ignoring ?waterdebug=${raw}: expected reflection, fresnel or facing`);
  return 'off';
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

/**
 * How much of the reflection shows at this fragment: Schlick's approximation
 * lifted onto a floor, scaled by `strength`, and clamped so a strength above
 * 1 cannot push the mix past the reflection.
 *
 *     R = F0 + (1 - F0) * (1 - cos)^5
 *     w = floor + (1 - floor) * R
 *
 * `facing` is the cosine between the surface normal and the direction to the
 * eye, in [0, 1] -- see the note on coordinate spaces above
 * `REFRACTION_STRETCH` for what it must NOT be computed from. `floor` is
 * `REFLECTION_FLOOR`, and the argument for it is there.
 *
 * `strength` is a plain multiplier and nothing cleverer, on purpose. A cap on
 * the weight was considered (so a grazing view could never become a full
 * mirror and hide the pool floor) and rejected: the side camera's angle puts
 * the default at ~0.5 and a cap would either never trigger or flatten the
 * curve exactly where it is doing its job. If a map turns out to need one,
 * that is a per-map camera-script question, not a global.
 */
export function fresnelWeight(
  facing: Node<'float'>,
  strength: number = REFLECTION_STRENGTH,
  floor: number = REFLECTION_FLOOR,
  f0: number = WATER_F0,
): Node<'float'> {
  const grazing = facing.oneMinus().clamp(0, 1);
  const schlick = grazing.pow(5).mul(1 - f0).add(f0);
  const lifted = schlick.mul(1 - floor).add(floor);
  return lifted.mul(strength).clamp(0, 1);
}
