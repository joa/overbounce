/**
 * Real lit materials: the lightmap as irradiance, not as a multiply.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Stage 2 of `.agent/plans/LIGHTING.md`. Everything the renderer drew used to
 * be a `MeshBasicNodeMaterial` — unlit by definition — and that one fact was
 * behind a run of workarounds: a hand-written eight-slot forward renderer in
 * `dynamic-lights.ts`, a hand-patched shadow term in `shadow-map.ts`, and an
 * additive glow sphere built because a `THREE.PointLight` illuminated nothing.
 *
 * ## The one trick that makes this a small change
 *
 * `bsp-mesh.ts` composites a Quake shader as ordered stages, and the lightmap
 * is one of those stages — `$lightmap` — composited in its own position. That
 * matters, because the position is not always the same: a lightmap-first floor
 * multiplies its texture ONTO the lightmap, while `diamond2c_ow` masks first
 * and multiplies the lightmap over the result. Pulling the lightmap out of the
 * stack by pattern-matching would have to understand all of that.
 *
 * It does not have to. Substitute **white** for the `$lightmap` stage and hand
 * the real lightmap to the material as `lightMap` + `uv1`, and for every case
 * where the lightmap participates by MULTIPLICATION the result is identical —
 * `a × 1 × b` composited, then × lightmap by the material, is `a × lightmap × b`
 * either way, because multiplication commutes. The stack keeps its ordering and
 * the lighting moves to where three can add to it.
 *
 * The cases this is NOT identical for are shaders that ADD or alpha-blend the
 * lightmap rather than multiplying it. Those exist but are rare, and the
 * failure mode is a surface slightly too bright rather than a black hole.
 *
 * ## What stays unlit, and why that is not laziness
 *
 * A shader whose stage 0 is additive IS light — a lamp halo, a flare, a torch
 * flame, a forcefield. Quake never lightmaps those (`shader.lightmapped` is
 * false and `RB_IterateStagesGeneric` composites them raw), and lighting them
 * would be backwards: a torch flame would get dimmer in a dark room, which is
 * the one place it is supposed to be brightest. Those keep a basic material.
 *
 * ## Lambert, and why not Standard
 *
 * `standard` was the default first, on the reasoning that the project owner
 * asked for modern rather than 1:1-with-1999 and PBR is what modern means.
 * **It is measurably wrong on this content**, and the evidence is a
 * screenshot: on q3dm6 the pentagram's gold inlaid star renders SOLID BLACK
 * under `MeshStandardNodeMaterial` and correctly under
 * `MeshLambertNodeMaterial`, from the same composited albedo and the same
 * lightmap. It is not the specular lobe — `?roughness=1&metalness=0` is black
 * too — and it is not the post chain, since `?post=off`, `?ssao=off` and
 * `?tonemap=off` all still show it. Something in three's physical model does
 * not survive what Quake's shader compositor produces, most likely the
 * view-dependent terms meeting normals that no unlit renderer ever had to
 * care about.
 *
 * That diagnosis is incomplete, and the default is set on the picture rather
 * than on the diagnosis: Lambert is correct, cheaper, and is also what Quake
 * itself does — `RB_CalcDiffuseColor` is `ambient + directed * max(0, N·L)`,
 * a Lambertian model with no specular term at all.
 *
 * None of the "modern" the owner asked for is lost by this. What makes a light
 * read as a light here is that it is a REAL light — it moves, it falls off,
 * it adds to a lightmap it could not previously touch, and it casts. A
 * specular highlight on a 1999 wall texture with no roughness map was never
 * going to be the part that mattered.
 *
 * `?lit=standard` is still available for anyone who wants to finish the
 * diagnosis. `?lit=off` restores the old unlit pipeline exactly, which is the
 * comparison this whole stage is verified against.
 */

import {
  DataTexture,
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshStandardNodeMaterial,
  RGBAFormat,
  SRGBColorSpace,
} from 'three/webgpu';
import type { Texture } from 'three/webgpu';

/** Which material class world and model surfaces get. */
export type LitMode = 'standard' | 'lambert' | 'off';

/**
 * A node material that can carry a composited `colorNode`.
 *
 * The three classes below share no common subtype that admits `colorNode`, so
 * this states the shape the compositor actually needs rather than casting at
 * every call site.
 */
export type SurfaceMaterial = (
  | MeshBasicNodeMaterial
  | MeshLambertNodeMaterial
  | MeshStandardNodeMaterial
) & {
  colorNode?: unknown;
  emissiveNode?: unknown;
};

export interface LitOptions {
  mode: LitMode;
  /**
   * Multiplier on the lightmap's contribution as irradiance.
   *
   * Needed because the two paths do not scale the same. As a colour multiply
   * the lightmap was applied at face value; as irradiance three runs it through
   * `BRDF_Lambert`, which divides by π. The default is therefore π exactly, and
   * that is not a fudge — it cancels a constant in three's lighting model. The
   * screenshot confirms it: at π the lit picture on q3dm6 matches `?lit=off`.
   */
  lightmapIntensity: number;
  /**
   * Surface roughness for `standard`, which is not the default. 1 is fully
   * diffuse. High, because a Quake wall texture has no roughness map and a low
   * value gives every surface in the game the same plastic sheen.
   */
  roughness: number;
  /** Metalness for `standard`. Quake has no metal workflow; 0 is correct. */
  metalness: number;
}

export const DEFAULT_LIT_OPTIONS: Readonly<LitOptions> = {
  mode: 'lambert',
  // PI, and it is derived rather than dialled in. Three's physical lighting
  // model applies `BRDF_Lambert = diffuseColor / PI` to irradiance, while the
  // old unlit path multiplied the lightmap in at face value. Multiplying the
  // irradiance by PI cancels it exactly -- and the screenshot agrees: at this
  // value the lit picture on q3dm6 is the `?lit=off` picture, which is the
  // whole safety rail this migration is checked against.
  lightmapIntensity: Math.PI,
  roughness: 0.9,
  metalness: 0,
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

/** `?lit=standard|lambert|off`, plus its tuning knobs. */
export function parseLitOptions(search: string | URLSearchParams): LitOptions {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;

  let mode = DEFAULT_LIT_OPTIONS.mode;
  const raw = params.get('lit');
  if (raw !== null) {
    const v = raw.trim().toLowerCase();
    if (v === 'off' || v === 'basic' || v === 'none' || v === '0') {
      mode = 'off';
    } else if (v === 'lambert') {
      mode = 'lambert';
    } else if (v === 'standard' || v === 'on' || v === '1' || v === '') {
      mode = 'standard';
    } else {
      console.warn(`[overbounce] ignoring ?lit=${raw}: expected standard, lambert or off`);
    }
  }

  return {
    mode,
    lightmapIntensity: Math.max(
      0,
      num(params, 'lightmapintensity', DEFAULT_LIT_OPTIONS.lightmapIntensity),
    ),
    roughness: Math.min(1, Math.max(0, num(params, 'roughness', DEFAULT_LIT_OPTIONS.roughness))),
    metalness: Math.min(1, Math.max(0, num(params, 'metalness', DEFAULT_LIT_OPTIONS.metalness))),
  };
}

/**
 * Build the material for one surface.
 *
 * `emissive` marks a surface that IS light rather than one that receives it —
 * an additive stage-0 shader, or any surface with no lightmap to be lit by.
 * Those always get a basic material whatever the mode, because the lit path
 * has nothing to offer them and would only cost per-fragment work.
 */
export function createSurfaceMaterial(
  options: LitOptions,
  emissive: boolean,
): SurfaceMaterial {
  if (options.mode === 'off' || emissive) {
    return new MeshBasicNodeMaterial();
  }
  if (options.mode === 'lambert') {
    return new MeshLambertNodeMaterial();
  }
  const material = new MeshStandardNodeMaterial();
  material.roughness = options.roughness;
  material.metalness = options.metalness;
  return material;
}

/**
 * Attach a lightmap as the surface's irradiance.
 *
 * `NodeMaterial.setupLightMap` (three's own, r0.185) turns `material.lightMap`
 * into an `IrradianceNode` and pushes it into the material's light list, so a
 * punctual light ADDS to it rather than replacing it. That addition is the
 * whole point of this migration — it is what lets a rocket brighten a wall the
 * lightmap left dark, which the old multiply could never do.
 *
 * A no-op on a basic material: `?lit=off` keeps the lightmap composited in the
 * stage stack instead, which is the reference picture.
 */
export function applyLightmap(
  material: SurfaceMaterial,
  lightmap: Texture,
  options: LitOptions,
): boolean {
  if (options.mode === 'off') {
    return false;
  }
  const withLightmap = material as { lightMap?: Texture | null; lightMapIntensity?: number };
  if (!('lightMap' in material)) {
    return false;
  }

  /*
   * `channel = 1` IS THE FIX, and without it the walls were a montage.
   *
   * `NodeMaterial.setupLightMap` builds `IrradianceNode(materialLightMap)`,
   * `MaterialNode.getTexture` builds a plain `TextureNode` with no explicit UV,
   * and `TextureNode.getDefaultUV` returns `uv(this.value.channel)` — which is
   * **0** by default. So the lightmap was being sampled with the DIFFUSE
   * coordinates: a 128x128 lightmap atlas tiled across every wall, which on
   * screen looks like a montage of unrelated images and was briefly mistaken
   * for a compositing bug.
   *
   * Quake writes lightmap coordinates into their own set, which `bsp-mesh.ts`
   * uploads as `uv1`. This is three's own mechanism for saying so, and it is
   * the same one its `aoMap`/`lightMap` handling uses.
   *
   * The texture is cloned first because the cache hands out ONE object per
   * lightmap page, and `channel` lives on the texture rather than on the
   * material — mutating the shared object would set it for every consumer,
   * including any future one that wants uv0.
   */
  const forIrradiance = lightmap.clone();
  forIrradiance.channel = 1;
  forIrradiance.needsUpdate = true;

  withLightmap.lightMap = forIrradiance;
  withLightmap.lightMapIntensity = options.lightmapIntensity;
  return true;
}

/**
 * A 1x1 white lightmap, for MODELS.
 *
 * A model has no lightmap — Quake lights it from one light-grid sample per
 * entity, and `md3-mesh.ts` composites that into `colorNode` through
 * `diffuseLight`, directional term and all. That is worth keeping: it is the
 * ported behaviour, it carries a `dot(N, L)` the grid supplies, and nobody has
 * complained about how models look.
 *
 * But a lit material with no irradiance at all is BLACK. So the model gets a
 * flat white one, which restores exactly what the unlit path drew and leaves
 * the punctual lights free to add on top. It is the identity element, not a
 * light source.
 *
 * Shared: every model can point at the same texture, because none of them
 * writes to it.
 */
let sharedWhite: DataTexture | null = null;

export function modelIrradiance(): DataTexture {
  if (!sharedWhite) {
    sharedWhite = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
    sharedWhite.colorSpace = SRGBColorSpace;
    sharedWhite.needsUpdate = true;
  }
  return sharedWhite;
}

/**
 * Give a model material flat irradiance so punctual lights can add to it.
 *
 * `lightMapIntensity` is π for the same reason it is π on the world: three
 * applies `BRDF_Lambert`, which divides by π, and cancelling it makes the lit
 * path reproduce the unlit one.
 */
export function applyModelIrradiance(material: SurfaceMaterial, options: LitOptions): boolean {
  if (options.mode === 'off') {
    return false;
  }
  const withLightmap = material as { lightMap?: Texture | null; lightMapIntensity?: number };
  if (!('lightMap' in material)) {
    return false;
  }
  withLightmap.lightMap = modelIrradiance();
  withLightmap.lightMapIntensity = Math.PI;
  return true;
}
