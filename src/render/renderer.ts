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
import type { PostChain, PostOptions } from './post.js';

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
  render(): void;
  resize(): void;
  dispose(): void;
}

/**
 * Q3 units are roughly inches and maps are tens of thousands of units across,
 * so the far plane has to be generous.
 */
const NEAR = 4;
const FAR = 32768;

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

  // Ask for an adapter before handing the canvas to three. If none exists,
  // WebGPURenderer would quietly fall back to WebGL2 and everything would
  // still "work" — but every screenshot baseline taken afterwards would be
  // measuring the wrong backend. Better to fail here, loudly.
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error(
      'No WebGPU adapter available. The browser exposes navigator.gpu but ' +
        'could not provide a GPU adapter — check chrome://gpu for a blocklist ' +
        'entry or a disabled hardware accelerator.',
    );
  }

  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL: false,
  });

  await renderer.init();

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
  world.updateMatrix();
  world.matrixAutoUpdate = false;
  // The scene root is identity and stays identity, and it forces the same way.
  scene.updateMatrix();
  scene.matrixAutoUpdate = false;

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
          (o.motionBlur > 0 ? `, motionblur ${o.motionBlur}` : '') +
          `, gamma ${o.colorMapping.gamma}, overbright ${o.colorMapping.overbrightBits}` +
          `, mapoverbright ${o.colorMapping.mapOverBrightBits}`,
      );
    } else {
      console.log('[overbounce] post: disabled — rendering straight to the canvas');
    }
  };

  let post = postIsNoop(postOptions) ? null : createPostChain(renderer, scene, camera, postOptions);
  let currentPostOptions = postOptions;
  logPost(post?.options ?? null);

  const setPostOptions = (options: PostOptions): void => {
    post?.dispose();
    post = postIsNoop(options) ? null : createPostChain(renderer, scene, camera, options);
    currentPostOptions = options;
    logPost(post?.options ?? null);
  };

  return {
    renderer,
    scene,
    camera,
    world,
    backend,
    get post() {
      return post;
    },
    get postOptions() {
      return currentPostOptions;
    },
    setPostOptions,
    render: () => {
      if (post) {
        post.render();
        return;
      }
      renderer.render(scene, camera);
    },
    resize,
    dispose: () => {
      post?.dispose();
      renderer.dispose();
    },
  };
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
