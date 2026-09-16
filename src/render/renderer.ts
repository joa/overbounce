/**
 * WebGPU renderer setup.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import {
  Color,
  Group,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import {
  applyPostColorMapping,
  createPostChain,
  parsePostOptions,
  postIsNoop,
} from './post.js';
import type { PostChain, PostLook, PostOptions, VolumetricFog } from './post.js';
import { freezeTransform } from './transform.js';
import { setTextureAnisotropy } from './md3-mesh.js';

/**
 * Quake (Z-up) to three.js (Y-up): (x, y, z) -> (x, z, -y).
 *
 * The world Group carries this as a rotation for everything parented to it.
 * The CAMERA is not parented to it — three's `lookAt` resolves its target in
 * world space, so a camera inside a rotated group has to be fed rotated targets
 * and a rotated up vector, which is more confusing, not less. Instead the
 * camera stays in scene space and its Q3-space position and target are pushed
 * through this function on the way in.
 *
 * Getting this wrong is silent: the scene still renders, the camera is simply
 * pointing somewhere the geometry is not.
 */
export function q3ToThree(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

export interface Renderer {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /**
   * Everything in Quake coordinates goes under here.
   *
   * Quake 3 is Z-up; three.js is Y-up. This group carries the single rotation
   * that reconciles them, so no conversion happens anywhere else — physics,
   * collision and camera logic all stay in Q3 units and Q3 axes, and only the
   * scene graph knows about three's conventions.
   */
  world: Group;
  /** Which backend actually rendered. "webgpu" or "webgl". */
  backend: string;
  /**
   * Which GPU the adapter is, as the browser reports it: vendor, architecture,
   * description, and `FALLBACK` for a software adapter. For a player's bug
   * report -- "5 fps" says nothing until it says which chip.
   */
  gpu: string;
  /**
   * The post-processing chain, or null when `?post=off` (or when every effect
   * in it is off, which is the same thing and is detected rather than assumed).
   *
   * Null is not a degraded mode: `render()` then makes the literal
   * `renderer.render(scene, camera)` call this project made before there was a
   * chain at all. Anything that only works with a chain is a bug.
   */
  readonly post: PostChain | null;
  /** What the URL asked for, after parsing and clamping. */
  readonly postOptions: Readonly<PostOptions>;
  /**
   * Tears down the current chain and builds a fresh one from `options` --
   * for a settings change while the game is already running, where a page
   * reload is not an option (R8: it would lose whatever `.pk3` files are
   * mounted in memory, forcing the player to re-select them). Every field of
   * `PostOptions` is pure post-processing -- nothing here is baked into a
   * world mesh material the way `shadows`/`water` are, so this alone is
   * enough to make `tonemap`/`ssao`/`aberration`/`lavabloom`/`lavashimmer`/
   * `fxaa` apply live.
   *
   * The one thing this function cannot do for the caller: `markAoWorld`/
   * `markLava` tag geometry on a SPECIFIC chain instance, so a caller holding
   * world surfaces from an earlier `buildWorldSurfaces` call must re-mark
   * them against the new `.post` after calling this -- `main.ts`'s
   * `applyLivePostOptions` is where that happens.
   */
  setPostOptions(options: PostOptions): void;
  /**
   * Move vignette, aberration and exposure without recompiling the chain.
   *
   * Returns **true** when the chain had to be REBUILT anyway -- which happens
   * only when one of the three crossed its on/off boundary, because a stage
   * that is off is not in the chain at all. A true answer means geometry
   * marks are gone and have to be re-applied, exactly as after
   * `setPostOptions`. False means it was a uniform write and nothing moved.
   *
   * This is the call for anything that changes a look value per FRAME: a
   * playback timeline with a keyframed track, or a slider being dragged.
   * `setPostOptions` recompiles, which at 60fps is a shader rebuild per
   * frame.
   */
  setPostLook(look: PostLook): boolean;
  /**
   * Hand the renderer the map's fog volumes, or null to march none.
   *
   * REBUILDS THE POST CHAIN, so anything that tagged geometry on the old one
   * -- `markAoWorld`, `markLava` -- has to be re-tagged against `.post`
   * afterwards, exactly as after `setPostOptions`.
   */
  setFogVolumes(volumetric: VolumetricFog | null): void;
  /**
   * Bring every object's `matrixWorld` up to date, once for the whole frame.
   *
   * Call after the last transform write and before the first pass. `render()`
   * calls it too, so the main pass is never stale; the explicit call exists so
   * that passes drawn BEFORE it -- the portal view -- see this frame's
   * transforms rather than last frame's.
   *
   * Calling it more than once in a frame is free: the second call returns
   * immediately.
   */
  syncScene(): void;
  render(): void;
  /**
   * Resolve once the GPU has finished everything submitted so far.
   *
   * For the ONE caller that needs it: the video export, which reads the
   * canvas back with `new VideoFrame(canvas)` immediately after rendering a
   * frame. `render()` only SUBMITS work -- three's own `renderAsync` is
   * deprecated in favour of exactly this shape -- so without a barrier the
   * export captures whatever the canvas happened to hold, which in a tight
   * loop is a frame the GPU has not drawn yet.
   *
   * That is not theoretical. A 20-second 1080p60 export came out as 1212
   * structurally perfect frames of which only FOUR differed from their
   * predecessor by more than a rounding error: the encoder faithfully
   * recorded the same stale picture 1200 times, at the full requested
   * bitrate, so the file was the right size, the right length and the right
   * resolution, and played as a still. See `.agent/docs/video-export.md`.
   *
   * Resolves immediately when the backend exposes no device, so a WebGL
   * fallback or a stubbed renderer does not hang the export.
   */
  gpuIdle(): Promise<void>;
  resize(): void;
  dispose(): void;
}

/**
 * Q3 units are roughly inches and maps are tens of thousands of units across,
 * so the far plane has to be generous.
 */
const NEAR = 4;
const FAR = 32768;

/**
 * `?aniso`'s default: Quake3e's 8x, clamped to what the device offers.
 * `?aniso=1` is id's (off).
 */
const DEFAULT_ANISOTROPY = 8;

/**
 * The two per-stage limits a shadowed, multi-stage Quake shader runs out of.
 *
 * WebGPU's DEFAULT limits are 16 sampled textures and 16 samplers per shader
 * stage, and a lit surface's fragment stage burns through both faster than it
 * looks. Three binds EVERY casting light's shadow map into EVERY material that
 * takes light, so the shadow count is a floor under every lit shader in the
 * scene before it has bound one texture of its own: one for the grid-steered
 * directional light, plus one per casting spot (`?maplightshadows`), plus one
 * per casting dlight (`?shadowlights`), plus one per world-casting slot. On
 * top of that a Q3 shader can carry a lightmap, a fog texture and half a dozen
 * stages. q3dm1 crossed 17 and Chrome refused the bind group layout:
 *
 *     The number of sampled textures (17) in the Fragment stage exceeds the
 *     maximum per-stage limit (16).
 *
 * That is not a warning. `CreateBindGroupLayout` failing means the pipeline
 * never exists, so the surfaces using it silently do not draw — the exact
 * failure mode `tools/browser/shot.ts` was written to catch.
 *
 * So the fix is the one the error message itself recommends: ask for what the
 * adapter already has. Measured on this machine's compatibility adapter, that
 * takes sampled textures from the default 16 to 48 and leaves samplers at 16
 * — the adapter reports no more than the default there, and asking for
 * exactly what it reports is how this stays correct on hardware where those
 * numbers differ. Samplers are in the list even though they did not move
 * here, because every shadow map brings a comparison sampler along with its
 * texture: raise only textures and the sampler limit is the next one to trip.
 *
 * ONLY THESE TWO. A blanket raise of every limit is not free — a device asks
 * the driver to reserve against each one — and these two are what the failure
 * is made of.
 *
 * A key missing from `adapter.limits` is skipped rather than defaulted: an
 * unknown key in `requiredLimits` makes `requestDevice` reject, which fails
 * the whole renderer. Skipping means such a browser keeps the default limit
 * and gets the original error back on a heavy map — degraded, not broken,
 * which is the right way round.
 */
function sampledTextureLimits(adapter: GPUAdapter): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const key of ['maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage'] as const) {
    const value = adapter.limits[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      limits[key] = value;
    }
  }
  return limits;
}

export async function createRenderer(
  canvas: HTMLCanvasElement,
  /**
   * Where the post-processing toggles are read from. Defaults to the page's own
   * query string; the parameter exists so a test or a tool can drive the chain
   * without a URL.
   */
  search: string | URLSearchParams = typeof window === 'undefined' ? '' : window.location.search,
): Promise<Renderer> {
  // BEFORE anything else, and before main.ts loads a map: `?mapoverbright`
  // feeds `R_ColorShiftLightingBytes`, which runs once when the lightmaps and
  // the light grid are decoded. `createRenderer` is the first render call
  // main.ts makes, so installing the mapping here is early enough; installing
  // it any later would silently apply to the gamma ramp only.
  const postOptions = parsePostOptions(search);
  applyPostColorMapping(postOptions);

  if (!('gpu' in navigator)) {
    throw new Error(
      'WebGPU is not available in this browser. Overbounce requires WebGPU; ' +
        'in Chrome check chrome://gpu, and on Linux you may need ' +
        '--enable-unsafe-webgpu.',
    );
  }

  /*
   * Ask for an adapter before handing the canvas to three. If none exists,
   * WebGPURenderer would quietly fall back to WebGL2 and everything would
   * still "work" — but every screenshot baseline taken afterwards would be
   * measuring the wrong backend. Better to fail here, loudly.
   *
   * THE OPTIONS MIRROR THREE'S OWN, and that is load-bearing rather than
   * tidiness. `WebGPUBackend.init` (r0.185) requests its adapter with
   * `featureLevel: 'compatibility'`, and a compatibility adapter may report
   * LOWER limits than the default one. Since the limits read here are handed
   * straight back as `requiredLimits` below, probing a more generous adapter
   * than three will actually use would ask for a limit three's device cannot
   * provide — `requestDevice` rejects, `renderer.init()` rejects with it, and
   * the game does not start at all. That is a far worse failure than the one
   * being fixed.
   *
   * NO `powerPreference`, deliberately. It was added for the first outside
   * bug report (2026-09-15, `.agent/docs/first-bug-report.md`: 5 fps, maybe
   * an integrated GPU) and taken out the same day, because Chrome answers it
   * on Windows with "The powerPreference option is currently ignored when
   * calling requestAdapter() on Windows" (crbug.com/369219127): no effect,
   * plus a console warning every `tools/browser/` run counts as a problem.
   * Windows picks the GPU per application in its own Graphics settings. If
   * it is ever added, add it to three's options below as well -- three
   * forwards `parameters.powerPreference` into its own request.
   *
   * What CAN be done is say which adapter was chosen: `gpu` below.
   */
  const adapterOptions: GPURequestAdapterOptions = { featureLevel: 'compatibility' };
  const adapter = await navigator.gpu.requestAdapter(adapterOptions);
  if (!adapter) {
    throw new Error(
      'No WebGPU adapter available. The browser exposes navigator.gpu but ' +
        'could not provide a GPU adapter — check chrome://gpu for a blocklist ' +
        'entry or a disabled hardware accelerator.',
    );
  }
  const gpu = describeAdapter(adapter);

  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL: false,
    requiredLimits: sampledTextureLimits(adapter),
  });

  await renderer.init();

  // `?aniso` -- see `setTextureAnisotropy`. Here, before main.ts loads a map,
  // because a texture takes the level when it is decoded; and here rather than
  // earlier because the device's own limit is only known after `init()`.
  {
    const params = typeof search === 'string' ? new URLSearchParams(search) : search;
    const raw = params.get('aniso');
    let level = DEFAULT_ANISOTROPY;
    if (raw !== null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 1) {
        level = n;
      } else {
        console.warn(`[overbounce] ?aniso=${raw} is not a level >= 1; using ${DEFAULT_ANISOTROPY}`);
      }
    }
    setTextureAnisotropy(Math.min(level, renderer.getMaxAnisotropy()));
  }

  const backend = detectBackend(renderer);
  if (backend !== 'webgpu') {
    throw new Error(
      `Renderer fell back to "${backend}" instead of WebGPU. Refusing to ` +
        'continue: a silent fallback would make render baselines meaningless.',
    );
  }

  const scene = new Scene();
  scene.background = new Color(0x14141a);

  const camera = new PerspectiveCamera(
    90,
    canvas.clientWidth / Math.max(1, canvas.clientHeight),
    NEAR,
    FAR,
  );

  const world = new Group();
  // Z-up (Quake) -> Y-up (three). The ONLY place this conversion happens.
  world.rotation.x = -Math.PI / 2;
  scene.add(world);

  /*
   * This rotation is set once and never touched again, so three does not need
   * to recompute it sixty times a second -- and the cost of letting it is not
   * the one matrix. Read `Object3D.updateMatrixWorld` in the installed three:
   *
   *     if ( this.matrixAutoUpdate ) this.updateMatrix();   // compose(), and
   *                                                          // sets the dirty flag
   *     if ( this.matrixWorldNeedsUpdate || force ) {
   *       ...matrixWorld.multiplyMatrices( parent.matrixWorld, this.matrix );
   *       this.matrixWorldNeedsUpdate = false;
   *       force = true;                        // <- for the ENTIRE subtree
   *     }
   *
   * `updateMatrix()` sets `matrixWorldNeedsUpdate`, which sets `force`, which
   * is passed down to every descendant -- so an auto-updating group at the root
   * makes the whole scene graph recompute its world matrix every frame no
   * matter what the individual objects do. With a thousand objects under here
   * (see `npm run census`) that is the difference between the static half of
   * the scene costing a `compose` plus a `multiplyMatrices` each and costing
   * nothing at all.
   *
   * `updateMatrix()` once, by hand, because with `matrixAutoUpdate` off nothing
   * else ever will -- and a `matrix` left at identity would put the whole world
   * back in Z-up, silently.
   *
   * ANYTHING THAT LATER WRITES `world.position/rotation/scale` MUST CALL
   * `world.updateMatrix()` ITSELF. Nothing does today; a write that forgets
   * would simply not take effect, with no error.
   */
  freezeTransform(world);
  // The scene root is identity and stays identity, and it forces the same way.
  freezeTransform(scene);

  const resize = (): void => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  resize();

  const logPost = (o: PostChain['options'] | null): void => {
    if (o) {
      console.log(
        `[overbounce] post: tonemap ${o.tone}, ssao ${o.ssao}` +
          (o.ssao === 'off' ? '' : ` (r=${o.ssaoRadius}, cap=${o.ssaoMaxDarkening})`) +
          `, fxaa ${o.fxaa ? 'on' : 'off'}` +
          (o.aberration > 0 ? `, aberration ${o.aberration}` : '') +
          (o.vignette > 0 ? `, vignette ${o.vignette}` : '') +
          (o.motionBlur > 0 ? `, motionblur ${o.motionBlur}` : '') +
          `, gamma ${o.colorMapping.gamma}, overbright ${o.colorMapping.overbrightBits}` +
          `, mapoverbright ${o.colorMapping.mapOverBrightBits}`,
      );
    } else {
      console.log('[overbounce] post: disabled — rendering straight to the canvas');
    }
  };

  /*
   * The scene graph is walked ONCE a frame, by us, instead of three times by
   * three.
   *
   * `WebGPURenderer` does `if ( scene.matrixWorldAutoUpdate === true )
   * scene.updateMatrixWorld()` at the top of every render pass. Counted on
   * q3dm6: three full walks of a 1012-object graph per frame -- the portal
   * view, the main pass, and one more -- and a walk measured 74us on its own.
   * Nothing writes a transform between those passes, so two of the three were
   * recomputing an answer that could not have changed.
   *
   * Turning the flag off stops three doing it at all, which makes the single
   * explicit walk below load-bearing rather than an optimisation: with the flag
   * off and nobody calling `syncScene`, every object renders at its previous
   * frame's position. `render()` therefore calls it unconditionally, and the
   * frame counter is what makes the extra calls free.
   */
  scene.matrixWorldAutoUpdate = false;
  let frameId = 0;
  let syncedFrame = -1;
  const syncScene = (): void => {
    if (syncedFrame === frameId) {
      return;
    }
    syncedFrame = frameId;
    scene.updateMatrixWorld();
  };

  /*
   * The map's fog volumes, once a map has loaded.
   *
   * The chain is built before that -- there is a renderer long before there is
   * a BSP -- and a node graph is compiled once, so the volumes cannot be a
   * uniform the march indexes at runtime: their COUNT decides how many terms
   * the graph has. `setFogVolumes` therefore rebuilds the chain, the same
   * rebuild `setPostOptions` already performs, and holds the value so either
   * call can reconstruct the other's half.
   */
  let volumetric: VolumetricFog | null = null;

  /** One warning per renderer, not one per exported frame. */
  let warnedNoGpuBarrier = false;

  const buildPost = (options: PostOptions): PostChain | null =>
    postIsNoop(options, volumetric)
      ? null
      : createPostChain(renderer, scene, camera, options, volumetric);

  let post = buildPost(postOptions);
  let currentPostOptions = postOptions;
  logPost(post?.options ?? null);

  const setPostOptions = (options: PostOptions): void => {
    post?.dispose();
    post = buildPost(options);
    currentPostOptions = options;
    logPost(post?.options ?? null);
  };

  /*
   * The cheap path for the three values a timeline or a slider moves every
   * frame. See `PostChain.setLook`.
   *
   * `currentPostOptions` is updated on BOTH paths, and that is load-bearing
   * rather than tidy: it is what `setFogVolumes` rebuilds from, so a uniform
   * write that did not land here would be silently undone the next time a
   * map handed the renderer its fog volumes.
   */
  const setPostLook = (look: PostLook): boolean => {
    const merged: PostOptions = { ...currentPostOptions, ...look };
    if (post && post.setLook(look)) {
      currentPostOptions = merged;
      return false;
    }
    // A boundary was crossed, or there is no chain yet because every stage
    // was off. Either way the shader itself has to change.
    setPostOptions(merged);
    return true;
  };

  const setFogVolumes = (next: VolumetricFog | null): void => {
    volumetric = next;
    post?.dispose();
    post = buildPost(currentPostOptions);
    logPost(post?.options ?? null);
  };

  return {
    renderer,
    scene,
    camera,
    world,
    backend,
    gpu,
    get post() {
      return post;
    },
    get postOptions() {
      return currentPostOptions;
    },
    setPostOptions,
    setPostLook,
    setFogVolumes,
    syncScene,
    gpuIdle: async (): Promise<void> => {
      // Reached through the same narrowing `detectBackend` uses -- three does
      // not expose the device on a public surface, and `any` is banned.
      const withDevice = renderer as unknown as {
        backend?: { device?: { queue?: { onSubmittedWorkDone?: () => Promise<undefined> } } };
      };
      const done = withDevice.backend?.device?.queue?.onSubmittedWorkDone;
      if (!done) {
        /*
         * Say so, ONCE, rather than resolving quietly.
         *
         * `backend.device` is reached by narrowing three's internals, which
         * is the only way in -- so a three upgrade that renames it turns this
         * barrier into a no-op, and a no-op here does not fail. It produces a
         * video of the right size, length, codec and resolution in which
         * every frame is the same picture, which is the exact bug this exists
         * to prevent and which took a full EBML walk plus a per-frame pixel
         * diff to identify. A line in the console is cheaper than finding it
         * twice.
         */
        if (!warnedNoGpuBarrier) {
          warnedNoGpuBarrier = true;
          console.warn(
            '[overbounce] no GPU queue to wait on: backend.device.queue in three ' +
              'is not where this expects. Video export will capture frames the GPU ' +
              'has not finished drawing. See .agent/docs/video-export.md.',
          );
        }
        return;
      }
      await withDevice.backend!.device!.queue!.onSubmittedWorkDone!();
    },

    render: () => {
      // Unconditional, so the main pass cannot be stale even if a caller
      // forgets the explicit `syncScene()` before an earlier pass.
      syncScene();
      if (post) {
        post.render();
      } else {
        renderer.render(scene, camera);
      }
      // A frame ends when its last pass has been issued. Bumping here is what
      // re-arms the walk for the next one.
      frameId++;
    },
    resize,
    dispose: () => {
      post?.dispose();
      renderer.dispose();
    },
  };
}

/**
 * The adapter as one line: `vendor architecture (description)`, plus
 * `FALLBACK` when the browser says it is a software adapter.
 *
 * `adapter.info` is where Chrome reports this; `requestAdapterInfo()` is
 * gone. Any field may be an empty string where the browser withholds it, and
 * `isFallbackAdapter` moved from the adapter onto `info`, so both are read.
 * `info` itself is absent before Chrome 121, and a diagnostic must not be
 * what stops the game starting, so a missing one reads as "unknown".
 */
function describeAdapter(adapter: GPUAdapter): string {
  const legacy = adapter as GPUAdapter & {
    info?: Partial<GPUAdapterInfo> & { isFallbackAdapter?: boolean };
    isFallbackAdapter?: boolean;
  };
  const info = legacy.info ?? {};
  const name = [info.vendor, info.architecture].filter(Boolean).join(' ') || 'unknown';
  const description = info.description ? ` (${info.description})` : '';
  const fallback = (info.isFallbackAdapter ?? legacy.isFallbackAdapter) ? ' FALLBACK' : '';
  return `${name}${description}${fallback}`;
}

/**
 * three does not expose a stable public "which backend am I" flag, so this
 * sniffs the backend object and falls back to a conservative "unknown".
 */
function detectBackend(renderer: WebGPURenderer): string {
  const withBackend = renderer as unknown as {
    backend?: { isWebGPUBackend?: boolean; isWebGLBackend?: boolean };
  };
  const b = withBackend.backend;
  if (b?.isWebGPUBackend) {
    return 'webgpu';
  }
  if (b?.isWebGLBackend) {
    return 'webgl';
  }
  return 'unknown';
}
