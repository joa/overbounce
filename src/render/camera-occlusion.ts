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
 * A full cutout made the wall itself illegible — you could no longer tell
 * there WAS a wall there, only that the player had a hole-shaped halo around
 * them. The fix is a screen-door (dithered) discard rather than real alpha
 * blending: each fragment inside the capsule survives with probability
 * `GHOST_KEEP` instead of always discarding, so ~20% of the wall's pixels
 * stay solid and ~80% show the player through it. Real blending
 * (`material.transparent = true`) was tried and reverted — the world moving
 * into the transparent queue breaks three separate things that key off
 * `material.transparent` as "is this a real Quake blend surface": the native
 * shadow-receive gate (`bsp-mesh.ts`'s `isLit && !material.transparent`), the
 * `?lit=off` hand-patched shadow receiver (`shadow-map.ts`'s `castsShadow`),
 * SSAO eligibility (`post.ts`'s `canCarryAoMask`) — and, worse, it would put
 * the world batches in the SAME queue as modern water, whose refraction
 * relies on the world having ALREADY finished drawing by the time it samples
 * `viewportSharedTexture` (see that comment in `bsp-mesh.ts`). Dithering
 * keeps every surviving pixel a real, fully opaque fragment, so none of that
 * is disturbed — they still receive shadows and AO exactly like the rest of
 * the wall, which a blended ghost would not.
 */

import { Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  dot,
  float,
  floor,
  fract,
  mix,
  positionWorld,
  screenCoordinate,
  sin,
  smoothstep,
  step,
  uniform,
  vec2,
} from 'three/tsl';
import { q3ToThree } from './renderer.js';

/**
 * Fraction of the wall's pixels that stay solid inside the capsule — the
 * user's "render at only 20% transparency", read as 20% OPACITY (mostly
 * see-through, so the player dominates) rather than 20% see-through (mostly
 * wall). Flip toward 0.8 if that reading is backwards for what was wanted.
 */
const GHOST_KEEP = 0.2;

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
   * A 0/1 factor for an opaque world material: 1 keeps a fragment, 0
   * discards it — exactly what `alphaTest` needs, so this still pairs with
   * `material.alphaTest` the same way `bsp-mesh.ts` already does for grate
   * cutouts, and still never touches `material.transparent` (see the file
   * header for why that matters).
   *
   * `existingOpacity`, if the material already has one (a grate's own texture
   * alpha), is folded in BEFORE dithering, so a grate that's also occluded
   * combines both cuts correctly instead of the occlusion cut ignoring
   * whatever the grate's own alpha already decided.
   */
  keepFactor(existingOpacity?: Node<'float'>): Node<'float'> {
    const seg = this.atNode.sub(this.eyeNode);
    const segLenSq = seg.dot(seg).max(1e-6);
    const toFrag = positionWorld.sub(this.eyeNode);
    const t = toFrag.dot(seg).div(segLenSq).clamp(0, 1);
    const closest = this.eyeNode.add(seg.mul(t));
    const dist = positionWorld.distance(closest);

    const taper = t.oneMinus().div(1 - TAPER_START).clamp(0, 1);
    const effectiveRadius = this.radiusNode.mul(taper);

    // 0 well inside the capsule, 1 well outside it -- so `probability` is
    // GHOST_KEEP deep inside the capsule and 1 (never discarded) outside it,
    // with a soft transition across the capsule's own edge.
    const edge = smoothstep(effectiveRadius.sub(EDGE_SOFTNESS), effectiveRadius.add(EDGE_SOFTNESS), dist);
    const probability = mix(float(GHOST_KEEP), float(1), edge);
    const combined = existingOpacity ? existingOpacity.mul(probability) : probability;

    // A fixed per-pixel pseudo-random threshold in [0, 1) -- the standard
    // screen-door dither hash. `floor(screenCoordinate.xy)` rather than the
    // raw pixel coordinate so a fractional supersample offset can't shift
    // which pixel's threshold a fragment lands on, and `screenCoordinate`
    // rather than `screenUV` so the stipple is one pixel wide regardless of
    // render resolution instead of stretching with it.
    const dither = fract(sin(dot(floor(screenCoordinate.xy), vec2(12.9898, 78.233))).mul(43758.5453));

    return step(dither, combined);
  }
}
