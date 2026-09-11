/**
 * `RF_THIRD_PERSON` as a layer: what the split has to guarantee.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * In first person Quake keeps the local player's own model out of the SCREEN
 * and in every other pass -- mirrors, and the shadow map. Overbounce used to
 * hide it outright, which cost the player their reflection and their own cast
 * shadow; `src/render/layers.ts` has the reasoning and the three.js source
 * lines that make the layer split work.
 *
 * These tests pin the three properties that split depends on. They do NOT
 * test three's renderer -- they test that the objects and cameras are put in
 * the states three's documented culling reads:
 *
 *   `Renderer.js:3084`   const visible = object.layers.test( camera.layers );
 *   `ShadowNode.js:733`  if ( ( shadow.camera.layers.mask & 0xFFFFFFFE ) === 0 )
 *                            shadow.camera.layers.mask = camera.layers.mask;
 *
 * The second is the subtle one and has its own case below: a shadow camera
 * that enables nothing above layer 0 has its mask REPLACED by the view
 * camera's, which would cull a mirror-only object out of the shadow map
 * exactly as it is culled off the screen. The whole mechanism rests on that
 * not happening.
 */

import { describe, it, expect } from 'vitest';
import { Group, Mesh, PerspectiveCamera } from 'three/webgpu';
import { MIRROR_ONLY_LAYER, setMirrorOnly, seeMirrorOnly } from '../../src/render/layers.js';

/** A player model shape: a root with a child, as a gun on `tag_weapon` is. */
function subject(): { root: Group; child: Mesh } {
  const root = new Group();
  const child = new Mesh();
  root.add(child);
  return { root, child };
}

describe('the mirror-only layer', () => {
  it('hides the subject from an ordinary camera and shows it to a mirror', () => {
    const { root } = subject();
    const main = new PerspectiveCamera();
    const mirror = new PerspectiveCamera();
    seeMirrorOnly(mirror);

    setMirrorOnly(root, true);
    expect(root.layers.test(main.layers)).toBe(false);
    expect(root.layers.test(mirror.layers)).toBe(true);
  });

  it('moves every descendant, not just the root', () => {
    // The gun hangs off the model. A root on the mirror layer whose children
    // are still on layer 0 draws the gun to the screen with nobody holding
    // it -- three tests layers per object as it traverses.
    const { root, child } = subject();
    const main = new PerspectiveCamera();

    setMirrorOnly(root, true);
    expect(child.layers.test(main.layers)).toBe(false);
  });

  it('puts the subject back, which is what photo mode needs', () => {
    const { root, child } = subject();
    const main = new PerspectiveCamera();

    setMirrorOnly(root, true);
    setMirrorOnly(root, false);
    expect(root.layers.test(main.layers)).toBe(true);
    expect(child.layers.test(main.layers)).toBe(true);
  });

  it('is idempotent, because it runs every frame', () => {
    // A model loads asynchronously and is not in the caller's list until it
    // has, so the only reliable time to say this is every frame.
    const { root } = subject();
    const mirror = new PerspectiveCamera();
    seeMirrorOnly(mirror);

    setMirrorOnly(root, true);
    const once = root.layers.mask;
    setMirrorOnly(root, true);
    setMirrorOnly(root, true);
    expect(root.layers.mask).toBe(once);
    expect(root.layers.test(mirror.layers)).toBe(true);
  });

  it('leaves a shadow camera in the state that keeps its OWN layers', () => {
    /*
     * The load-bearing one. `ShadowNode` replaces the shadow camera's mask
     * with the view camera's whenever the shadow camera has no bit above 0
     * set. A mirror-only object would then be culled out of the shadow map
     * exactly as it is off the screen, and the player would silently lose the
     * cast shadow this whole split exists to give back.
     */
    const shadow = new PerspectiveCamera();
    expect(shadow.layers.mask & 0xfffffffe).toBe(0);

    seeMirrorOnly(shadow);
    expect(shadow.layers.mask & 0xfffffffe).not.toBe(0);

    // And it still sees everything ordinary, or the world would stop casting.
    const ordinary = new Mesh();
    expect(ordinary.layers.test(shadow.layers)).toBe(true);
  });

  it('keeps the mirror layer clear of layer 0', () => {
    // Being on BOTH layers would draw the model to the screen from inside the
    // player's own head, which is the thing first person is avoiding.
    const { root } = subject();
    setMirrorOnly(root, true);
    expect(root.layers.isEnabled(0)).toBe(false);
    expect(root.layers.isEnabled(MIRROR_ONLY_LAYER)).toBe(true);
  });
});
