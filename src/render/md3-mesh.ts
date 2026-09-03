/**
 * Turning MD3 models into renderable three.js objects.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A Quake III player is three separate models — legs, torso and head — joined
 * at named tags. The legs own the position, the torso hangs off the legs'
 * `tag_torso`, and the head hangs off the torso's `tag_head`. That split is why
 * a Q3 player can run in one direction while aiming in another, and it is
 * reproduced here as a chain of parented Object3Ds so three's own transform
 * hierarchy does the work.
 */

import {
  BufferAttribute,
  ClampToEdgeWrapping,
  DoubleSide,
  BufferGeometry,
  DataTexture,
  Group,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three/webgpu';
import type { Object3D } from 'three/webgpu';
import type { Md3Model, Md3Surface, Md3Tag } from '../assets/md3.js';
import { findTag, lerpSurfaceFrames, parseMd3 } from '../assets/md3.js';
import type { Pk3FileSystem } from '../assets/pk3.js';
import { parseSkin, shaderForSurface } from '../assets/skin.js';
import type { Skin } from '../assets/skin.js';
import { decodeTga } from '../assets/tga.js';
import {
  alphaTestOf,
  isAdditiveStage,
  isAlphaBlendedStage,
  isFilterStage,
  shaderBlendBase,
  stageBlendOp,
  shaderKey,
} from '../assets/shader.js';
import type { Shader, ShaderStage } from '../assets/shader.js';
import { applyAdditiveBlend, applyAlphaBlend, applyFilterBlend } from './blend.js';
import { castsShadow } from './shadow-map.js';
import type { SurfaceMaterial } from './lit.js';
import { applyEntityFog } from './fog.js';
import type { EntityFog, Fog } from './fog.js';
import { applyTcMods, deformNode, environmentUv, waveNode } from './shader-anim.js';
import type { ShaderClock } from './shader-anim.js';
import type { EntityLight } from './light-grid.js';
import { float, mix, normalLocal, texture as tslTexture, uniform, uv, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

/**
 * Flip every triangle's winding.
 *
 * Quake's triangles are wound the opposite way round from three's: `GL_Cull`
 * in `tr_backend.c` calls `qglCullFace(GL_FRONT)` for the default
 * `CT_FRONT_SIDED`, so the face Quake shows you is the one OpenGL calls the
 * back. The same inversion applies to the BSP, and `bsp-mesh.ts` has always
 * corrected it -- MD3 was simply missed.
 *
 * The models carry their own per-vertex normals, which settles it beyond
 * argument: across five shipped models not one triangle's winding agreed with
 * the artist's normals, and 1435 disagreed. `tools/diag/md3-winding.ts` runs
 * that check on any pak.
 *
 * The symptom is deceptive on organic models -- a character seen from inside
 * still reads as a character -- but a box gives it away completely: you see
 * the faces on the FAR side and not the ones in front.
 *
 * Reverse at emit time rather than setting `BackSide`. Both render the same,
 * but only one leaves geometry that is right-side-out for lighting, raycasts,
 * and anything added later.
 */
function reverseWinding(indices: Uint16Array): Uint16Array {
  const out = new Uint16Array(indices.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    out[i] = indices[i];
    out[i + 1] = indices[i + 2];
    out[i + 2] = indices[i + 1];
  }
  return out;
}

/** Geometry for one surface at one frame, or interpolated between two. */
export function buildSurfaceGeometry(
  surface: Md3Surface,
  frameA = 0,
  frameB = 0,
  t = 0,
): BufferGeometry {
  const n = surface.numVerts;
  const xyz = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  lerpSurfaceFrames(surface, frameA, frameB, t, xyz, normals);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(xyz, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(surface.st.slice(), 2));
  geometry.setIndex(new BufferAttribute(reverseWinding(surface.indices), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Load a texture out of the player's own paks.
 *
 * Quake references textures without an extension and the real file may be .tga
 * or .jpg. JPEGs the browser decodes natively; TGA it has never supported, so
 * those go through our own decoder — and most model skins are TGA.
 */
const textureCache = new Map<string, Promise<Texture | null>>();

/**
 * Drop the texture cache. Call when the mounted paks change, since the cache is
 * keyed by path alone and a different pak can answer the same path.
 */
export function clearTextureCache(): void {
  textureCache.clear();
}

export async function loadTexture(
  fs: Pk3FileSystem,
  reference: string,
): Promise<Texture | null> {
  const path = fs.findImage(reference);
  if (!path) {
    return null;
  }

  // Cached because entity lighting forces a separate load per item: each one
  // needs its own uniforms, so materials cannot be shared, and without this
  // a map's fifty pickups would decode the same handful of TGAs fifty times.
  const hit = textureCache.get(path);
  if (hit) {
    return hit;
  }
  const pending = decodeTexture(fs, path);
  textureCache.set(path, pending);
  return pending;
}

async function decodeTexture(
  fs: Pk3FileSystem,
  path: string,
): Promise<Texture | null> {
  const bytes = await fs.readFile(path);
  if (!bytes) {
    return null;
  }

  let texture: Texture;
  if (path.endsWith('.tga')) {
    const img = decodeTga(bytes);
    texture = new DataTexture(img.data, img.width, img.height, RGBAFormat);
    texture.needsUpdate = true;
  } else {
    const bitmap = await createImageBitmap(
      new Blob([bytes.slice() as unknown as BlobPart]),
    );
    texture = new Texture(bitmap as unknown as HTMLImageElement);
    texture.needsUpdate = true;
  }

  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false; // MD3 texture coordinates already run top-down
  return texture;
}

export interface LoadedMd3 {
  model: Md3Model;
  object: Group;
  /** Per surface, in the model's surface order. */
  meshes: Mesh[];
  /**
   * Set the entity light this model is shaded by.
   *
   * `R_SetupEntityLighting` runs per entity per frame, so an item calls this
   * once where it stands and the player model calls it every frame as it moves
   * through the map. The uniforms belong to THIS load, which is why models that
   * need different lighting cannot share one prototype's materials.
   */
  setLight(light: EntityLight): void;
  /**
   * `R_ComputeFogNum`'s answer, applied. 0 takes the model out of any fog.
   *
   * A no-op unless the shader context supplied a fog table, which is every map
   * without fog brushes -- nearly all of them.
   */
  setFog(index: number): void;
  /**
   * The model frame's bounding-sphere radius, which is what `R_ComputeFogNum`
   * tests against a volume's bounds. Frame 0's: a player's radius barely moves
   * between animation frames and re-reading it per frame would buy nothing.
   */
  readonly radius: number;
}

/**
 * The per-model lighting uniforms, in the shape `RB_CalcDiffuseColor` wants.
 *
 * Kept as uniforms rather than baked constants so one load can be re-lit as it
 * moves. A model standing still simply never updates them.
 */
interface LightUniforms {
  ambient: ReturnType<typeof uniform<'vec3'>>;
  directed: ReturnType<typeof uniform<'vec3'>>;
  dir: ReturnType<typeof uniform<'vec3'>>;
}

function makeLightUniforms(): LightUniforms {
  // The fallback is `R_SetupEntityLighting`'s no-world-model case: flat 150
  // from straight above, so a model built before the grid is known is lit
  // plausibly rather than black.
  return {
    ambient: uniform(new Vector3(150 / 255, 150 / 255, 150 / 255)),
    directed: uniform(new Vector3(150 / 255, 150 / 255, 150 / 255)),
    dir: uniform(new Vector3(0, 0, 1)),
  };
}

/** Build a renderable object for one MD3, textured from the given paks. */
export interface Md3ShaderContext {
  /** Every parsed `.shader`, keyed by lowercased name. */
  shaders: ReadonlyMap<string, Shader>;
  /** Drives tcMods and rgbGen waves. */
  clock: ShaderClock;
  /** Camera position IN THE MODEL'S SPACE, for `tcGen environment`. */
  cameraObjectPosition: Node<'vec3'>;
  /**
   * The map's fog table, if the model should be able to take fog.
   *
   * `R_AddMD3Surfaces` hands `R_ComputeFogNum`'s result to `R_AddDrawSurf`, so
   * a model inside a volume gets the same fog pass a world surface in it does.
   * Omitted and models never fog, which is what they did before this existed --
   * a player in q3dm7's hellfogdense standing out as an unfogged cutout.
   */
  fogs?: readonly (Fog | null)[];
  /**
   * The fog feather, in Q3 units, so a model fades in at a volume's edge on
   * the same curve the wall behind it does. See `FOG_FEATHER`; omitted takes
   * the default rather than the faithful zero, which is also what the world
   * build does.
   */
  fogFeather?: number;
}

export async function loadMd3(
  fs: Pk3FileSystem,
  path: string,
  skin: Skin | null = null,
  ctx: Md3ShaderContext | null = null,
): Promise<LoadedMd3 | null> {
  const bytes = await fs.readFile(path);
  if (!bytes) {
    return null;
  }

  const model = parseMd3(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );

  const object = new Group();
  const meshes: Mesh[] = [];
  // One set per load, shared by every surface of this model -- Quake lights a
  // whole entity from one grid sample, not a surface at a time.
  const light = makeLightUniforms();
  const fogHandles: EntityFog[] = [];

  for (const surface of model.surfaces) {
    const reference = shaderForSurface(skin, surface.name, surface.shaders[0]);
    /*
     * MODELS ARE UNLIT, and this is a correction rather than an oversight.
     *
     * A model's `colorNode` already carries its COMPLETE lighting: Quake lights
     * an entity from one light-grid sample with `RB_CalcDiffuseColor`'s
     * `ambient + directed * max(0, N·L)`, which `diffuseLight` composites in
     * below. Giving it a lit material on top means every other light in the
     * scene -- the grid-steered sun, the map's lamps, the dynamic lights --
     * adds a SECOND lighting pass to something already fully lit.
     *
     * The result was reported as models "not lit by the environment", and that
     * is exactly how it looked: washed out and grey rather than picking up the
     * room. Isolating it was one screenshot -- `?shadows=off` removes the sun
     * and the model snaps back to matching `?lit=off`.
     *
     * Three's WebGPU renderer tests light layers against the CAMERA
     * (`Renderer.js:973`), not per object, so there is no way to exclude models
     * from a light while keeping it on the world. Given that, unlit is not a
     * fallback: it is what Quake does, and it costs nothing that was working --
     * models still respond to dynamic lights through `applyDynamicLights`
     * bending the grid sample, which is the ported behaviour, and they still
     * CAST shadows because the shadow pass only needs depth.
     *
     * What it does cost is models RECEIVING shadows. Accepted; see
     * `.agent/plans/LIGHTING.md`.
     */
    const material = new MeshBasicNodeMaterial({ color: 0xffffff });

    // A model surface names a shader, exactly like a BSP surface does, and for
    // some models that shader is the whole appearance: the Quad is a single
    // `tcGen environment` stage with its base texture commented out, so a
    // direct texture lookup finds nothing usable.
    const shader = ctx && reference ? ctx.shaders.get(shaderKey(reference)) : undefined;
    let applied = false;

    if (ctx && shader) {
      applied = await applyModelShader(fs, material, shader, ctx, light);
    }

    if (!applied) {
      const texture = reference ? await loadTexture(fs, reference) : null;
      if (texture) {
        // No shader, so no `rgbGen` to read -- but a bare model texture is
        // still an entity surface, and Quake lights those the same way. This
        // is the common case for player models, whose skins name plain images.
        material.colorNode = tslTexture(texture, uv()).mul(diffuseLight(light));
      } else {
        // A missing texture should look obviously missing, not invisible.
        material.color.setHex(0x9a9aa6);
      }
    }

    const mesh = new Mesh(buildSurfaceGeometry(surface), material);
    mesh.name = surface.name;
    // Every model is a shadow caster under `?shadows=dynamic`, and the flag is
    // inert until `createDynamicShadows` turns shadow mapping on -- so marking
    // it here costs nothing in the other two modes and saves every call site
    // from having to register its models. Opaque surfaces only: the shadow pass
    // draws casters solid black, so a powerup's transparent shell would cast a
    // filled disc instead of the item inside it.
    mesh.castShadow = castsShadow(material);
    /*
     * A model RECEIVES light and shadow, which is the inverse of the world's
     * rule and for the same reason: the world's self-shadowing is already
     * baked into its lightmap, and a model's cannot be. This is the geometry
     * the project owner actually wants casting -- the player, the items, a
     * door -- and it is why `bsp-mesh.ts` can afford to switch world casting
     * off entirely.
     */

    // Fog wraps whatever colour the stages above composited, so it has to come
    // last -- `RB_FogPass` is drawn after `RB_IterateStagesGeneric`, which is
    // the same statement.
    if (ctx?.fogs) {
      /*
       * `lit: false`, because models are unlit -- see the material above. On an
       * unlit material `colorNode` IS the finished pixel, so fog mixes there.
       * Passing `true` here would send it to `outputNode`, which a basic
       * material does not run the same way, and the fog would vanish.
       */
      const handle = applyEntityFog(material, ctx.fogs, false, ctx.fogFeather);
      if (handle) {
        fogHandles.push(handle);
      }
    }

    object.add(mesh);
    meshes.push(mesh);
  }

  return {
    model,
    object,
    meshes,
    radius: model.frames[0]?.radius ?? 0,
    setFog(index: number): void {
      for (const handle of fogHandles) {
        handle.set(index);
      }
    },
    setLight(value: EntityLight): void {
      // The grid stores 0..255 bytes; the shader wants 0..1.
      light.ambient.value.set(
        value.ambient[0] / 255,
        value.ambient[1] / 255,
        value.ambient[2] / 255,
      );
      light.directed.value.set(
        value.directed[0] / 255,
        value.directed[1] / 255,
        value.directed[2] / 255,
      );
      light.dir.value.set(value.dir[0], value.dir[1], value.dir[2]);
    },
  };
}

/**
 * `ComputeColors`' rgbGen half, as a node that modulates the sampled texture.
 *
 * Several of these collapse to a constant here, and deliberately so rather than
 * by omission. An MD3 has NO per-vertex colours -- the format does not carry
 * them -- so `tess.vertexColors` for a model comes from the entity's
 * `shaderRGBA`, and Overbounce draws every item and player at full white. So
 * `vertex`, `exactVertex` and `entity` are all 1, and their `oneMinus` forms
 * are 0. That is what Quake computes for a white entity, not a shortcut.
 *
 * `identityLighting` is `tr.identityLight`, which is `1 / (1 << overbrightBits)`.
 * This renderer bakes the overbright shift into the lightmap and light-grid
 * bytes instead of dividing at draw time, so identityLight is 1 here and the
 * two identity forms agree.
 */
function rgbGenNode(
  stage: ShaderStage,
  ctx: Md3ShaderContext,
  light: LightUniforms,
): Node<'vec3'> {
  switch (stage.rgbGen) {
    case 'lightingDiffuse':
      return diffuseLight(light);
    case 'wave':
      return stage.rgbWave
        ? vec3(waveNode(stage.rgbWave, ctx.clock.node))
        : vec3(1, 1, 1);
    case 'const':
      return vec3(
        stage.constantColor[0],
        stage.constantColor[1],
        stage.constantColor[2],
      );
    case 'oneMinusVertex':
    case 'oneMinusEntity':
      return vec3(0, 0, 0);
    default:
      return vec3(1, 1, 1);
  }
}

/**
 * `ComputeColors`' alphaGen half.
 *
 * `lightingSpecular` and `portal` are not modelled and pass through as opaque:
 * specular needs a real light vector per vertex and portal needs the portal
 * plane, and guessing at either would dim surfaces for no reason.
 */
function alphaGenNode(stage: ShaderStage, ctx: Md3ShaderContext): Node<'float'> {
  switch (stage.alphaGen) {
    case 'wave':
      return stage.alphaWave ? waveNode(stage.alphaWave, ctx.clock.node) : float(1);
    case 'const':
      return float(stage.constantColor[3]);
    case 'oneMinusVertex':
    case 'oneMinusEntity':
      return float(0);
    default:
      return float(1);
  }
}

/**
 * `RB_CalcDiffuseColor`, as a node.
 *
 *     incoming = DotProduct( normal, lightDir );
 *     if ( incoming <= 0 ) { colors = ambientLightInt; continue; }
 *     j = ambientLight[i] + incoming * directedLight[i];  // clamped to 255
 *
 * The `incoming <= 0` branch and the clamp are the same thing as
 * `ambient + max(dot, 0) * directed`, saturated -- a surface facing away from
 * the light gets pure ambient, never negative.
 *
 * `normalLocal` is right and `normalWorld` would be wrong: the C transforms
 * the light direction INTO the entity's space (`ent->lightDir[i] =
 * DotProduct(lightDir, ent->e.axis[i])`) and dots it against the model's own
 * normals, so a spinning item's highlight sweeps across it. Doing it in world
 * space would pin the highlight and make the spin invisible.
 */
function diffuseLight(light: LightUniforms): Node<'vec3'> {
  const incoming = normalLocal.normalize().dot(light.dir).max(0);
  return light.ambient.add(light.directed.mul(incoming)).clamp(0, 1);
}

/**
 * Build a model surface's material from its shader.
 *
 * A cut-down `RB_StageIteratorGeneric`: model shaders have no lightmap, so
 * this is the stages composited in order, each with its own tcMods and its own
 * `tcGen environment`.
 *
 * COMPOSITING ORDER IS THE WHOLE POINT. Quake draws a model shader as multiple
 * passes over the same triangles, each pass blending into the result of the
 * ones before it. An ammo box is three of them:
 *
 *     models/powerups/ammo/bfgammo
 *     {
 *       { map textures/effects/envmapbfg.tga   <- the shine, underneath
 *         tcmod rotate 350  tcmod scroll 3 1
 *         blendfunc GL_ONE GL_ZERO }
 *       { map textures/effects/tinfx2.tga      <- a highlight, added
 *         tcGen environment
 *         blendfunc GL_ONE GL_ONE }
 *       { map models/powerups/ammo/bfgammo.tga <- THE MODEL'S ACTUAL COLOUR
 *         blendfunc blend
 *         rgbGen lightingDiffuse }
 *     }
 *
 * Picking "the diffuse stage" and adding the additive ones drops that last
 * pass, because `blendfunc blend` is neither. What is left is a scrolling
 * envmap and nothing else -- which is exactly what the ammo boxes looked like:
 * colourless, and appearing to rotate, because the `tcmod rotate` on the base
 * was the only thing still visible.
 *
 * Returns false when the shader has nothing drawable, so the caller can fall
 * back to a plain texture lookup.
 */
async function applyModelShader(
  fs: Pk3FileSystem,
  // `SurfaceMaterial` rather than the basic class: the same compositor now
  // runs on lit materials too, and everything it touches (`colorNode`,
  // `opacityNode`, `side`, blending) is `NodeMaterial` surface, not
  // basic-specific.
  material: SurfaceMaterial,
  shader: Shader,
  ctx: Md3ShaderContext,
  light: LightUniforms,
): Promise<boolean> {
  type TexNode = ReturnType<typeof tslTexture>;
  // The accumulator has to be the general vec4 node, not a texture node: after
  // the first blend it is the result of an operation, not a sample.
  type ColorNode = ReturnType<TexNode['mul']>;

  interface Sampled {
    /** RGB, after any `rgbGen wave`. */
    color: ColorNode;
    /** The texture's own alpha, unscaled -- what `blendfunc blend` mixes by. */
    alpha: TexNode['a'];
  }

  const sample = async (stage: ShaderStage): Promise<Sampled | null> => {
    if (!stage.map) {
      return null;
    }
    const texture = await loadTexture(fs, stage.map);
    if (!texture) {
      return null;
    }

    if (stage.clamp) {
      texture.wrapS = ClampToEdgeWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      texture.needsUpdate = true;
    }

    // tcGen environment REPLACES the coordinates rather than modifying them.
    let coords = stage.envMap ? environmentUv(ctx.cameraObjectPosition) : uv();
    if (stage.tcMods.length) {
      coords = applyTcMods(coords, stage.tcMods, ctx.clock.node);
    }

    const node = tslTexture(texture, coords);
    // `ComputeColors` produces a colour per stage and the texture is modulated
    // by it. rgbGen touches RGB only and alphaGen only alpha, which is why the
    // two are computed apart and why the alpha handed back below never carries
    // the rgb term.
    const color: ColorNode = node.mul(rgbGenNode(stage, ctx, light));
    return { color, alpha: node.a.mul(alphaGenNode(stage, ctx)) };
  };

  // The first stage that actually resolves is the base; everything after it
  // blends into the accumulated result, by its own blendfunc.
  let color: ColorNode | null = null;

  for (const stage of shader.stages) {
    const s = await sample(stage);
    if (!s) {
      continue;
    }
    if (!color) {
      color = s.color;
      continue;
    }

    switch (stageBlendOp(stage)) {
      case 'add':
        color = color.add(s.color);
        break;
      case 'multiply':
        // GL_DST_COLOR GL_ZERO -- modulate what is already there.
        color = color.mul(s.color);
        break;
      case 'blend':
        // GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA. This is the pass that carries a
        // pickup's colour, layered over its shine.
        color = mix(color, s.color, s.alpha);
        break;
      case 'replace':
        color = s.color;
        break;
    }
  }

  if (!color) {
    return false;
  }

  material.colorNode = color;

  // How the SURFACE meets the scene is decided by stage 0 -- see
  // `shaderBlendBase`. For a model that is usually the first drawable stage,
  // but the health and armour "sphere" shells are a single `tcGen environment`
  // stage with `blendfunc GL_ONE GL_ONE` and no opaque pass at all. Treating
  // those as opaque draws a solid ball over the item inside it.
  //
  // Both translucent cases also drop depth writes: a translucent surface that
  // writes depth occludes what is behind it, and for a shell that surrounds
  // the item, "behind it" is the item.
  const baseStage = shaderBlendBase(shader);
  if (baseStage && isAdditiveStage(baseStage)) {
    applyAdditiveBlend(material);
  } else if (baseStage && isFilterStage(baseStage)) {
    applyFilterBlend(material);
  } else if (baseStage && isAlphaBlendedStage(baseStage)) {
    applyAlphaBlend(material);
  }

  // alphaFunc, likewise read off stage 0: it is a property of the surface, not
  // of a pass layered onto it.
  const test = baseStage ? alphaTestOf(baseStage) : null;
  if (test && baseStage?.map) {
    const texture = await loadTexture(fs, baseStage.map);
    if (texture) {
      const alpha = tslTexture(texture, uv()).a;
      material.opacityNode = test.keepAbove ? alpha : alpha.oneMinus();
      material.alphaTest = test.keepAbove ? test.threshold : 1 - test.threshold;
    }
  }

  // deformVertexes moves the geometry itself. The world path has always done
  // this; models never did, so the armour shard's halo -- which is a single
  // `deformVertexes wave 100 sin 2 0 0 0` stage -- sat perfectly still where
  // Quake breathes it in and out.
  //
  // Vertex stage only, so nothing about collision changes: an item's pickup box
  // is the undeformed one, which is what Quake does too.
  if (shader.deforms.length) {
    const deformed = deformNode(shader.deforms, ctx.clock.node);
    if (deformed) {
      material.positionNode = deformed;
    }
  }

  if (shader.twoSided) {
    material.side = DoubleSide;
  }
  return true;
}

/**
 * `CG_AddRefEntityWithPowerups` (cg_players.c:2138) — the powerup shell.
 *
 * Quake does not tint a player who has picked up the Quad. It draws the model
 * AGAIN, whole, with `ent->customShader` set:
 *
 * ```c
 * trap_R_AddRefEntityToScene( ent );                 // the player
 * if ( state->powerups & ( 1 << PW_QUAD ) ) {
 *     ent->customShader = cgs.media.quadShader;
 *     trap_R_AddRefEntityToScene( ent );             // and again, as a shell
 * }
 * ```
 *
 * That second draw is the blue glow, and it is a *hull* rather than a highlight
 * because of one line in `powerups/quad`:
 *
 * ```
 * deformVertexes wave 100 sin 3 0 0 0
 * ```
 *
 * Amplitude zero, base 3 — a constant 3-unit push along every normal, so the
 * shell is the same model slightly inflated. The stage itself is a
 * `tcGen environment` envmap on `GL_ONE GL_ONE`, which is why it reads as light
 * on the surface rather than as paint.
 *
 * IMPLEMENTATION: the shell meshes SHARE the body's `BufferGeometry`. That is
 * not a saving, it is the mechanism — `AnimPart.update` morphs the position and
 * normal attributes in place every frame, so a shell built on the same buffers
 * animates with the player for free. Building it its own geometry would give a
 * glowing statue standing inside a running man.
 *
 * `castShadow` is explicitly false. The shadow pass draws casters solid black,
 * so an additive shell would put a filled silhouette on the floor 3 units
 * bigger than the player.
 *
 * The shell starts hidden; `visible` is the per-frame switch.
 */
export async function buildPowerupShell(
  fs: Pk3FileSystem,
  ctx: Md3ShaderContext,
  shaderName: string,
  parts: readonly LoadedMd3[],
): Promise<Object3D[]> {
  const shader = ctx.shaders.get(shaderKey(shaderName));
  if (!shader) {
    // No shell shader in the mounted paks. The powerup still works; it simply
    // has no visible aura, which is far better than a grey box round the
    // player.
    return [];
  }

  const shells: Object3D[] = [];
  // Fresh uniforms rather than the model's own: these shaders carry no rgbGen,
  // so the shell is unlit by design and must not follow the body's lighting.
  const light = makeLightUniforms();

  for (const part of parts) {
    for (const mesh of part.meshes) {
      const material = new MeshBasicNodeMaterial({ color: 0xffffff });
      if (!(await applyModelShader(fs, material, shader, ctx, light))) {
        continue;
      }
      // `RB_StageIteratorGeneric` never writes depth for an additive pass, and
      // a shell that did would z-fight with the body it encloses.
      material.depthWrite = false;

      const shell = new Mesh(mesh.geometry, material);
      shell.name = `${mesh.name}.shell`;
      shell.castShadow = false;
      shell.visible = false;
      // After the body, which is the order the two AddRefEntityToScene calls
      // are made in.
      shell.renderOrder = (mesh.renderOrder || 0) + 1;
      (mesh.parent ?? part.object).add(shell);
      shells.push(shell);
    }
  }

  return shells;
}

/** Apply an MD3 tag's origin and axis to an Object3D. */
export function applyTag(object: Object3D, tag: Md3Tag): void {
  // MD3 axes are three basis vectors in Quake's coordinate system, which is the
  // system the world group already uses, so they go in unchanged.
  const m = new Matrix4();
  m.set(
    tag.axis[0][0], tag.axis[1][0], tag.axis[2][0], tag.origin[0],
    tag.axis[0][1], tag.axis[1][1], tag.axis[2][1], tag.origin[1],
    tag.axis[0][2], tag.axis[1][2], tag.axis[2][2], tag.origin[2],
    0, 0, 0, 1,
  );
  object.matrixAutoUpdate = false;
  object.matrix.copy(m);
  object.matrixWorld.copy(m);
}

export interface PlayerModel {
  /** Parent this into the world; it sits at the player's origin. */
  object: Group;
  legs: LoadedMd3;
  torso: LoadedMd3;
  head: LoadedMd3 | null;
}

/**
 * Every player appearance in the mounted paks, as `model` or `model/skin`.
 *
 * Quake players are a model plus a skin, and the skin is not cosmetic trivia —
 * several of the characters people name are skins, not models. `phobos` is
 * `doom/phobos`: `models/players/doom/{lower,upper,head}_phobos.skin`. Listing
 * directories alone finds the models and silently misses half the roster.
 */
export function listPlayerModels(fs: Pk3FileSystem): string[] {
  const names = new Set<string>();

  for (const path of fs.list({ prefix: 'models/players/' })) {
    const dir = /^models\/players\/([^/]+)\//.exec(path);
    if (!dir) {
      continue;
    }
    // A directory only counts if it actually has legs to stand on.
    if (path.endsWith('/lower.md3')) {
      names.add(dir[1]);
    }
    // lower_<skin>.skin is the authoritative marker: every drawable skin has
    // one, and the head/upper files do not always agree.
    const skin = /\/lower_([^/]+)\.skin$/.exec(path);
    if (skin && skin[1] !== 'default') {
      names.add(`${dir[1]}/${skin[1]}`);
    }
  }

  return [...names].sort();
}

/** Split `model/skin` into its parts, defaulting the skin. */
export function splitPlayerName(name: string): { model: string; skin: string } {
  const slash = name.indexOf('/');
  return slash === -1
    ? { model: name, skin: 'default' }
    : { model: name.slice(0, slash), skin: name.slice(slash + 1) };
}

/**
 * Pick a player model, preferring the caller's choice.
 *
 * The default is `phobos`, a skin of the `doom` model — both retail baseq3
 * content — but not every mounted pak set carries it (an OpenArena-only
 * setup has its own roster, not id's). Rather than fail or silently
 * substitute, this walks a preference list and reports what it actually picked,
 * so a missing model looks like a missing model instead of a broken renderer.
 */
export function choosePlayerModel(
  fs: Pk3FileSystem,
  preferred: readonly string[],
): { name: string; available: string[]; fallback: boolean } | null {
  const available = listPlayerModels(fs);
  if (!available.length) {
    return null;
  }
  for (let i = 0; i < preferred.length; i++) {
    const wanted = preferred[i].toLowerCase();
    const hit = available.find((n) => n.toLowerCase() === wanted);
    if (hit) {
      return { name: hit, available, fallback: i > 0 };
    }
  }
  return { name: available[0], available, fallback: true };
}

/**
 * Load a Quake III player: `models/players/<name>/{lower,upper,head}.md3`,
 * chained through tag_torso and tag_head.
 */
export async function loadPlayerModel(
  fs: Pk3FileSystem,
  name: string,
  skinName = 'default',
  /**
   * The shader context, if the player should composite shaders and take fog.
   *
   * Omitting it was not a decision, it was an oversight: every player model
   * loaded with `ctx = null`, so a skin naming a real `.shader` fell through to
   * the plain-texture path and no player could ever be fogged. Optional so the
   * tests, which have no pak and no clock, keep working.
   */
  ctx: Md3ShaderContext | null = null,
): Promise<PlayerModel | null> {
  const dir = `models/players/${name}`;

  const readSkin = async (part: string): Promise<Skin | null> => {
    const text = await fs.readText(`${dir}/${part}_${skinName}.skin`);
    return text ? parseSkin(text) : null;
  };

  const legs = await loadMd3(fs, `${dir}/lower.md3`, await readSkin('lower'), ctx);
  const torso = await loadMd3(fs, `${dir}/upper.md3`, await readSkin('upper'), ctx);
  if (!legs || !torso) {
    return null;
  }
  const head = await loadMd3(fs, `${dir}/head.md3`, await readSkin('head'), ctx);

  const object = new Group();
  object.add(legs.object);

  // The torso hangs off the legs' tag_torso, and the head off the torso's
  // tag_head. Parenting them means three composes the transforms.
  const torsoTag = findTag(legs.model, 0, 'tag_torso');
  if (torsoTag) {
    applyTag(torso.object, torsoTag);
  }
  legs.object.add(torso.object);

  if (head) {
    const headTag = findTag(torso.model, 0, 'tag_head');
    if (headTag) {
      applyTag(head.object, headTag);
    }
    torso.object.add(head.object);
  }

  return { object, legs, torso, head };
}
