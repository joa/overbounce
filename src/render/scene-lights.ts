/**
 * Real `THREE.PointLight`s, driven from the game's dynamic light list.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Stage 5 of `.agent/plans/LIGHTING.md`, and the reason the rest of it exists.
 * `dynamic-lights.ts` is Quake's dlight model reimplemented as eight uniform
 * slots composited into every material by hand — a small forward renderer,
 * written because a `MeshBasicNodeMaterial` cannot be lit any other way. It
 * works, and it has one limitation that no amount of tuning fixes:
 *
 *     material.colorNode = base.add(base.mul(contribution))
 *
 * is multiplicative in the surface's own colour, so a wall the lightmap left
 * BLACK stays black however bright the rocket flying past it is. A real light
 * adds to irradiance and can light what the lightmap did not.
 *
 * The game layer is unchanged: it still produces `DynamicLight[]` in Quake
 * space every frame, already culled to the nearest few. This module is the
 * other end of that pipe.
 *
 * ## Two things that are mappings, not ports
 *
 * **The falloff.** Quake's dlight is `1 - dist/radius`: linear, unitless, and
 * not any physical law. three's punctual lights are physical, and the project
 * owner asked for the game to look modern rather than 1:1 with 1999 — so this
 * keeps three's inverse-square `decay = 2` rather than flattening it to match
 * Quake. An inverse-square light falls off the way light actually does, which
 * is most of what makes a moving light read as a light.
 *
 * The price is that intensity is then in physical units, and at Quake's
 * ~1-unit-per-inch scale those are large. Brightness at distance `d` is
 * `intensity / d²`, so for a light to be at full strength halfway to its own
 * radius it needs `intensity = radius² / 4` — ten thousand for a 200-unit
 * rocket light. That is not a fudge factor, it is the arithmetic, and getting
 * it wrong is not subtle: the first version of this file used `intensity = 0.9`
 * and the light was invisible, exactly as `spike-lights.html` was invisible at
 * `intensity: 4`.
 *
 * **The pool.** Lights are recreated in the game layer every frame because
 * they are transient. `THREE.Light` objects are not: adding and removing them
 * from a scene changes the material's light configuration, which makes three
 * recompile every shader that uses them. So the pool is allocated once and
 * lights are *assigned* to slots, with unused slots parked at zero intensity.
 *
 * ## Which lights cast shadows
 *
 * A point-light shadow is six cube faces rendered per light per frame. Toggling
 * `castShadow` on a light has the same recompile cost as adding one, so the
 * casters are FIXED SLOTS: the first `shadowCasters` entries of the pool cast,
 * always, and the assignment step puts the nearest lights in them. The set of
 * casting lights changes; the set of casting slots never does.
 */

import { PointLight } from 'three/webgpu';
import type { Group } from 'three/webgpu';
import type { DynamicLight } from './dynamic-lights.js';

/**
 * How many real lights exist at once.
 *
 * Matches `MAX_DYNAMIC_LIGHTS` so the two paths cull identically and a
 * `?lit=off` comparison is not also a light-count comparison.
 */
export const MAX_SCENE_LIGHTS = 8;

/**
 * How many of them cast shadows, by default.
 *
 * One. A point-light shadow is six cube-map faces per frame, so this is the
 * single most expensive number in the renderer, and the honest default is the
 * smallest one that delivers the feature. `?shadowlights=` raises it, and the
 * right value comes from the `gpu` reading on the stats overlay rather than
 * from taste.
 */
export const DEFAULT_SHADOW_CASTERS = 1;

/**
 * Taste multiplier on top of the radius-derived intensity.
 *
 * 1 means "full brightness at half the light's radius", which is the reference
 * the arithmetic in the header is built around. This is the only number here
 * that is taste rather than derivation, and `?lightscale=` is the knob.
 */
export const DEFAULT_LIGHT_SCALE = 1;

/**
 * `intensity` for a Quake dlight of the given radius, under `decay = 2`.
 *
 * `radius² / 4` puts full brightness at `radius / 2`. Exported so a test can
 * assert the mapping without a GPU, because "the light is invisible" has now
 * been the failure mode twice and it is entirely an arithmetic error.
 */
export function intensityForRadius(radius: number, scale: number): number {
  return ((radius * radius) / 4) * scale;
}

export interface SceneLightOptions {
  /** How many pool slots cast shadows. */
  shadowCasters: number;
  /** Multiplier on every dynamic light's intensity. */
  scale: number;
  /** Shadow map edge length, per cube face. */
  shadowSize: number;
}

export const DEFAULT_SCENE_LIGHT_OPTIONS: Readonly<SceneLightOptions> = {
  shadowCasters: DEFAULT_SHADOW_CASTERS,
  scale: DEFAULT_LIGHT_SCALE,
  shadowSize: 512,
};

function num(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) {
    return fallback;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    console.warn(`[overbounce] ignoring ?${key}=${raw}: expected a number`);
    return fallback;
  }
  return v;
}

export function parseSceneLightOptions(
  search: string | URLSearchParams,
): SceneLightOptions {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  return {
    shadowCasters: Math.min(
      MAX_SCENE_LIGHTS,
      Math.max(0, Math.round(num(params, 'shadowlights', DEFAULT_SHADOW_CASTERS))),
    ),
    scale: Math.max(0, num(params, 'lightscale', DEFAULT_LIGHT_SCALE)),
    shadowSize: Math.max(64, Math.round(num(params, 'lightshadowsize', 512))),
  };
}

export interface SceneLights {
  /** The pool, for debugging. Already parented into the world group. */
  readonly lights: readonly PointLight[];
  /**
   * Point the pool at this frame's lights.
   *
   * `lights` is in QUAKE space, as everything the game layer emits is; the
   * conversion happens here, at the boundary, for the same reason
   * `DynamicLights.set` does it — comparing the two frames is what made the
   * hand-rolled dlights silently do nothing for weeks.
   */
  set(lights: readonly DynamicLight[]): void;
  dispose(): void;
}

/**
 * Build the pool.
 *
 * `world` is the scene's Q3-space group, so the lights are parented where
 * their positions can be written in Quake coordinates.
 */
export function createSceneLights(
  world: Group,
  options: SceneLightOptions = DEFAULT_SCENE_LIGHT_OPTIONS,
): SceneLights {
  const pool: PointLight[] = [];

  for (let i = 0; i < MAX_SCENE_LIGHTS; i++) {
    // `decay = 2` -- three's own inverse-square. See the header.
    const light = new PointLight(0xffffff, 0, 100, 2);
    light.name = `overbounce.dlight${i}`;
    // Fixed caster slots. See the header: toggling this per frame would
    // recompile every material that sees the light.
    light.castShadow = i < options.shadowCasters;
    if (light.castShadow) {
      light.shadow.mapSize.set(options.shadowSize, options.shadowSize);
      // A dlight lives for a few frames and moves fast, so a tight near plane
      // matters more than a long far one: the far plane is the light's own
      // radius, set per assignment below.
      light.shadow.camera.near = 4;
      light.shadow.bias = -0.0005;
      light.shadow.normalBias = 2;
    }
    world.add(light);
    pool.push(light);
  }

  return {
    lights: pool,

    set(lights: readonly DynamicLight[]): void {
      for (let i = 0; i < MAX_SCENE_LIGHTS; i++) {
        const light = pool[i];
        const source = lights[i];

        if (!source || source.radius <= 0) {
          // Parked. Intensity zero rather than `visible = false`, because
          // visibility is part of what three hashes into the light
          // configuration and flipping it would recompile.
          light.intensity = 0;
          continue;
        }

        /*
         * RAW Quake coordinates, NOT converted -- and this is the opposite of
         * what `DynamicLights.set` must do, which is worth stating because
         * getting it backwards produced a light that was simply somewhere else.
         *
         * `DynamicLights` holds uniforms compared against `positionWorld`,
         * which is in three space, so it has to convert. These are real
         * objects PARENTED TO THE WORLD GROUP, and that group already carries
         * the one `rotation.x = -PI/2` that reconciles Z-up with Y-up.
         * Converting here would apply the rotation twice. `shadow-map.ts`'s
         * directional light has always done it this way.
         */
        light.position.set(source.origin[0], source.origin[1], source.origin[2]);
        light.color.setRGB(source.color[0], source.color[1], source.color[2]);
        // Quake's radius is where the light reaches zero. three's `distance`
        // is a hard cutoff with a smooth window, which is close enough and has
        // the useful property of bounding the shadow frustum below.
        light.distance = source.radius;
        light.intensity = intensityForRadius(source.radius, options.scale);
        if (light.castShadow) {
          light.shadow.camera.far = source.radius;
          light.shadow.camera.updateProjectionMatrix();
        }
      }
    },

    dispose(): void {
      for (const light of pool) {
        world.remove(light);
        light.dispose();
      }
    },
  };
}
