/**
 * Real shadow maps, steered by the BSP light grid.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * THIS IS AN ADDITION, NOT A PORT. Quake III has no shadow maps: `cg_shadows`
 * offers a blob (1), a stencil volume (2) and a projection (3), and the shipped
 * default is the blob in `shadow.ts`. Nothing here is claimed to be faithful.
 *
 * ## Where the light comes from
 *
 * A Quake map has no sun, so there is no obvious thing to hang a shadow-casting
 * directional light on -- except that the compiler already baked a dominant
 * light direction for every point in the map. `R_SetupEntityLightingGrid` is
 * what shades models, and `sampleLightGrid().dir` is its answer to "which way is
 * the light from here". Steering a directional light by that gives a shadow
 * derived from the map's own lighting rather than from an invented sun, and it
 * works on any map without authoring.
 *
 * The cost of that idea is that the direction MOVES. Grid cells are 64x64x128
 * units, so a running player crosses one every few tenths of a second and the
 * dominant direction can turn sharply at the boundary. Three things keep that
 * from reading as a swinging, swimming shadow, and all three are load-bearing:
 *
 *  1. `steerShadowDirection` damps the direction with an exponential filter, so
 *     a cell boundary is a slow lean rather than a snap.
 *  2. It also CLAMPS the elevation. Quake's lights are mostly wall lamps, so the
 *     grid direction is often near-horizontal, and a near-horizontal light
 *     throws a shadow that smears to the edge of the map and grazes the floor at
 *     an angle that is pure shadow acne. `minElevation` refuses to let the sun
 *     get that low.
 *  3. `snapShadowCenter` quantizes the shadow camera's position to whole shadow
 *     texels. Without it the projection slides by a fraction of a texel every
 *     frame and the shadow's edge crawls even when nothing is moving. That
 *     shimmer is easy to blame on the grid; it is not the grid.
 *
 * ## How a shadow gets received at all
 *
 * Every material in this renderer is `MeshBasicNodeMaterial` -- unlit, because
 * Quake's lighting is baked -- so three's automatic light path never runs and a
 * surface will not receive a shadow by itself. `addReceiver` therefore rewrites
 * each opaque material's `colorNode` to multiply its RGB by a shadow factor:
 *
 *     colorNode  ->  vec4( colorNode.rgb * mix(1 - strength, 1, shadow(light)),
 *                          colorNode.a )
 *
 * Two consequences worth stating rather than discovering:
 *
 *  - The wrap sits OUTSIDE everything `bsp-mesh.ts` composited, so it also
 *    darkens the folded `RB_FogPass` mix and the dynamic-light add. For an
 *    addition that is acceptable; for a port it would not be.
 *  - `shadow()`'s frustum test returns 1 outside the shadow camera's box, so a
 *    surface more than `extent` units from the player is provably untouched.
 *    That is what keeps a small ortho box honest: it is not "the shadow fades
 *    out over there", it is "there is no shadow term over there".
 *
 * Only opaque materials receive. Additive glows, `blendfunc filter` decals and
 * alpha-blended sheets all set `transparent = true` (see `blend.ts`), and
 * shading a lamp's own corona darker because the player walked in front of it is
 * wrong in a way a floor is not.
 *
 * Casting is the same rule from the other side: the shadow pass draws casters
 * with a solid black override material, so a transparent shell -- the health
 * and powerup spheres -- would cast an opaque disc. `castsShadow()` is the test,
 * and `md3-mesh.ts` applies it when it builds a surface, which is why every
 * model in the game casts without anything having to register it.
 *
 * Everything here is Quake space (Z-up); the light and its target live under the
 * scene's world group, which carries the single rotation into three's Y-up.
 *
 * ## Wiring
 *
 * Four calls in `main.ts`, and the blob has to be suppressed in `dynamic` mode
 * because two shadows under one player double-darken and read as a bug:
 *
 * ```ts
 * const shadowOptions = parseShadowOptions(window.location.search);
 *
 * // ... where createBlobShadow is called:
 * const blobShadow =
 *   shadowOptions.mode === 'blob' ? await createBlobShadow(paks) : null;
 *
 * // ... after the world surfaces are added to the scene:
 * const shadows =
 *   shadowOptions.mode === 'dynamic'
 *     ? createDynamicShadows({ renderer: r.renderer, world: r.world, options: shadowOptions })
 *     : null;
 * shadows?.addReceiver(surfaces.object);
 *
 * // ... once per frame, next to the blob's trace:
 * shadows?.update(o, sampleLightGrid(lightGrid, [o[0], o[1], o[2]]).dir, dtMs);
 * ```
 *
 * Nothing registers casters: `md3-mesh.ts` marks every opaque model surface it
 * builds, and the flag is inert until this module turns shadow mapping on.
 *
 * Findings, the measured direction statistics and the cost numbers are in
 * `.agent/docs/shadow-maps.md`.
 */

import { DirectionalLight, PCFSoftShadowMap } from 'three/webgpu';
import type { Group, Material, Mesh, Object3D, WebGPURenderer } from 'three/webgpu';
import { mix, nodeObject, shadow, uniform, vec4 } from 'three/tsl';

/**
 * What `?shadows=` selects.
 *
 * - `blob`    -- `CG_PlayerShadow` only. Quake's own `cg_shadows 1`.
 * - `dynamic` -- this module: a real shadow map, plus no blob (two shadows
 *                under one player double-darken and read as a bug).
 * - `off`     -- neither.
 */
export type ShadowMode = 'blob' | 'dynamic' | 'off';

export interface ShadowOptions {
  mode: ShadowMode;
  /**
   * How dark a fully occluded pixel goes, 0..1. 1 would be black.
   *
   * Deliberately low. Overbounce spots are judged by eye from sub-unit
   * geometry, and a shadow that swallows the line where a ledge meets a floor
   * costs more than it gives -- the same argument that caps SSAO in `post.ts`.
   */
  strength: number;
  /** Half-width of the shadow camera's box, in Q3 units (~inches). */
  extent: number;
  /** Shadow map edge length in texels. */
  size: number;
  /**
   * Floor on the light direction's Z component, 0..1.
   *
   * `dir` points AT the light. Quake's grid directions are frequently
   * near-horizontal because Quake's lights are wall lamps, and a shadow cast
   * along the floor is both enormous and full of acne.
   */
  minElevation: number;
  /**
   * Exponential damping time constant in milliseconds for the direction.
   *
   * 0 disables damping, which is the setting that shows what the raw grid
   * direction actually does.
   */
  damping: number;
  /** `LightShadow.bias`, in shadow-map depth units. Negative reduces acne. */
  bias: number;
  /**
   * `LightShadow.normalBias`, in Q3 units.
   *
   * Offsets the lookup along the receiving surface's world normal, which is the
   * better acne fix here: world surfaces carry real normals (the winding oracle
   * in `render-gotchas.md` depends on them) and a normal offset does not
   * detach a shadow from its caster the way a large depth bias does.
   */
  normalBias: number;
  /**
   * `?shadowdebug` -- draw the shadow factor itself instead of the scene.
   *
   * White is lit, black is fully occluded, and everything outside the shadow
   * camera's box is white because `shadow()`'s frustum test says so. The
   * `strength` scaling is deliberately NOT applied to this view -- see `patch`. This is
   * the only way to tell "the shadow is in the wrong place" apart from "the
   * whole receiver is being darkened", which look similar on a dark floor and
   * have completely different causes. Same idea as `?ssaodebug` in `post.ts`.
   */
  debug: boolean;
}

/**
 * Defaults, and why `dynamic` rather than `blob`.
 *
 * The direction was measured before this was chosen, not after. Sampling the
 * grid at every cell a player can actually stand in (`dir.z`, 1 = straight
 * overhead) gives:
 *
 *     map          p25    p50    below 0.5 elevation
 *     q3dm2        0.86   0.96   7%
 *     q3dm4        1.00   1.00   5%
 *     q3dm6        0.94   1.00   4%
 *     q3dm7        0.77   1.00   14%
 *     q3dm17       0.89   0.99   7%
 *     de4th_run1  -0.20   0.88   33%
 *
 * On id's maps the dominant light is near-vertical most of the time, so the
 * shadow sits under the player like the blob does and a change of direction
 * barely moves it. Walking a straight line at 320ups, the damped direction
 * turns a median of ~0 degrees per second on q3dm6 and ~14 on the open floors
 * of q3dm17 and de4th_run1 -- a slow lean, not a swing.
 *
 * de4th_run1 is the case that made the elevation clamp non-optional: a quarter
 * of its standable cells have the dominant light pointing DOWNWARD (lava and
 * floor lights), which without a clamp is a shadow thrown up a wall.
 *
 * `strength` is deliberately low for the same reason SSAO is capped in
 * `post.ts`: an overbounce spot is judged by eye from sub-unit geometry, and a
 * shadow dark enough to hide the line where a ledge meets a floor costs more
 * than it gives.
 *
 * `?shadows=blob` puts Quake's own `cg_shadows 1` back.
 */
export const DEFAULT_SHADOW_OPTIONS: Readonly<ShadowOptions> = {
  mode: 'dynamic',
  strength: 0.35,
  extent: 160,
  size: 1024,
  minElevation: 0.5,
  damping: 250,
  bias: 0,
  normalBias: 4,
  debug: false,
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

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * `?shadows=blob|dynamic|off`, plus the tuning knobs.
 *
 * Same shape as `parsePostOptions`: an unrecognised value warns and keeps the
 * default rather than throwing, because a typo in a URL should not be a blank
 * screen.
 */
export function parseShadowOptions(search: string | URLSearchParams): ShadowOptions {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;

  let mode = DEFAULT_SHADOW_OPTIONS.mode;
  const raw = params.get('shadows');
  if (raw !== null) {
    const v = raw.trim().toLowerCase();
    if (v === 'off' || v === '0' || v === 'none' || v === 'false' || v === 'no') {
      mode = 'off';
    } else if (v === 'dynamic' || v === 'map' || v === 'maps' || v === 'real') {
      mode = 'dynamic';
    } else if (v === '' || v === 'blob' || v === 'on' || v === '1' || v === 'true' || v === 'yes') {
      mode = 'blob';
    } else {
      console.warn(`[overbounce] ignoring ?shadows=${raw}: expected blob, dynamic or off`);
    }
  }

  return {
    mode,
    strength: clamp01(num(params, 'shadowstrength', DEFAULT_SHADOW_OPTIONS.strength)),
    extent: Math.max(16, num(params, 'shadowextent', DEFAULT_SHADOW_OPTIONS.extent)),
    size: Math.max(64, Math.round(num(params, 'shadowsize', DEFAULT_SHADOW_OPTIONS.size))),
    minElevation: clamp01(num(params, 'shadowelev', DEFAULT_SHADOW_OPTIONS.minElevation)),
    damping: Math.max(0, num(params, 'shadowdamp', DEFAULT_SHADOW_OPTIONS.damping)),
    bias: num(params, 'shadowbias', DEFAULT_SHADOW_OPTIONS.bias),
    normalBias: num(params, 'shadownormalbias', DEFAULT_SHADOW_OPTIONS.normalBias),
    debug: params.has('shadowdebug') && params.get('shadowdebug') !== '0',
  };
}

type Vec3 = [number, number, number];

function normalizeOr(x: number, y: number, z: number, fallback: Vec3): Vec3 {
  const len = Math.hypot(x, y, z);
  if (!(len > 1e-6)) {
    return [...fallback];
  }
  return [x / len, y / len, z / len];
}

/**
 * Force a unit direction to point at least `minElevation` above the horizon,
 * keeping its heading.
 *
 * Exported for the test, and separate from the damper because it applies to the
 * raw grid sample as well as to the damped result.
 */
export function clampElevation(dir: readonly number[], minElevation: number): Vec3 {
  const unit = normalizeOr(dir[0], dir[1], dir[2], [0, 0, 1]);
  if (unit[2] >= minElevation) {
    return unit;
  }
  const horizontal = Math.hypot(unit[0], unit[1]);
  if (!(horizontal > 1e-6)) {
    // Straight down at the light, which cannot happen after normalisation
    // unless the sample was degenerate. Straight up is the safe answer.
    return [0, 0, 1];
  }
  // Keep the heading, raise the pitch, stay unit length.
  const scale = Math.sqrt(Math.max(0, 1 - minElevation * minElevation)) / horizontal;
  return [unit[0] * scale, unit[1] * scale, minElevation];
}

/**
 * The longest frame the damper will honour, in milliseconds. See the note
 * inside `steerShadowDirection`.
 */
export const MAX_STEER_STEP_MS = 100;

/**
 * Damp the light direction toward the grid's answer.
 *
 * `current` is last frame's direction, or null on the first frame -- in which
 * case the target is adopted outright rather than eased into from an arbitrary
 * starting vector, which would swing visibly on spawn.
 *
 * The filter is frame-rate independent: `1 - exp(-dt/tau)` is the same lean per
 * millisecond at 60fps and at 240fps. A fixed per-frame lerp is not, and a
 * shadow that settles at a different speed on a faster machine is the same
 * class of mistake as driving pmove from the render clock.
 */
export function steerShadowDirection(
  current: readonly number[] | null,
  target: readonly number[],
  dtMs: number,
  options: { damping: number; minElevation: number },
): Vec3 {
  const want = clampElevation(target, options.minElevation);
  if (!current) {
    return want;
  }

  // A hitch -- a tab switch, a stall, a texture upload -- hands this a dt in the
  // hundreds of milliseconds, which drives alpha to ~1 and makes the light SNAP
  // on the frame the game resumes. Capping the step is the same defence
  // `main.ts` puts on the physics accumulator with `MAX_CATCHUP_MS`: a long
  // frame is a frame that did not happen, not a frame worth that much motion.
  const step = Math.min(Math.max(0, dtMs), MAX_STEER_STEP_MS);
  const alpha = options.damping > 0 ? 1 - Math.exp(-step / options.damping) : 1;
  const blended = normalizeOr(
    current[0] + (want[0] - current[0]) * alpha,
    current[1] + (want[1] - current[1]) * alpha,
    current[2] + (want[2] - current[2]) * alpha,
    want,
  );
  // Normalising a blend of two clamped directions can only raise the
  // elevation, never lower it, but clamping again costs nothing and makes the
  // invariant true by construction rather than by argument.
  return clampElevation(blended, options.minElevation);
}

/**
 * Quantize the shadow camera's centre to whole shadow-map texels.
 *
 * The projection follows the player, so without this every frame samples the
 * casters at a slightly different sub-texel offset and the shadow's edge boils.
 * Snapping is done in the shadow camera's own basis -- which is why this needs
 * the direction as well as the centre.
 *
 * The basis matches the one three builds: `Matrix4.lookAt` takes z as the
 * direction from the target back to the light and derives x from the camera's
 * up vector. The world group's rotation maps three's up (0,1,0) onto Q3's
 * (0,0,1), so the up hint here is Q3 +Z. Cross products survive that rotation,
 * so the two bases agree.
 *
 * Only the two axes across the map are snapped; depth along the light is left
 * alone, since sliding along it does not change which texel a point lands in.
 */
export function snapShadowCenter(
  center: readonly number[],
  dir: readonly number[],
  texel: number,
): Vec3 {
  if (!(texel > 0)) {
    return [center[0], center[1], center[2]];
  }
  const d = normalizeOr(dir[0], dir[1], dir[2], [0, 0, 1]);

  // right = up x dir, with up = +Z.
  let rx = -d[1];
  let ry = d[0];
  let rz = 0;
  const rlen = Math.hypot(rx, ry, rz);
  if (!(rlen > 1e-6)) {
    // Light straight overhead: any horizontal basis will do.
    rx = 1;
    ry = 0;
    rz = 0;
  } else {
    rx /= rlen;
    ry /= rlen;
    rz /= rlen;
  }

  // up' = dir x right, already unit for orthonormal inputs.
  const ux = d[1] * rz - d[2] * ry;
  const uy = d[2] * rx - d[0] * rz;
  const uz = d[0] * ry - d[1] * rx;

  const a = Math.round((center[0] * rx + center[1] * ry + center[2] * rz) / texel) * texel;
  const b = Math.round((center[0] * ux + center[1] * uy + center[2] * uz) / texel) * texel;
  const c = center[0] * d[0] + center[1] * d[1] + center[2] * d[2];

  return [
    rx * a + ux * b + d[0] * c,
    ry * a + uy * b + d[1] * c,
    rz * a + uz * b + d[2] * c,
  ];
}

/**
 * Whether a material may take part in the shadow pass, on either side.
 *
 * `blend.ts` sets `transparent = true` for every Quake blendfunc that is not a
 * plain opaque draw, so this one test covers additive glows, `blendfunc filter`
 * decals and alpha-blended sheets at once. Alpha-TESTED surfaces -- grates,
 * chains -- stay opaque and are included, which is right for a receiver and
 * slightly generous for a caster: the override material has no alpha test, so a
 * grate casts as a solid panel. No model in the rotation is a grate.
 */
export function castsShadow(material: Material | Material[]): boolean {
  if (Array.isArray(material)) {
    return material.every((m) => castsShadow(m));
  }
  return material.transparent !== true;
}

/** A node with `.rgb` and `.a`, which is what every `colorNode` here is. */
type Vec4Node = ReturnType<typeof vec4>;

interface NodeMaterialLike extends Material {
  colorNode?: unknown;
}

export interface DynamicShadows {
  readonly options: Readonly<ShadowOptions>;
  /** The light, exposed for debugging; it is already in the world group. */
  readonly light: DirectionalLight;
  /**
   * Make every opaque material under `root` darken where the shadow map says it
   * is occluded. Call once per root; calling twice would nest the wrap.
   */
  addReceiver(root: Object3D): void;
  /**
   * Mark every opaque mesh under `root` as a caster.
   *
   * `md3-mesh.ts` already flags the meshes it builds, so models are casters
   * without registration. This is for anything else -- a hand-built mesh, or a
   * subtree that appeared after load.
   */
  addCaster(root: Object3D): void;
  /**
   * Point the light and centre its box.
   *
   * `center` is normally the player's origin; `gridDir` is
   * `sampleLightGrid(grid, center).dir`, unmodified -- the damping and the
   * elevation clamp happen here, not at the call site.
   */
  update(center: ArrayLike<number>, gridDir: ArrayLike<number>, dtMs: number): void;
  /** Live tuning handle: 0..1, takes effect on the next frame. */
  setStrength(value: number): void;
  /** The damped direction actually in use, for the HUD or a screenshot log. */
  direction(): Vec3;
  dispose(): void;
}

/**
 * Build the shadow-mapping layer.
 *
 * SIDE EFFECT WORTH KNOWING ABOUT: this turns on `renderer.shadowMap`. It has
 * to happen before any material is patched -- `ShadowNode.setup` returns
 * nothing while shadow mapping is disabled, and a material built in that state
 * bakes with no shadow term and never picks one up.
 *
 * `world` is the scene's Q3-space group; the light and its target are parented
 * to it so their positions can be set in Quake coordinates.
 */
export function createDynamicShadows(params: {
  renderer: WebGPURenderer;
  world: Group;
  options: ShadowOptions;
}): DynamicShadows {
  const { renderer, world, options } = params;

  renderer.shadowMap.enabled = true;
  // Soft PCF: the edge of a 1024-texel map over a 320-unit box is otherwise a
  // hard staircase, and a hard staircase across a floor is exactly the kind of
  // false edge a player reads as geometry.
  renderer.shadowMap.type = PCFSoftShadowMap;

  const light = new DirectionalLight(0xffffff, 1);
  light.name = 'overbounce.gridShadow';
  light.castShadow = true;
  light.shadow.mapSize.set(options.size, options.size);
  light.shadow.bias = options.bias;
  light.shadow.normalBias = options.normalBias;

  /** How far up the light sits from the box centre. */
  const distance = options.extent * 2;

  const cam = light.shadow.camera;
  cam.left = -options.extent;
  cam.right = options.extent;
  cam.top = options.extent;
  cam.bottom = -options.extent;
  cam.near = 1;
  // Deep enough that a caster well above the centre still lands inside the
  // frustum -- a player at the top of a jump is a long way over the floor the
  // box is centred on.
  cam.far = distance + options.extent * 2;
  cam.updateProjectionMatrix();

  world.add(light);
  world.add(light.target);

  /*
   * ONE ShadowNode for the whole game.
   *
   * `shadow(light)` constructs a new node each call and each one renders its
   * own shadow map in `updateBefore` -- the per-frame guard is per instance.
   * Calling it inside the receiver loop would render the map once per material.
   */
  const litFactor = uniform(1);
  const darkFactor = uniform(1 - clamp01(options.strength));
  const shadowNode = shadow(light);
  /*
   * `shadow()` is typed as returning the bare `ShadowNode` class, not the
   * proxied node object the TSL functions take, so `mix` rejects it. It IS a
   * float-valued node at runtime -- `setupShadowFilter` returns
   * `frustumTest.select(filtered, float(1))` -- and `nodeObject` is three's own
   * way of putting the method chaining back on. The cast says only that.
   */
  const shadowFactor = nodeObject(shadowNode) as unknown as typeof litFactor;
  const factor = mix(darkFactor, litFactor, shadowFactor);

  const texel = (options.extent * 2) / options.size;

  let dir: Vec3 = [0, 0, 1];
  let haveDir = false;
  const patched = new WeakSet<Material>();

  const patch = (material: Material): void => {
    if (patched.has(material) || !castsShadow(material)) {
      return;
    }
    const node = (material as NodeMaterialLike).colorNode;
    if (!node) {
      // Nothing composited a colour, so there is nothing to darken. A material
      // relying on `material.color` alone is the missing-texture grey.
      return;
    }
    patched.add(material);
    const base = node as Vec4Node;
    // RGB only. Alpha is what `alphaTest` and `opacityNode` read, and a shadow
    // has no business deciding whether a grate has a hole in it.
    (material as NodeMaterialLike).colorNode = options.debug
      ? // The RAW shadow term, not `factor`. Drawing `factor` here was a trap:
        // it is already scaled by `strength`, so a fully occluded pixel came
        // out at 0.65 grey on a near-white map and the debug view looked like
        // "the shadow is barely working" when the shadow was fine. Black means
        // occluded, and now it actually does.
        vec4(shadowFactor, shadowFactor, shadowFactor, base.a)
      : vec4(base.rgb.mul(factor), base.a);
    material.needsUpdate = true;
  };

  const eachMesh = (root: Object3D, fn: (mesh: Mesh) => void): void => {
    root.traverse((o: Object3D) => {
      const mesh = o as Mesh;
      if (mesh.isMesh && mesh.material) {
        fn(mesh);
      }
    });
  };

  return {
    options,
    light,

    addReceiver(root: Object3D): void {
      eachMesh(root, (mesh) => {
        const m = mesh.material;
        if (Array.isArray(m)) {
          for (const one of m) {
            patch(one);
          }
        } else {
          patch(m);
        }
      });
    },

    addCaster(root: Object3D): void {
      eachMesh(root, (mesh) => {
        mesh.castShadow = castsShadow(mesh.material);
      });
    },

    update(center: ArrayLike<number>, gridDir: ArrayLike<number>, dtMs: number): void {
      dir = steerShadowDirection(
        haveDir ? dir : null,
        [gridDir[0], gridDir[1], gridDir[2]],
        dtMs,
        options,
      );
      haveDir = true;

      const at = snapShadowCenter([center[0], center[1], center[2]], dir, texel);
      light.target.position.set(at[0], at[1], at[2]);
      light.position.set(
        at[0] + dir[0] * distance,
        at[1] + dir[1] * distance,
        at[2] + dir[2] * distance,
      );
    },

    setStrength(value: number): void {
      darkFactor.value = 1 - clamp01(value);
    },

    direction(): Vec3 {
      return [dir[0], dir[1], dir[2]];
    },

    dispose(): void {
      shadowNode.dispose();
      world.remove(light);
      world.remove(light.target);
      light.dispose();
      renderer.shadowMap.enabled = false;
    },
  };
}
