/**
 * Keep an object out of the reflection pass's broken culling frustum.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The water reflection clips at the surface with Lengyel's oblique near
 * plane: the water plane, in the virtual camera's view space, is written
 * straight into the projection matrix's third row. That is what stops a
 * mirrored camera below a pool from seeing the pool floor, and it is a good
 * trick -- but it leaves the projection matrix no longer a standard
 * perspective one.
 *
 * three derives its culling frustum from exactly that matrix
 * (`_frustum.setFromProjectionMatrix( projection * viewInverse )`), and the
 * extraction assumes the standard form. Given a skewed matrix it produces
 * side planes that are not the real frustum's, and objects genuinely in view
 * get culled. The world survives it because its surfaces are large, numerous
 * and mostly straddle the planes; a single compact object like a player model
 * does not.
 *
 * **This was a real, visible bug and it was silent.** A player standing over
 * the water in `q3ctf2` cast no reflection at all -- not a wrong one, none --
 * while the map around them reflected correctly, so it read as the model
 * being mirrored wrongly rather than as the model being absent. Proven by
 * A/B: with culling off for the avatar the reflection appears, with it on it
 * does not.
 *
 * The fix is per-object rather than a blanket `frustumCulled = false` on the
 * scene, because culling the WORLD is worth keeping: the reflection target is
 * half-scale but the map is not, and a pass that draws every surface in
 * `q3ctf2` costs far more than the handful of entities this applies to.
 *
 * Every compact entity that should appear in a reflection needs this. Today
 * that is the player and the playback subject; items, missiles and the ghost
 * avatar have the same latent problem and are noted in
 * `.agent/docs/water-reflection-culling.md`.
 */

import type { Object3D } from 'three/webgpu';

/**
 * Exempt a subtree from frustum culling.
 *
 * Applied to every descendant, not just the root: three tests and culls per
 * object as it traverses, so a root that is exempt whose children are not
 * still loses the children -- which for a player model means losing the body
 * and keeping nothing, or keeping the body and losing the gun.
 *
 * Call it after the subtree is populated. A player model loads
 * asynchronously, so the right moment is when it is parented, not when the
 * empty container is created.
 */
export function keepInReflections(root: Object3D): void {
  root.traverse((object) => {
    object.frustumCulled = false;
  });
}
