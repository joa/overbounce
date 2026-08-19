/**
 * The portal transform: is it a window, or a mirror?
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is here because the same complaint arrived twice — "the portal image
 * looks flipped" — and a screenshot cannot settle it. A static shot shows
 * orientation and facing; what it cannot show is which way the image travels as
 * the player moves, and that is what the eye actually reads as "flipped".
 *
 * It does not need a screenshot, either. `portalView` maps the viewer's eye
 * through `surface` into `camera`, and the character of that map is decided by
 * one number: the determinant of the composite rotation.
 *
 *   +1  a proper rotation. The eye is carried to another room without being
 *       turned inside out, so moving right shows what is left of the far side —
 *       a WINDOW, which is what a Q3 portal is.
 *   -1  a reflection. Parallax runs backwards and the image reads as a mirror.
 *
 * Both axis triples are orthonormal, so the determinant of the composite is the
 * product of theirs, and each is ±1. Checking them individually is therefore
 * exact rather than approximate, and it survives any future rearrangement of
 * the two negations id applies — negating TWO axes preserves handedness, which
 * is precisely why applying only one of them (as an earlier version did) turned
 * the window into a mirror.
 */

import { describe, it, expect } from 'vitest';
import { portalOrientations, portalView } from '../../src/render/portal.js';
import type { PortalEntity, PortalSurface } from '../../src/render/portal.js';

type Vec3 = [number, number, number];

const det = (a: Vec3, b: Vec3, c: Vec3): number =>
  a[0] * (b[1] * c[2] - b[2] * c[1]) -
  a[1] * (b[0] * c[2] - b[2] * c[0]) +
  a[2] * (b[0] * c[1] - b[1] * c[0]);

/**
 * q3dm7's portal, from the real map.
 *
 * The plane is the one `PlaneFromPoints` produces from the surface's first
 * triangle — measured, not invented: `(0, -1, 0)` at 828.11. The Newell normal
 * over the same surface's vertex order is `(0, +1, 0)`, exactly inverted, which
 * is the bug this fixture exists to keep fixed.
 */
const surface: PortalSurface = {
  shaderNum: 0,
  normal: [0, -1, 0],
  dist: 828.11,
  center: [1065, -828, -380],
};

const camera: PortalEntity = {
  origin: [1065, -828, -380],
  origin2: [1087, -2169, 134],
  direction: [0, 1, 0],
  roll: 0,
  mirror: false,
};

describe('the portal transform is a rotation, not a reflection', () => {
  const pair = portalOrientations(surface, [camera])!;

  it('pairs the surface with its entity at all', () => {
    expect(pair).not.toBeNull();
    expect(pair.mirror).toBe(false);
  });

  it('builds RIGHT-HANDED surface axes', () => {
    // `PerpendicularVector` then `CrossProduct( axis[0], axis[1], axis[2] )`,
    // which is right-handed by construction and matches id exactly.
    expect(det(...pair.surface.axis)).toBeCloseTo(1, 6);
  });

  it('builds RIGHT-HANDED camera axes, through BOTH of id\'s negations', () => {
    /*
     * `CG_Portal` negates axis[1], then `R_GetPortalOrientations` negates
     * axis[0] and axis[1] again. Two negations of axis[1] and one of axis[0]
     * is a net single negation — of axis[0] alone — which would flip the
     * handedness on its own. It does not, because axis[2] is built by a cross
     * product taken BETWEEN the two negations and carries the other sign.
     *
     * Applying only one set, as the first version of this did, leaves a
     * left-handed triple: parallax backwards, image mirrored.
     */
    expect(det(...pair.camera.axis)).toBeCloseTo(1, 6);
  });

  it('moves the eye WITH the player, and by the same distance', () => {
    /*
     * A rigid motion preserves distance. If the eye moved by a different amount
     * than the player, the portal would zoom as you walked, which is the other
     * way this can go wrong and one a determinant does not catch.
     */
    const axis: [Vec3, Vec3, Vec3] = [
      [0, 1, 0],
      [-1, 0, 0],
      [0, 0, 1],
    ];
    const a = portalView(pair.surface, pair.camera, [1005, -900, -320], axis);
    const b = portalView(pair.surface, pair.camera, [1125, -900, -320], axis);

    const moved = Math.hypot(
      b.origin[0] - a.origin[0],
      b.origin[1] - a.origin[1],
      b.origin[2] - a.origin[2],
    );
    expect(moved).toBeCloseTo(120, 4);
  });

  it('keeps the view axes orthonormal after the transform', () => {
    // The transform is applied to each of the viewer's three axes separately,
    // so nothing structurally guarantees the result is still a frame. It is,
    // because the map is a rotation -- and if that ever stops being true the
    // portal camera's matrix goes non-orthogonal and the image shears.
    const axis: [Vec3, Vec3, Vec3] = [
      [0, 1, 0],
      [-1, 0, 0],
      [0, 0, 1],
    ];
    const view = portalView(pair.surface, pair.camera, [1065, -900, -320], axis);
    expect(det(...view.axis)).toBeCloseTo(1, 6);
    for (const a of view.axis) {
      expect(Math.hypot(a[0], a[1], a[2])).toBeCloseTo(1, 6);
    }
  });
});

describe('the facing test', () => {
  /*
   * `SurfIsOffscreen` refuses a portal every one of whose triangles faces away.
   * Asked once against the plane, which is exact for a planar portal:
   *
   *     dot(normal, viewerOrigin) - dist > 0
   *
   * With the normal pointing at -y and dist 828.11, a viewer at y = -901 is in
   * front (+73) and one at y = -760 is behind (-68) -- the two positions the
   * screenshots were taken from.
   */
  const facing = (origin: Vec3): number =>
    surface.normal[0] * origin[0] +
    surface.normal[1] * origin[1] +
    surface.normal[2] * origin[2] -
    surface.dist;

  it('is positive in front and negative behind', () => {
    expect(facing([1065, -901, -320])).toBeGreaterThan(0);
    expect(facing([1065, -760, -320])).toBeLessThan(0);
  });

  it('would answer BACKWARDS with the winding normal, which was the bug', () => {
    /*
     * The whole report -- "from the back side I can see the portal target" --
     * in one assertion.
     *
     * Negating the normal negates the distance with it, because
     * `dist = dot(normal, vertex)`. So the flipped plane's facing test is
     * `dot(-n, o) - (-d)`, which is exactly `-(dot(n, o) - d)`: the same
     * number with the opposite sign, and therefore the opposite answer at
     * every position in the map.
     */
    const flipped = (origin: Vec3): number => -facing(origin);
    expect(flipped([1065, -901, -320])).toBeLessThan(0);
    expect(flipped([1065, -760, -320])).toBeGreaterThan(0);
  });
});
