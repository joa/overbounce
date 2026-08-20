/**
 * The side camera's occlusion cutaway.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `side-camera.ts` used to keep the camera visible by pulling its eye in
 * against whatever was between it and the player. That fights a camera built
 * to stay perpendicular to the player's movement (`.agent/plans/SIDE-CAMERA.md`)
 * — pulling in changes the distance and therefore the framing every time a
 * wall gets in the way. This instead leaves the eye exactly where the camera
 * script put it and makes whatever is in the way stop drawing.
 *
 * Not per-brush or per-surface hiding: `bsp-mesh.ts` batches `LUMP_SURFACES`
 * by (shader, lightmap, fog), so one render "surface" can span an entire
 * corridor wall, and there is no clean bridge from a collision brush to the
 * render surface that happens to cover it (caulk, detail brushes and patches
 * all diverge between the two). Instead, every opaque world fragment tests
 * its own distance to the camera-eye -> player-origin segment and discards
 * itself if it is inside a capsule around that segment — a raytrace run once
 * per pixel on the GPU rather than once per frame on the CPU, with the same
 * result: whatever the sightline passes through stops being drawn.
 *
 * This needs no "did we actually hit a wall" gate at all. An id/OA map is a
 * sealed shell, so from outside it (the ordinary case for a `side` camera
 * sitting 520 units back) backface culling alone already removes the near
 * wall — see `bsp-mesh.ts`'s own winding comment. The capsule only ever has
 * to catch INTERIOR occluders between an authored eye position and the player
 * — pillars, doorframes, foreground set dressing — which is also exactly
 * where a porthole cutout reads as intentional rather than as a hole in the
 * level.
 *
 * Full cutout, not a fade: see `.agent/plans/SIDE-CAMERA.md`'s "explicitly
 * deferred" list for softening this later, which is what the user who asked
 * for this meant by "we can add more fidelity like see-through later".
 */

import { Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { positionWorld, smoothstep, uniform } from 'three/tsl';
import { q3ToThree } from './renderer.js';

/**
 * Fraction of the eye->player segment (0 at the eye, 1 at the player) where
 * the capsule radius begins shrinking to zero. Without this, the capsule's
 * far end — which sits at the player's origin, ~24 units above the floor —
 * cuts a hole in the floor they are standing on.
 */
const TAPER_START = 0.8;

/** Half-width, in world units, of the smoothstep band at the capsule's edge — anti-aliasing, not a design knob. */
const EDGE_SOFTNESS = 2;

/**
 * Far enough outside any real map that the capsule this produces (radius
 * capped by `radius()`, tens of units) never reaches actual geometry. The
 * disabled state (`chase`/`fpv`, or before the first `update()`) is this
 * point standing in for both ends of the segment, rather than a separate
 * on/off uniform and a branch every material would need to pay for.
 */
const DISABLED = 1e6;

export class CameraOcclusion {
  private readonly eye = new Vector3(DISABLED, DISABLED, DISABLED);
  private readonly at = new Vector3(DISABLED, DISABLED, DISABLED);
  private readonly eyeNode = uniform(this.eye);
  private readonly atNode = uniform(this.at);
  private readonly radiusNode = uniform(0);

  /**
   * The camera's current pose and the active zone's capsule radius — the same
   * values `side-camera.ts`'s `follow()`/`snap()` just computed. Call once per
   * rendered frame while the side camera is active; simply don't call it
   * (leaving the disabled default) while it isn't.
   */
  update(
    eye: readonly [number, number, number],
    at: readonly [number, number, number],
    radius: number,
  ): void {
    const [ex, ey, ez] = q3ToThree(eye[0], eye[1], eye[2]);
    const [ax, ay, az] = q3ToThree(at[0], at[1], at[2]);
    this.eye.set(ex, ey, ez);
    this.at.set(ax, ay, az);
    this.radiusNode.value = radius;
  }

  /**
   * A 0..1 factor for an opaque world material: 1 keeps a fragment, 0
   * discards it. Multiply into an existing `opacityNode` (or use bare) and
   * pair with `material.alphaTest` — the same mechanism `bsp-mesh.ts` already
   * uses for grate cutouts, chosen over blending so this needs no sort order
   * and does not touch `material.transparent`.
   */
  keepFactor(): Node<'float'> {
    const seg = this.atNode.sub(this.eyeNode);
    const segLenSq = seg.dot(seg).max(1e-6);
    const toFrag = positionWorld.sub(this.eyeNode);
    const t = toFrag.dot(seg).div(segLenSq).clamp(0, 1);
    const closest = this.eyeNode.add(seg.mul(t));
    const dist = positionWorld.distance(closest);

    const taper = t.oneMinus().div(1 - TAPER_START).clamp(0, 1);
    const effectiveRadius = this.radiusNode.mul(taper);

    return smoothstep(effectiveRadius.sub(EDGE_SOFTNESS), effectiveRadius.add(EDGE_SOFTNESS), dist);
  }
}
