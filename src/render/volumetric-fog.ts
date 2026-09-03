/**
 * Raymarched fog volumes.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * **Not Quake.** `fog.ts` is the port; this is the Modern-mode alternative to
 * it, and `.agent/plans/VOLUMETRIC-FOG.md` is the plan it was built from.
 *
 * ## It reuses the volumes and none of the drawing
 *
 * `loadFogs` already produces exactly what a marcher needs, and needed no new
 * fields: `bounds` is the box to intersect, `color` is what scatters, and
 * `depthForOpaque` converts straight into an extinction coefficient. What it
 * does NOT use is `surface` -- the visible-side plane exists to clip
 * `RB_FogPass`'s ray fraction, and a march clips against the box itself.
 *
 * Everything downstream of `loadFogs` has to be switched OFF, not merely left
 * alone: `fogIndexOf`, `fogPassOf`, the per-batch fog mesh, `entityFogNum` and
 * `applyEntityFog`. Those exist because `RB_FogPass` is a second pass per
 * surface, gated on the `fogNum` the compiler wrote into each `dsurface_t`. A
 * march is screen space and never asks which surface is inside. Run both and
 * every fogged surface is tinted twice.
 *
 * One thing this gets that `RB_FogPass` never had: `GeneratePermanentShader`
 * gives a translucent non-fog shader **no fog pass at all**, so in Quake the
 * glass, blended grates and lamp glows inside a volume stand out unfogged
 * (see `render-gotchas.md`). A march does not know they are special. That is a
 * behaviour change and an improvement, and one more reason the two paths
 * cannot be mixed.
 */

import { Vector3 } from 'three/webgpu';
import type { Camera, Node } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  exp,
  float,
  max,
  min,
  screenUV,
  select,
  triNoise3D,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { fogColor } from './fog.js';
import type { Fog } from './fog.js';

/** A float-valued TSL node. */
type FloatNode = Node<'float'>;

/**
 * The transmittance `depthForOpaque` is taken to mean.
 *
 * Quake's number is a distance at which the fog is "opaque", and its own curve
 * reaches exactly 1.0 there. Beer-Lambert never does -- `exp(-x)` has no zero
 * -- so "opaque" has to be given a value, and 2% transmitted is the usual
 * reading of it. The choice only scales `sigma`; `?fogdensity` moves it.
 */
export const OPAQUE_TRANSMITTANCE = 0.02;

/**
 * `fogParms`' `depthForOpaque`, as a Beer-Lambert extinction coefficient.
 *
 * `T = exp(-sigma * d)`, so `sigma = -ln(T) / depthForOpaque` puts 98%
 * extinction exactly where the mapper put it. This is the whole reason to
 * reuse the authored volumes: the density comes out of the map rather than out
 * of a knob, and q3dm7's two pools stay as different from each other as their
 * author made them (`hellfogdense` at 128 units, `fog_intel` at 800).
 *
 * `depthForOpaque` is floored at 1 the way `R_LoadFogs` floors it, so a broken
 * shader cannot divide by zero here.
 */
export function fogExtinction(depthForOpaque: number, density = 1): number {
  const d = depthForOpaque < 1 ? 1 : depthForOpaque;
  return (-Math.log(OPAQUE_TRANSMITTANCE) / d) * density;
}

/** An axis-aligned box in three's Y-up world space. */
export interface FogBox {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * A volume's bounds, brought from Q3's Z-up space into three's Y-up one.
 *
 * The renderer's world Group carries a single `rotation.x = -PI/2`, so the map
 * from Q3 to three is `(x, y, z) -> (x, z, -y)` -- the same swizzle `fog.ts`
 * inverts for its plane test.
 *
 * **The negated axis swaps min and max**, and that is the trap this function
 * exists for. Q3's `mins.y` is the LARGER three-space z once negated, so a
 * componentwise swizzle of both corners produces a box whose `min` is not
 * below its `max` on that axis -- and a slab test against such a box misses
 * every ray, silently, with no fog and no error. Recomposing with `Math.min`
 * and `Math.max` per component is proof against it whatever the swizzle does.
 */
export function fogBox(fog: Fog): FogBox {
  const [q3Min, q3Max] = fog.bounds;
  const three = (v: readonly number[]): [number, number, number] => [v[0], v[2], -v[1]];
  const a = three(q3Min);
  const b = three(q3Max);
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

/**
 * Ray/box slab test. Returns the entry and exit distances along `dir`, or null
 * when the ray misses.
 *
 * The CPU twin of the node version below -- it exists so the geometry can be
 * tested headlessly, which the march itself cannot be. `dir` need not be
 * normalised, but the returned distances are in units of `dir`'s length, so
 * the caller wants it normalised if it wants world units.
 *
 * Entry is clamped at 0: a ray that starts INSIDE the box enters it at the
 * eye, which is the case that matters most here -- the player standing in the
 * fog is exactly it.
 */
export function slab(
  origin: readonly number[],
  dir: readonly number[],
  box: FogBox,
): [number, number] | null {
  let t0 = 0;
  let t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    // A component of exactly zero is a ray parallel to that pair of planes:
    // either it is between them, and they constrain nothing, or it is outside
    // and nothing can bring it back. `1 / 0` is `Infinity` here rather than a
    // division error, and both cases fall out of the comparisons correctly --
    // except `0 * Infinity`, which is why the parallel case is taken first.
    if (dir[i] === 0) {
      if (origin[i] < box.min[i] || origin[i] > box.max[i]) {
        return null;
      }
      continue;
    }
    const inv = 1 / dir[i];
    const a = (box.min[i] - origin[i]) * inv;
    const b = (box.max[i] - origin[i]) * inv;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t1 > t0 ? [t0, t1] : null;
}

/**
 * What the march accumulates, as shader-side variables.
 *
 * Threaded through every volume in the map so two overlapping fogs compose
 * with each other rather than each compositing over the raw scene.
 */
interface MarchState {
  transmittance: ReturnType<FloatNode['toVar']>;
  scattered: ReturnType<Node<'vec3'>['toVar']>;
  /** Total distance spent inside any volume. `?fogdebug=span` only. */
  span: ReturnType<FloatNode['toVar']>;
  /** Nearest entry distance over all volumes. `?fogdebug=enter` only. */
  enter: ReturnType<FloatNode['toVar']>;
}

/** Tunables for the march. See `.agent/plans/VOLUMETRIC-FOG.md`. */
export interface VolumetricOptions {
  /** `?fogsteps` — march steps per volume. */
  steps: number;
  /** `?fogdensity` — multiplier on the `depthForOpaque`-derived extinction. */
  density: number;
  /** `?fognoise` — how much the density varies, 0..1. 0 is homogeneous. */
  noise: number;
  /** `?fognoisescale` — noise features per this many Q3 units. */
  noiseScale: number;
  /** `?fognoisespeed` — how fast the noise drifts. */
  noiseSpeed: number;
  /**
   * `?fogdebug` — put an intermediate of the march on the screen instead of
   * the game.
   *
   * A march cannot be stepped and prints nothing, so when it produces an empty
   * picture there is no way to tell WHICH of the ray, the box or the
   * accumulation is wrong. Same tool, and same reasoning, as `?ssaodebug`.
   */
  debug: VolumetricDebug;
}

/**
 * `off`, or the intermediate to display:
 *
 * - `dir` the world-space view ray, as a colour
 * - `dist` distance to the first opaque surface, over 2048 units
 * - `span` how far the ray travels inside fog, over 512 units
 * - `alpha` how much fog the march accumulated, which is `1 - transmittance`
 */
export type VolumetricDebug = 'off' | 'dir' | 'dist' | 'span' | 'alpha' | 'origin' | 'enter';

const VOLUMETRIC_DEBUG: readonly VolumetricDebug[] = [
  'off',
  'dir',
  'dist',
  'span',
  'alpha',
  'origin',
  'enter',
];

export const DEFAULT_VOLUMETRIC_OPTIONS: VolumetricOptions = {
  steps: 16,
  density: 1,
  noise: 0.6,
  noiseScale: 192,
  noiseSpeed: 0.05,
  debug: 'off',
};

function num(params: URLSearchParams, key: string, fallback: number, minimum = 0): number {
  const raw = params.get(key);
  if (raw === null) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < minimum) {
    console.warn(`[overbounce] ignoring ?${key}=${raw}: expected a number >= ${minimum}`);
    return fallback;
  }
  return n;
}

export function parseVolumetricOptions(params: URLSearchParams): VolumetricOptions {
  const d = DEFAULT_VOLUMETRIC_OPTIONS;
  // A zero step count is not a cheaper march, it is no fog at all; one step is
  // a single slab and reads as a flat card. Two is the floor.
  const steps = Math.round(num(params, 'fogsteps', d.steps, 2));
  return {
    steps: steps < 2 ? d.steps : steps,
    density: num(params, 'fogdensity', d.density),
    // Above 1 the density would go negative between features.
    noise: Math.min(1, num(params, 'fognoise', d.noise)),
    noiseScale: Math.max(1, num(params, 'fognoisescale', d.noiseScale)),
    noiseSpeed: num(params, 'fognoisespeed', d.noiseSpeed),
    debug: parseDebug(params),
  };
}

function parseDebug(params: URLSearchParams): VolumetricDebug {
  const raw = params.get('fogdebug');
  if (raw === null) {
    return 'off';
  }
  const mode = raw.toLowerCase() as VolumetricDebug;
  if (VOLUMETRIC_DEBUG.includes(mode)) {
    return mode;
  }
  console.warn(`[overbounce] ignoring ?fogdebug=${raw}: expected ${VOLUMETRIC_DEBUG.join(', ')}`);
  return 'off';
}

/** A direction with no component so close to zero that `1/x` blows up. */
function safeDir(dir: Node<'vec3'>): Node<'vec3'> {
  const eps = 1e-6;
  const guard = (c: FloatNode): FloatNode =>
    select(c.abs().lessThan(eps), float(eps), c);
  return vec3(guard(dir.x), guard(dir.y), guard(dir.z));
}

/**
 * `slab` as a node. Returns `(tEnter, tExit)`; the ray misses when
 * `tExit <= tEnter`, which the caller tests rather than branching here.
 */
function slabNode(
  origin: Node<'vec3'>,
  dir: Node<'vec3'>,
  boxMin: Node<'vec3'>,
  boxMax: Node<'vec3'>,
): { enter: FloatNode; exit: FloatNode } {
  const inv = vec3(1, 1, 1).div(safeDir(dir));
  const a = boxMin.sub(origin).mul(inv);
  const b = boxMax.sub(origin).mul(inv);
  const lo = min(a, b) as Node<'vec3'>;
  const hi = max(a, b) as Node<'vec3'>;
  return {
    // `.max(0)` is the CPU twin's "a ray that starts inside enters at the eye".
    enter: max(max(lo.x, lo.y), lo.z).max(0) as FloatNode,
    exit: min(min(hi.x, hi.y), hi.z) as FloatNode,
  };
}

/**
 * The view ray for this fragment, in three's world space, and how far along it
 * the scene is.
 *
 * **THE CAMERA HAS TO BE PASSED IN.** TSL's ambient `cameraPosition`,
 * `cameraWorldMatrix` and `cameraProjectionMatrixInverse` resolve to whatever
 * camera is drawing the current pass -- and a post stage is a fullscreen quad
 * drawn with the post processor's OWN camera, not the scene's. Built on those,
 * every ray came out of the quad's camera, missed every box, and the fog
 * simply did not appear: no error, no warning, an empty picture. `ao()` takes
 * a `camera` argument for exactly this reason, and so does this.
 *
 * `projectionMatrixInverse` and `matrixWorld` are objects three mutates in
 * place, so holding them in uniforms tracks the camera without a callback.
 *
 * `viewZ` is the pass's own view-space depth, negative in front of the camera.
 * The direction is normalised in VIEW space and then rotated to world, which
 * is why `distance` can be recovered as `viewZ / dir.z`: the view->world
 * transform is rigid, so a length in one is a length in the other.
 */
function viewRay(
  viewZ: FloatNode,
  camera: Camera,
): {
  origin: Node<'vec3'>;
  dir: Node<'vec3'>;
  distance: FloatNode;
} {
  const projInverse = uniform(camera.projectionMatrixInverse) as unknown as Node<'mat4'>;
  const camWorld = uniform(camera.matrixWorld) as unknown as Node<'mat4'>;

  /*
   * Screen UV to NDC. The z does not matter: any point on the ray gives the
   * same direction once the perspective divide is done.
   *
   * **Y IS FLIPPED**, and it has to be measured rather than reasoned about.
   * `screenUV`'s vertical origin does not agree with NDC's here, so
   * `2v - 1` produces a ray pointing DOWN at the top of the screen and UP at
   * the bottom. Nothing about that looks wrong on its own -- the directions
   * are still unit length and still sweep smoothly -- and the only symptom is
   * that a camera above a fog volume never enters it, because every ray that
   * should have descended into the box climbs away from it instead. The fog
   * then does not appear at all, with no error anywhere.
   *
   * `?fogdebug=dir` is what settled it: the top of the frame read -0.6 on Y
   * where it had to read +0.6.
   */
  const ndc = vec4(screenUV.x.mul(2).sub(1), screenUV.y.mul(-2).add(1), float(0), float(1));
  const view = projInverse.mul(ndc) as Node<'vec4'>;
  const dirView = view.xyz.div(view.w).normalize();
  const dirWorld = (camWorld.mul(vec4(dirView, 0)) as Node<'vec4'>).xyz;
  return {
    // The world matrix's translation column IS the camera's world position.
    origin: (camWorld.mul(vec4(0, 0, 0, 1)) as Node<'vec4'>).xyz,
    dir: dirWorld,
    // Both are negative in front of the camera, so this comes out positive.
    distance: viewZ.div(dirView.z) as FloatNode,
  };
}

/**
 * One volume's contribution, marched.
 *
 * Beer-Lambert, front to back: each step attenuates what is behind it and adds
 * its own scattered light, weighted by how much of the ray has already been
 * absorbed. The two are accumulated into `state`, which the caller threads
 * through every volume so that two overlapping fogs compose correctly rather
 * than each compositing over the raw scene.
 *
 * **`state` holds `toVar()` nodes and the loop assigns to them.** A `Loop`
 * callback runs ONCE, at graph-build time, to emit the body -- so reassigning
 * an ordinary JavaScript variable inside it accumulates nothing: every
 * iteration would re-evaluate one emitted expression against the same inputs
 * and the fog would come out as a single step's worth however many steps were
 * asked for. Shader-side variables and `addAssign`/`mulAssign` are what make
 * the iterations actually compose.
 *
 * **The noise is the feature.** Homogeneous density integrates to exactly the
 * analytic answer, so without a varying density this is a slower way to draw
 * the picture `fog.ts` already draws. `triNoise3D` is modulated about a mean of
 * 1, so the AVERAGE density still matches `depthForOpaque` and a volume still
 * goes opaque where its author said it would.
 */
function marchVolume(
  fog: Fog,
  ray: { origin: Node<'vec3'>; dir: Node<'vec3'>; distance: FloatNode },
  options: VolumetricOptions,
  time: FloatNode,
  state: MarchState,
): void {
  const box = fogBox(fog);
  const boxMin = uniform(new Vector3(...box.min)) as unknown as Node<'vec3'>;
  const boxMax = uniform(new Vector3(...box.max)) as unknown as Node<'vec3'>;
  const colour = uniform(fogColor(fog)) as unknown as Node<'vec3'>;
  const sigma = float(fogExtinction(fog.depthForOpaque, options.density));

  const { enter, exit } = slabNode(ray.origin, ray.dir, boxMin, boxMax);
  // The scene stops the march: fog behind a wall is not seen through it.
  const far = min(exit, ray.distance) as FloatNode;
  // Zero when the ray misses the box, or when the box is entirely behind the
  // first opaque surface. Every pixel outside a fog brush lands here, which is
  // what makes marching the authored volumes cheap in a way a whole-map fog
  // would not be.
  const span = far.sub(enter).max(0);
  const ds = span.div(options.steps);
  state.span.addAssign(span);
  state.enter.assign(min(state.enter, enter));

  /*
   * A DITHERED start offset. On a fixed step grid every pixel samples the
   * noise at the same phase, and the volume comes out as a stack of visible
   * shells. Offsetting the first sample by a per-pixel fraction of one step
   * turns that banding into film grain, which the eye forgives.
   *
   * The hash is the usual screen-space one. It does not need to be a good
   * random number; it needs to decorrelate neighbouring pixels, and any
   * high-frequency function of the pixel coordinate does that.
   */
  const dither = screenUV.dot(vec2(12.9898, 78.233)).sin().mul(43758.5453).fract();

  const scale = float(1 / options.noiseScale);

  /*
   * SKIP THE LOOP WHERE THERE IS NO FOG, and this is the cost story.
   *
   * A fog brush is a box in a room, so most of the screen is pixels whose ray
   * never enters it -- the ceiling, the walls above it, everything behind an
   * occluder. Marching those is `steps` iterations of a 3D noise for a
   * guaranteed zero. The GPU still pays for any quad where a single lane is
   * inside, so this is not free divergence-wise, but whole tiles of sky and
   * ceiling drop out entirely.
   */
  If(span.greaterThan(0), () => {
    Loop(options.steps, ({ i }) => {
      const t = enter.add(ds.mul(float(i).add(dither)));
      const p = ray.origin.add(ray.dir.mul(t));

      /*
       * Density about a mean of 1. `triNoise3D` is roughly 0..1 with a mean near
       * a half, so `1 + noise * (2n - 1)` keeps the average at 1 and never goes
       * negative for `noise <= 1` -- which is why `parseVolumetricOptions` clamps
       * it there.
       */
      const n = triNoise3D(p.mul(scale), float(options.noiseSpeed), time) as FloatNode;
      const density =
        options.noise > 0
          ? float(1).add(n.mul(2).sub(1).mul(options.noise))
          : float(1);

      const stepSigma = sigma.mul(density);
      // How much of THIS step's light survives it.
      const stepT = exp(stepSigma.mul(ds).negate()) as FloatNode;
      const absorbed = float(1).sub(stepT);

      // Order matters: this step's light is attenuated by everything BEFORE it,
      // so the scattering is added at the transmittance the ray arrives with and
      // only then is the transmittance reduced.
      state.scattered.addAssign(colour.mul(absorbed).mul(state.transmittance));
      state.transmittance.mulAssign(stepT);
    });
  });
}

/**
 * Composite every volume in the map over `color`.
 *
 * Returns `color` unchanged when the map has no fog volumes, so a map without
 * fog brushes costs nothing at all -- not a march that always misses, but no
 * stage in the graph.
 */
export function volumetricFogNode(
  color: Node<'vec4'>,
  viewZ: FloatNode,
  camera: Camera,
  fogs: readonly (Fog | null)[],
  options: VolumetricOptions,
  time: FloatNode,
): Node<'vec4'> {
  const volumes = fogs.filter((f): f is Fog => f !== null);
  if (!volumes.length) {
    return color;
  }

  /*
   * THE WHOLE MARCH LIVES INSIDE AN `Fn`, and it is not a matter of taste.
   *
   * `toVar()` declares a shader-side variable and `assign`/`addAssign` produce
   * statements -- and a TSL statement is only emitted if it is appended to the
   * builder's stack, which is something `Fn` sets up and plain JavaScript
   * function calls do not. Written at the top level of an ordinary function
   * every assignment here is simply discarded: the variables keep their
   * initialisers, `transmittance` stays 1, `scattered` stays black, and the
   * stage composites the scene over itself.
   *
   * That failure is invisible from the outside. The graph compiles, the pass
   * runs and costs GPU time, and the picture is exactly the one with no fog in
   * it -- which is indistinguishable from the volumes never having loaded.
   * `?fogdebug=span` reading a flat zero while `?fogdebug=dir` and
   * `?fogdebug=dist` both read correctly is the signature.
   */
  const marched = Fn(() => {
    const ray = viewRay(viewZ, camera);
    const state: MarchState = {
      transmittance: float(1).toVar('fogTransmittance'),
      scattered: vec3(0, 0, 0).toVar('fogScattered'),
      span: float(0).toVar('fogSpan'),
      enter: float(1e9).toVar('fogEnter'),
    };
    for (const fog of volumes) {
      marchVolume(fog, ray, options, time, state);
    }

    if (options.debug !== 'off') {
      return debugView(options.debug, ray, state);
    }

    // Standard over-composite: what got through, plus what scattered on the
    // way.
    return vec4(color.rgb.mul(state.transmittance).add(state.scattered), color.a);
  });

  return marched() as Node<'vec4'>;
}

/** `?fogdebug` — see `VolumetricDebug`. */
function debugView(
  mode: VolumetricDebug,
  ray: { origin: Node<'vec3'>; dir: Node<'vec3'>; distance: FloatNode },
  state: MarchState,
): Node<'vec4'> {
  const grey = (v: FloatNode): Node<'vec4'> => vec4(v, v, v, float(1));
  switch (mode) {
    case 'dir':
      // A correct ray sweeps smoothly across the frame. A flat field means the
      // camera the ray was built from is not the one drawing the scene.
      return vec4(ray.dir.mul(0.5).add(0.5), float(1));
    case 'dist':
      return grey(ray.distance.div(2048) as FloatNode);
    case 'span':
      // Black everywhere means the slab test never hits: suspect the box, or
      // the space it is in.
      return grey(state.span.div(512) as FloatNode);
    case 'origin':
      // The camera's world position, over 2048 and biased. Flat mid-grey means
      // the matrix uniform is a snapshot from before the camera was placed.
      return vec4(ray.origin.div(2048).mul(0.5).add(0.5), float(1));
    case 'enter':
      return grey(state.enter.div(2048) as FloatNode);
    default:
      return grey(float(1).sub(state.transmittance) as FloatNode);
  }
}
