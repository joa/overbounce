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

export async function createRenderer(canvas: HTMLCanvasElement): Promise<Renderer> {
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

  const resize = (): void => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  resize();

  return {
    renderer,
    scene,
    camera,
    world,
    backend,
    render: () => {
      renderer.render(scene, camera);
    },
    resize,
    dispose: () => {
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
