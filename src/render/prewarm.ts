/**
 * First-use pipeline pre-warm: pay the compile stalls behind the loading
 * screen, not on the first rocket.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ## The stall this removes
 *
 * three's WebGPU backend builds a material's WGSL and creates its render
 * pipeline the first time an object actually reaches a draw — and an
 * INVISIBLE object never reaches one. Every projectile visual in this
 * project is a pool constructed hidden at load (missile holders, the rocket
 * and grenade MD3 clones, the plasma sprite, both particle pools, the fancy
 * explosion sprites, the decal rings, the ghost's box), so none of their
 * pipelines exist until the first shot makes one visible mid-play. The
 * result is the reported hitch on the first rocket of a session, and
 * `.agent/docs/fancy-explosions.md` records the same mechanism making the
 * first explosion invisible for its first ~100-200ms.
 *
 * ## The fix
 *
 * One warm-up frame, rendered while the course-load screen (an opaque DOM
 * overlay, `ui/screens/loading.ts`) still covers the canvas: everything
 * hidden is made visible, frustum culling is suspended so being off-screen
 * cannot skip the compile, the frame is drawn through the REAL frame path —
 * portal pass included — and then every flag is restored. The pipelines
 * survive; the flags do not need to.
 *
 * Two deliberate details:
 *
 * - **Lights are not touched.** three hashes light visibility into the
 *   material light configuration, so flipping a light's `visible` forces a
 *   recompile of every material that sees it — the exact cost this module
 *   exists to avoid, and the reason `scene-lights.ts` parks unused lights at
 *   zero intensity instead of hiding them.
 * - **The warm frame goes through the same passes as a play frame** (post
 *   chain, portal target), because a WebGPU pipeline is compiled per target
 *   configuration: a material warmed against the canvas is compiled again,
 *   from scratch, the first time it is drawn into the portal's render
 *   target. Warming one pass does not warm the other.
 */

import type { Object3D } from 'three/webgpu';

/**
 * Make every hidden object under `root` drawable for one warm-up frame.
 *
 * Returns the restore function; call it immediately after the warm frame has
 * been issued. Restoration is exact — each flag goes back to the value it
 * had, not to a guessed default, so semantically-hidden things (the grenade
 * clone inside a rocket-showing holder, the FPV-hidden player model) come
 * back exactly as their owners left them.
 */
export function showEverythingForWarmup(root: Object3D): () => void {
  const shown: Object3D[] = [];
  const unculled: Object3D[] = [];

  root.traverse((object) => {
    // Flipping a light's `visible` recompiles every material that sees it.
    // Lights are already warm — the pools keep them visible at intensity 0.
    if ((object as { isLight?: boolean }).isLight === true) {
      return;
    }
    if (!object.visible) {
      object.visible = true;
      shown.push(object);
    }
    if (object.frustumCulled) {
      object.frustumCulled = false;
      unculled.push(object);
    }
  });

  return (): void => {
    for (const object of shown) {
      object.visible = false;
    }
    for (const object of unculled) {
      object.frustumCulled = true;
    }
  };
}
