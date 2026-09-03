/**
 * The level's own lamps and torches, as real lights.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `.agent/plans/MAP-LIGHTS.md`. Every Quake map ships the list already: q3map2
 * read `light` entities and `q3map_surfaceLight` surfaces to bake the lightmap,
 * and both survive in the BSP. q3dm6 has 113 light entities and q3dm7 has 301.
 *
 * ## The hazard, and what this is therefore for
 *
 * **The lightmap already contains all of them, baked**, and it cannot be
 * un-baked. Adding them at full strength double-counts the whole map. So these
 * run at a modest scale and are not trying to relight the level — what they add
 * is response to PROXIMITY (a lamp brightens as you walk under it, which a
 * baked texture cannot do) and, for the flames, a FLICKER.
 *
 * The flicker is the part that is genuinely impossible to bake: a light that
 * varies over time is not a lightmap, by construction. It modulates around the
 * baked contribution rather than replacing it, which is exactly right.
 *
 * ## Spotlights, and why they get the shadows
 *
 * A Q3 `light` with a `target` is a spotlight aimed at the targeted entity's
 * origin — `radius` (default 64) is the cone radius AT THE TARGET, so the cone
 * half-angle is `atan(radius / distance)`. A third of these lights are
 * spotlights: 32 of q3dm6's 113 and 57 of q3dm7's 301, and they are the wall
 * lamps.
 *
 * That is lucky, because point lights cannot cast here. A casting `PointLight`
 * in three r0.185 blackens every fragment outside its own radius (see
 * `.agent/plans/LIGHTING.md`), which took point shadows out of the game. A
 * `SpotLight` uses a single 2D shadow map — the same path as the grid-steered
 * directional light that has always worked — and `spike-lights.html` confirms
 * it: a casting spot over a 512-unit floor leaves everything outside its cone
 * fully lit while the box inside it casts cleanly.
 */

import { PointLight, SpotLight } from 'three/webgpu';
import type { Group } from 'three/webgpu';
import type { EntityDict } from '../collision/cm-load.js';
import type { BspFile } from '../collision/bsp.js';
import { shaderKey } from '../assets/shader.js';
import type { Shader } from '../assets/shader.js';
import { isLightsOnly } from './light-debug.js';

/** `light` with no `light` key. `SP_light` in Quake, 300 in q3map2. */
export const DEFAULT_LIGHT = 300;

/** `radius` with no key — the spot cone radius at the target. */
export const DEFAULT_SPOT_RADIUS = 64;

/**
 * The `light` value a map's MEDIAN lamp is treated as having.
 *
 * 35, which is q3dm6's median — the map `reach`'s constant was fitted to. See
 * `medianLight` for why a second, relative scale is needed at all.
 */
export const REFERENCE_LIGHT = 35;

/**
 * The map's median `light` value, which is the only honest zero point.
 *
 * **A Quake map's `light` key has no absolute scale.** It is a q3map2 input
 * that gets multiplied by compile-time switches (`-pointscale` and friends)
 * nobody records in the BSP, so what counts as "a bright lamp" is a decision
 * each mapper made independently. Measured over the maps here:
 *
 *     map            n    p10    p50    p90
 *     q3dm4         55     35    500   4500
 *     de4th_run1    51     50    100    200
 *     q3dm17        45     10     75    750
 *     q3dm6        113     20     35    150
 *     q3dm7        301      5     20    200
 *     q3dm2         79      5     10    125
 *     q3ctf2       983      3      5     15
 *
 * A factor of ONE HUNDRED between q3dm4's median and q3ctf2's, for lamps that
 * look about equally bright in the two maps. `reach` was fitted to q3dm6, so
 * on q3ctf2 it produced `sqrt(5) * 17 = 38`, clamped up to the 64-unit floor
 * — a bubble smaller than a player is tall, for 83% of the lights in the map.
 * The nearest one to a q3ctf2 spawn is 152 units away, so the pool would
 * faithfully pick the four nearest lights and every one of them contributed
 * exactly nothing. That is the whole of "I see no shadows at all" on a CTF
 * map, and it is not a shadow bug.
 */
export function medianLight(lights: readonly number[]): number {
  if (lights.length === 0) {
    return REFERENCE_LIGHT;
  }
  const sorted = [...lights].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const value =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return value > 0 ? value : REFERENCE_LIGHT;
}

/**
 * How far a light reaches, from its `light` key and the map's own median.
 *
 * Two models, and the larger wins:
 *
 *  - **Absolute**, `sqrt(intensity) * 17`, the original. It reads the `light`
 *    key at face value and is right on a map whose numbers are on q3dm6's
 *    scale or above.
 *  - **Relative**, the same curve applied to `intensity / median * 35`, which
 *    asks "how bright is this lamp FOR THIS MAP" and gives the median lamp of
 *    every map the same 100-unit reach.
 *
 * `Math.max` rather than a switch between them, because it is the property
 * that matters: the relative model can only ever LIFT a map whose numbers are
 * small, never shrink one whose numbers are large. q3dm4's median of 500
 * keeps its 380-unit reach (absolute wins); q3ctf2's median of 5 goes from
 * the 64-unit floor to 100 (relative wins). On q3dm6 the two agree by
 * construction, since 35 is where the constant was fitted.
 */
export function reachFor(intensity: number, median: number): number {
  const absolute = Math.sqrt(intensity) * 17;
  const relative = Math.sqrt((intensity / median) * REFERENCE_LIGHT) * 17;
  return Math.max(64, absolute, relative);
}

/**
 * How far a light may be from a flame surface and still count as a torch.
 *
 * A wall torch's light entity sits just off the flame, not inside it. 96 units
 * is about a player's height and comfortably covers that without reaching the
 * next fixture along a wall.
 */
export const TORCH_RADIUS = 96;

/**
 * Where an unused CASTING slot is sent. `MAX_WORLD_COORD` is 64k, so this is
 * well outside every map. Same value and same reason as `scene-lights.ts`.
 */
const PARKED_AT = 1e6;

/**
 * A `light` entity, resolved.
 *
 * `intensity` here is Quake's raw `light` key and is NOT a three intensity —
 * see `intensityFor`, which is a mapping rather than a port.
 */
export interface MapLight {
  origin: [number, number, number];
  color: [number, number, number];
  /** Quake's `light` key. */
  intensity: number;
  /** How far it reaches, derived from `intensity` when the map gives no radius. */
  reach: number;
  /**
   * Cone direction and half-angle, for a light with a `target`. Null for a
   * plain point light.
   */
  spot: { direction: [number, number, number]; angle: number } | null;
  /**
   * Near an animated emissive surface — a flame. Heuristic; see the header of
   * `.agent/plans/MAP-LIGHTS.md`, and note Quake itself does not flicker these.
   */
  torch: boolean;
}

function vec(raw: string | undefined): [number, number, number] | null {
  if (!raw) {
    return null;
  }
  const p = raw.trim().split(/\s+/).map(Number);
  return p.length >= 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : null;
}

/**
 * Which surfaces are FLAMES: emissive and animated.
 *
 * `q3map_surfaceLight` alone is every lamp panel in the map, most of which are
 * steady. An `animMap` on top of it is what separates a flickering flame from a
 * fluorescent tube — Q3 builds its fires as multi-frame animMap shaders.
 */
export function isFlameShader(shader: Shader | null | undefined): boolean {
  if (!shader || shader.surfaceLight === null) {
    return false;
  }
  return shader.stages.some((stage) => stage.animFrames.length > 1);
}

/**
 * Where the map's flames are: the centroid of every animated emissive surface.
 *
 * One point per surface rather than per shader, because a map has many torches
 * sharing one flame shader and the whole question is which LIGHT is near which
 * FLAME. Centroids are cheap and good enough — a flame surface is a couple of
 * feet across and `TORCH_RADIUS` is 96 units.
 */
export function flameSurfaceCentroids(
  bsp: BspFile,
  shaders: ReadonlyMap<string, Shader>,
): [number, number, number][] {
  const out: [number, number, number][] = [];
  /** Which shader indices are flames, resolved once rather than per surface. */
  const flame = new Set<number>();
  for (let i = 0; i < bsp.shaders.length; i++) {
    if (isFlameShader(shaders.get(shaderKey(bsp.shaders[i].shader)))) {
      flame.add(i);
    }
  }
  if (flame.size === 0) {
    return out;
  }

  for (const surface of bsp.surfaces) {
    if (!flame.has(surface.shaderNum) || surface.numVerts <= 0) {
      continue;
    }
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < surface.numVerts; k++) {
      const b = (surface.firstVert + k) * 3;
      x += bsp.drawVerts[b];
      y += bsp.drawVerts[b + 1];
      z += bsp.drawVerts[b + 2];
    }
    out.push([x / surface.numVerts, y / surface.numVerts, z / surface.numVerts]);
  }

  return out;
}

/**
 * Quake's `light` key to a three intensity, under inverse-square decay.
 *
 * A MAPPING, not a port. q3map2's falloff is its own thing and fed an offline
 * bake; reconstructing it from recall would be inventing. This keeps the same
 * shape `scene-lights.ts` uses — brightness `intensity / d²`, so full strength
 * at half the reach — and scales the whole thing down, because the lightmap
 * already contains this light and the point here is a highlight rather than a
 * second bake.
 */
export function intensityFor(light: MapLight, scale: number): number {
  return ((light.reach * light.reach) / 4) * scale;
}

/**
 * Read every `light` entity out of the map.
 *
 * `flamePoints` are the centroids of animated emissive surfaces, which is how a
 * torch is told from a lamp. Pass an empty list and nothing is a torch, which
 * is the honest result for a map with no open flames.
 */
export function parseMapLights(
  entities: readonly EntityDict[],
  flamePoints: readonly (readonly [number, number, number])[] = [],
): MapLight[] {
  /** `targetname` -> origin, for resolving a spotlight's aim. */
  const targets = new Map<string, [number, number, number]>();
  for (const e of entities) {
    const name = e['targetname'];
    const origin = vec(e['origin']);
    if (name && origin) {
      targets.set(name.toLowerCase(), origin);
    }
  }

  const out: MapLight[] = [];

  /*
   * The map's own median `light`, over one pass before the real one. See
   * `medianLight`: without it a map that writes small numbers gets lights
   * that reach nothing at all.
   */
  const median = medianLight(
    entities
      .filter((e) => e['classname'] === 'light' && e['origin'])
      .map((e) => {
        const v = Number.parseFloat(e['light'] ?? '');
        return Number.isFinite(v) && v > 0 ? v : DEFAULT_LIGHT;
      }),
  );

  for (const e of entities) {
    if (e['classname'] !== 'light') {
      continue;
    }
    const origin = vec(e['origin']);
    if (!origin) {
      continue;
    }

    const raw = Number.parseFloat(e['light'] ?? '');
    const intensity = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIGHT;
    const color = vec(e['_color']) ?? [1, 1, 1];

    /*
     * Reach from intensity, relative to what this map calls bright. q3map2's
     * default falloff makes a light's useful range grow with the square root
     * of its brightness; `reachFor` is that shape, run twice -- once on the
     * raw key and once normalised by the map's median -- with the larger
     * winning. A map that states `radius` is believed instead, but note
     * `radius` on a SPOT means the cone size at the target rather than the
     * reach, so it is only used here for a plain light.
     */
    const stated = Number.parseFloat(e['radius'] ?? '');
    const spotTarget = e['target'] ? targets.get(e['target'].toLowerCase()) : undefined;
    const reach =
      !spotTarget && Number.isFinite(stated) && stated > 0
        ? stated
        : reachFor(intensity, median);

    let spot: MapLight['spot'] = null;
    if (spotTarget) {
      const d: [number, number, number] = [
        spotTarget[0] - origin[0],
        spotTarget[1] - origin[1],
        spotTarget[2] - origin[2],
      ];
      const len = Math.hypot(d[0], d[1], d[2]);
      if (len > 1e-3) {
        // `radius` is the cone radius AT THE TARGET, so the half-angle is
        // atan(radius / distance). Clamped away from the degenerate ends.
        const coneRadius =
          Number.isFinite(stated) && stated > 0 ? stated : DEFAULT_SPOT_RADIUS;
        spot = {
          direction: [d[0] / len, d[1] / len, d[2] / len],
          angle: Math.min(Math.PI / 2.2, Math.max(0.08, Math.atan(coneRadius / len))),
        };
      }
    }

    const torch = flamePoints.some(
      (p) =>
        (p[0] - origin[0]) ** 2 + (p[1] - origin[1]) ** 2 + (p[2] - origin[2]) ** 2 <=
        TORCH_RADIUS * TORCH_RADIUS,
    );

    out.push({
      origin,
      color,
      intensity,
      // A spot's reach has to cover the distance to its own target, or the
      // cone stops before it lands on anything.
      reach: spot && spotTarget ? Math.max(reach, Math.hypot(
        spotTarget[0] - origin[0],
        spotTarget[1] - origin[1],
        spotTarget[2] - origin[2],
      ) * 1.3) : reach,
      spot,
      torch,
    });
  }

  return out;
}

export interface MapLightOptions {
  /** Overall multiplier. 0 disables the whole feature. */
  scale: number;
  /** Plain (non-spot) pool slots. */
  points: number;
  /** Spot pool slots. These are the ones that can cast. */
  spots: number;
  /** How many spot slots cast shadows. */
  shadowCasters: number;
  /**
   * How many PLAIN slots cast shadows. A separate number from `shadowCasters`
   * on purpose: a point shadow is a cube, so it is six render passes to a
   * spot's one, and the two must not share a knob.
   */
  pointShadowCasters: number;
  /** Cull radius in Q3 units; beyond this a light is not considered. */
  range: number;
  /** How much a torch's brightness swings, as a fraction. */
  flicker: number;
}

export const DEFAULT_MAP_LIGHT_OPTIONS: Readonly<MapLightOptions> = {
  /*
   * Low, and the reason is the whole design constraint: the lightmap already
   * contains every one of these. This is a highlight on top of a contribution
   * that is already there, not a second bake.
   */
  scale: 0.3,
  points: 4,
  spots: 4,
  /*
   * TWO casting spots, and the number is a measurement.
   *
   * Under `?shadows=lights` a casting light also drags the WORLD into its
   * shadow pass, and on q3ctf2 -- the heaviest map in the set, 165 world
   * batches -- each casting spot costs about +90 draws and +90k triangles,
   * roughly half the map redrawn. Measured there at 1280x720: baseline 60fps
   * / 13.1ms CPU, one casting spot 56fps / 17.0ms, two 52fps / 18.5ms, four
   * plus a casting point 30fps. q3dm6 holds 60fps through all of it.
   *
   * FOUR, because "visible" was the requirement and two is not. A/B'd on the
   * q3dm6 staircase under its wall lamps: at four casters the cones stop at
   * the stairs and the picture changes completely (68k pixels darken, peak
   * 207/255); at two it is close enough to the unshadowed frame to argue
   * about. Empty slots are free since the park below stopped re-rendering
   * them, so the cost is per lamp actually near the player, not per slot --
   * which is why four is affordable at all.
   *
   * `?maplightshadows=2` is the knob for a map where that is too much.
   */
  shadowCasters: 4,
  /*
   * ZERO casting points, which is not a statement that they do not work.
   *
   * They do: `LIGHTING.md`'s finding 3 was re-derived on 2026-09-03 with two
   * casting map point lights over q3dm6's pentagram and the inlay stayed lit.
   * It is purely the bill. A point shadow is a CUBE -- six render passes to a
   * spot's one -- so on q3ctf2, where 973 of 983 declared lights are plain
   * points and the pool would always be full, one caster took 52fps to 30.
   *
   * `?maplightpointshadows=1` is there for a small map or a screenshot, and
   * it is the knob that makes "declared lights cast" true on a map with no
   * spotlights in it at all. It should not be the thing that decides the
   * frame rate everywhere else.
   */
  pointShadowCasters: 0,
  range: 900,
  /*
   * A FULL swing, and 0.22 was too timid to see.
   *
   * `flickerAt` maps depth to a brightness range of `[1 - depth/2, 1]`, so the
   * old 0.22 moved a torch between 89% and 100% of its own contribution --
   * over a lightmap that already contains the torch at full strength, that is
   * invisible in motion and was reported as the parameter doing nothing. 2
   * spans the whole range, `[0, 1]`: the flame drops to nothing at the bottom
   * of its dip and burns full at the top. It is also the ceiling -- past 2 the
   * multiplier goes negative, so `parseMapLightOptions` clamps there.
   */
  flicker: 2,
};

function num(params: URLSearchParams, key: string, fallback: number): number {
  const v = Number(params.get(key));
  return params.get(key) !== null && Number.isFinite(v) ? v : fallback;
}

export function parseMapLightOptions(search: string | URLSearchParams): MapLightOptions {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const d = DEFAULT_MAP_LIGHT_OPTIONS;
  /*
   * `?lightsonly` moves three of these defaults, and only the defaults -- an
   * explicit parameter still wins, so `?lightsonly&maplights=1` is a dimmer
   * version of the same picture rather than a contradiction. See
   * `light-debug.ts` for what the mode is for.
   */
  const only = isLightsOnly(params);
  return {
    // 4 rather than 0.3: with the bake gone, 0.3 is a black map.
    scale: Math.max(0, num(params, 'maplights', only ? 4 : d.scale)),
    points: Math.max(0, Math.round(num(params, 'maplightpoints', d.points))),
    spots: Math.max(0, Math.round(num(params, 'maplightspots', d.spots))),
    shadowCasters: Math.max(0, Math.round(num(params, 'maplightshadows', d.shadowCasters))),
    pointShadowCasters: Math.max(
      0,
      // Most maps are nearly all plain point lights (q3ctf2: 973 of 983), so
      // with these not casting there is nothing to look at on one.
      Math.round(num(params, 'maplightpointshadows', only ? 2 : d.pointShadowCasters)),
    ),
    range: Math.max(64, num(params, 'maplightrange', d.range)),
    /*
     * CLAMPED AT 2, not merely floored at 0.
     *
     * `flickerAt` returns `1 - depth * (0.5 - swing) * 0.5` with `swing` in
     * [-0.5, 0.5], so depth 2 already spans the whole `[0, 1]` range. Past it
     * the multiplier goes NEGATIVE and a torch becomes a negative light,
     * subtracting from the lightmap it is supposed to modulate. Nothing above
     * 2 is a thing to want, so it is refused here rather than in the shader.
     */
    flicker: Math.min(2, Math.max(0, num(params, 'maplightflicker', d.flicker))),
  };
}

export interface MapLights {
  /** How many lights the map declared, for the console line. */
  readonly count: number;
  /** How many of those are torches. */
  readonly torches: number;
  /** How many are spotlights. */
  readonly spots: number;
  /** Re-aim the pool at whatever is nearest `viewer`, and advance the flicker. */
  update(viewer: ArrayLike<number>, nowMs: number): void;
  dispose(): void;
}

/**
 * Deterministic per-light flicker, in 0..1.
 *
 * Two sines at incommensurable rates plus a per-light phase, so neighbouring
 * torches never pulse together — a row of them beating in unison is the one
 * thing that would read as a bug rather than as fire. No randomness: a frame
 * has to be reproducible for a screenshot to mean anything.
 */
export function flickerAt(seconds: number, phase: number, depth: number): number {
  const a = Math.sin(seconds * 11.3 + phase);
  const b = Math.sin(seconds * 4.7 + phase * 2.1);
  // Biased toward the top of the range: a flame mostly burns and occasionally
  // dips, rather than sitting at its own average.
  return 1 - depth * (0.5 - (a * 0.35 + b * 0.15)) * 0.5;
}

/**
 * Build the pool.
 *
 * Fixed size, for the reason `scene-lights.ts` gives at length: adding or
 * removing a light changes the material's light configuration and recompiles
 * every shader that sees it. 113 lights cannot all exist; six can, and are
 * re-aimed.
 */
export function createMapLights(
  world: Group,
  lights: readonly MapLight[],
  options: MapLightOptions = DEFAULT_MAP_LIGHT_OPTIONS,
): MapLights {
  const points: PointLight[] = [];
  const spots: SpotLight[] = [];

  const plain = lights.filter((l) => !l.spot);
  const cones = lights.filter((l) => l.spot);

  if (options.scale > 0) {
    for (let i = 0; i < options.points; i++) {
      const light = new PointLight(0xffffff, 0, 100, 2);
      light.name = `overbounce.maplight.point${i}`;
      light.castShadow = i < options.pointShadowCasters;
      if (light.castShadow) {
        // Six cube faces per light per frame, so half the spots' resolution.
        light.shadow.mapSize.set(1024, 1024);
        light.shadow.camera.near = 8;
        light.shadow.bias = -0.0008;
        light.shadow.normalBias = 2;
      }
      world.add(light);
      points.push(light);
    }

    for (let i = 0; i < options.spots; i++) {
      const light = new SpotLight(0xffffff, 0, 100, Math.PI / 6, 0.4, 2);
      light.name = `overbounce.maplight.spot${i}`;
      light.castShadow = i < options.shadowCasters;
      if (light.castShadow) {
        // 2048 for a spot, because a spot is ONE map and it is the shadow the
        // player actually looks at -- a wall lamp's cone against a staircase.
        // The cube faces below get half that, six times over.
        light.shadow.mapSize.set(2048, 2048);
        light.shadow.camera.near = 8;
        light.shadow.bias = -0.0008;
        light.shadow.normalBias = 2;
      }
      world.add(light);
      world.add(light.target);
      spots.push(light);
    }
  }

  /** A stable phase per light, so flicker does not resynchronise on cull. */
  const phase = new Map<MapLight, number>();
  lights.forEach((l, i) => phase.set(l, (i * 2.399963) % (Math.PI * 2)));

  /**
   * Nearest `count` of `from` to `viewer`, with their distances.
   *
   * Sorted every frame. With a few hundred lights and a handful of slots this
   * is a rounding error next to one draw call, and the alternative -- a spatial
   * index -- would have to be kept in step with nothing that ever moves.
   */
  const nearest = (
    from: readonly MapLight[],
    viewer: ArrayLike<number>,
    count: number,
  ): { light: MapLight; distance: number }[] => {
    const scored = from.map((light) => ({
      light,
      distance: Math.hypot(
        light.origin[0] - viewer[0],
        light.origin[1] - viewer[1],
        light.origin[2] - viewer[2],
      ),
    }));
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, count);
  };

  /**
   * Ramp to zero over the last fifth of the cull range.
   *
   * `scene-lights.ts` does not need this and says so: a rocket dropping out of
   * the list is over in a frame and nobody sees it. A WALL LAMP is a fixture,
   * and one blinking out as you strafe past reads as the level breaking.
   */
  const fade = (distance: number): number => {
    const start = options.range * 0.8;
    if (distance <= start) {
      return 1;
    }
    if (distance >= options.range) {
      return 0;
    }
    return 1 - (distance - start) / (options.range - start);
  };

  return {
    count: lights.length,
    torches: lights.filter((l) => l.torch).length,
    spots: cones.length,

    update(viewer: ArrayLike<number>, nowMs: number): void {
      const seconds = nowMs / 1000;

      const chosenPoints = nearest(plain, viewer, points.length);
      for (let i = 0; i < points.length; i++) {
        const light = points[i];
        const pick = chosenPoints[i];
        if (!pick || pick.distance > options.range) {
          /*
           * Zero intensity is not enough on a CASTING slot -- see
           * `scene-lights.ts`, which learned this the hard way. A fragment
           * outside a casting point light's shadow frustum reads as fully
           * occluded rather than fully lit, so an idle caster sitting at the
           * world origin with a stale far plane darkens the map with no light
           * in it. Park it where it can shadow nothing.
           */
          light.intensity = 0;
          if (light.castShadow) {
            light.position.set(PARKED_AT, PARKED_AT, PARKED_AT);
            light.distance = 1;
            light.shadow.camera.far = 2;
            light.shadow.camera.updateProjectionMatrix();
            // And stop re-rendering it -- an empty caster slot otherwise costs
            // its full six cube faces every frame. See `scene-lights.ts`.
            light.shadow.autoUpdate = false;
          }
          continue;
        }
        const l = pick.light;
        light.position.set(l.origin[0], l.origin[1], l.origin[2]);
        light.color.setRGB(l.color[0], l.color[1], l.color[2]);
        light.distance = l.reach;
        light.intensity =
          intensityFor(l, options.scale) *
          fade(pick.distance) *
          (l.torch ? flickerAt(seconds, phase.get(l) ?? 0, options.flicker) : 1);
        if (light.castShadow) {
          light.shadow.autoUpdate = true;
          light.shadow.camera.far = l.reach;
          light.shadow.camera.updateProjectionMatrix();
        }
      }

      const chosenSpots = nearest(cones, viewer, spots.length);
      for (let i = 0; i < spots.length; i++) {
        const light = spots[i];
        const pick = chosenSpots[i];
        if (!pick || pick.distance > options.range) {
          light.intensity = 0;
          if (light.castShadow) {
            // One 2D map rather than six faces, but the same argument: an
            // empty slot should not render the world. See the point park.
            light.shadow.autoUpdate = false;
          }
          continue;
        }
        const l = pick.light;
        const cone = l.spot;
        if (!cone) {
          light.intensity = 0;
          continue;
        }
        light.position.set(l.origin[0], l.origin[1], l.origin[2]);
        // The target is a real object in the world group, so it takes Quake
        // coordinates like the light does -- the group carries the one rotation.
        light.target.position.set(
          l.origin[0] + cone.direction[0] * l.reach,
          l.origin[1] + cone.direction[1] * l.reach,
          l.origin[2] + cone.direction[2] * l.reach,
        );
        light.target.updateMatrixWorld();
        light.color.setRGB(l.color[0], l.color[1], l.color[2]);
        light.distance = l.reach;
        light.angle = cone.angle;
        light.intensity =
          intensityFor(l, options.scale) *
          fade(pick.distance) *
          (l.torch ? flickerAt(seconds, phase.get(l) ?? 0, options.flicker) : 1);
        if (light.castShadow) {
          light.shadow.autoUpdate = true;
          light.shadow.camera.far = l.reach;
          light.shadow.camera.updateProjectionMatrix();
        }
      }
    },

    dispose(): void {
      for (const light of points) {
        world.remove(light);
        light.dispose();
      }
      for (const light of spots) {
        world.remove(light.target);
        world.remove(light);
        light.dispose();
      }
    },
  };
}
