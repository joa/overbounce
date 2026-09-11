/**
 * `RF_THIRD_PERSON`, as a three.js layer.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Quake draws the local player's own model in first person, just not to the
 * screen. `CG_Player` sets
 *
 *     renderfx = RF_THIRD_PERSON;   // only draw in mirrors
 *
 * for the client whose eyes the view is from (`cg_players.c:2266`), and the
 * renderer then skips that entity for the main view and keeps it for every
 * mirror and portal pass. So in Quake you see yourself in a mirror while in
 * first person, and -- because the flag is about the VIEW rather than about
 * visibility -- you still cast a shadow.
 *
 * Overbounce had no renderfx bitfield, so first person simply set
 * `visible = false`, which takes the model out of every pass including the
 * shadow one. `main.ts` recorded that as a known loss and named this exact
 * fix, deferring it because layer support on three's WebGPU backend was an
 * unknown. It is not an unknown any more, and both halves check out:
 *
 *  - `Renderer.js:3084` culls per camera with `object.layers.test(camera.layers)`,
 *    which is what keeps the model off the screen.
 *  - `ShadowNode.js:731-735` keeps the SHADOW camera's own layers, and only
 *    copies the view camera's mask over them when the shadow camera has no
 *    bit above 0 set:
 *
 *        if ( ( shadow.camera.layers.mask & 0xFFFFFFFE ) === 0 ) {
 *            shadow.camera.layers.mask = camera.layers.mask;
 *        }
 *
 *    Enabling one extra layer on the shadow camera therefore STICKS, and is
 *    the whole mechanism -- without that second half a mirror-only object
 *    would inherit the view camera's mask and be culled out of the shadow map
 *    exactly as it is out of the screen.
 *
 * A mirror-only object is on this layer and NOT on layer 0. Every camera that
 * is allowed to see it -- the portal camera, the water reflection's virtual
 * camera, the shadow camera -- enables this layer in addition to 0.
 */

import type { Object3D } from 'three/webgpu';

/**
 * The layer a first-person player model lives on.
 *
 * 1 rather than a higher number for no reason beyond it being the first one
 * free; nothing else in this project uses layers at all, which is why the
 * `0xFFFFFFFE` test above can be relied on to be about this and nothing else.
 */
export const MIRROR_ONLY_LAYER = 1;

/**
 * Move a whole subtree onto the mirror-only layer, or back to the default.
 *
 * Applied to every descendant rather than to the root, because three tests
 * layers PER OBJECT while traversing -- a root on layer 1 whose children are
 * still on layer 0 draws its children to the screen, which for a player model
 * means the body vanishes and the gun in its hand does not.
 *
 * Idempotent, and safe to call every frame: a model loads asynchronously and
 * is not in the caller's list until it has, so the only reliable time to say
 * this is "every frame, for whatever exists now".
 */
export function setMirrorOnly(root: Object3D, on: boolean): void {
  root.traverse((object) => {
    if (on) {
      object.layers.set(MIRROR_ONLY_LAYER);
    } else {
      object.layers.set(0);
    }
  });
}

/** Let `camera` see mirror-only objects as well as ordinary ones. */
export function seeMirrorOnly(camera: { layers: { enable(n: number): void } }): void {
  camera.layers.enable(MIRROR_ONLY_LAYER);
}
