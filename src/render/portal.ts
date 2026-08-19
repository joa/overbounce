/**
 * Portals and mirrors: a second view, rendered through a surface.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from `R_MirrorViewBySurface`, `R_GetPortalOrientations`,
 * `R_MirrorPoint` and `R_MirrorVector` (tr_main.c), plus the entity half in
 * `SP_misc_portal_surface` / `locateCamera` (g_misc.c).
 *
 * ## The thing that makes it a window rather than a monitor
 *
 * The obvious reading of a Quake portal is "render from the camera entity" --
 * a security monitor bolted to the wall. It is not what `R_MirrorViewBySurface`
 * does:
 *
 *     R_MirrorPoint( oldParms.or.origin, &surface, &camera, newParms.or.origin );
 *
 * The new eye is the PLAYER'S eye, expressed in the surface's frame and
 * re-planted in the camera's. Walk left in front of the portal and the view
 * pans right, exactly as it would through a hole in the wall. That single line
 * is the difference between a portal that reads as a window and one that reads
 * as a television, and it is why the transform is ported literally here rather
 * than rebuilt with three's camera helpers.
 *
 * ## How a surface is matched to an entity
 *
 * Not by name. `R_GetPortalOrientations` walks every portal-surface entity and
 * takes the first whose origin is within **64 units of the surface's plane** --
 * which is why `SP_misc_portal_surface`'s own comment says "This must be within
 * 64 world units of the surface!". A mapper places the entity near the glass
 * and the renderer works out which glass it meant.
 *
 * An entity with no `target` is a MIRROR: `SP_misc_portal_surface` copies
 * `origin` into `origin2`, and `R_GetPortalOrientations` tests exactly that
 * equality to decide.
 */

import type { EntityDict } from '../collision/cm-load.js';
import type { BspFile } from '../collision/bsp.js';
import type { Shader } from '../assets/shader.js';
import { SS_PORTAL, shaderKey } from '../assets/shader.js';

export type Vec3Tuple = [number, number, number];

/** An `orientation_t`: a point and three axes. */
export interface Orientation {
  origin: Vec3Tuple;
  axis: [Vec3Tuple, Vec3Tuple, Vec3Tuple];
}

/** A portal-capable surface in the world, with the plane it lies on. */
export interface PortalSurface {
  /** Index into `bsp.shaders`, so the render side can match its batches. */
  shaderNum: number;
  /** Plane normal and distance, from the surface's own vertices. */
  normal: Vec3Tuple;
  dist: number;
  /** Centroid, for the distance cull and for debugging. */
  center: Vec3Tuple;
}

/** A resolved `misc_portal_surface`, with wherever it is looking. */
export interface PortalEntity {
  origin: Vec3Tuple;
  /** `s.origin2` — the camera's position, or `origin` again for a mirror. */
  origin2: Vec3Tuple;
  /** Unit view direction of the camera. Null for a mirror. */
  direction: Vec3Tuple | null;
  /** `roll / 360 * 256`, as `SP_misc_portal_camera` packs it. Degrees here. */
  roll: number;
  mirror: boolean;
}

function vec(raw: string | undefined): Vec3Tuple | null {
  if (!raw) {
    return null;
  }
  const p = raw.trim().split(/\s+/).map(Number);
  return p.length >= 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : null;
}

function normalize(v: Vec3Tuple): Vec3Tuple {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-6 ? [v[0] / len, v[1] / len, v[2] / len] : [1, 0, 0];
}

function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

const dot = (a: Vec3Tuple, b: ArrayLike<number>): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * `PerpendicularVector` (q_math.c) — any unit vector at right angles to `src`.
 *
 * Ported rather than improvised, because WHICH perpendicular it picks decides
 * the roll of the portal view. id finds the axis `src` leans on least, makes a
 * unit vector along it, projects out the `src` component and normalises. A
 * different choice is still perpendicular and still "correct", and would spin
 * the portal image.
 */
export function perpendicularVector(src: Vec3Tuple): Vec3Tuple {
  let pos = 0;
  let minelem = 1;
  for (let i = 0; i < 3; i++) {
    const a = Math.abs(src[i]);
    if (a < minelem) {
      minelem = a;
      pos = i;
    }
  }
  const tempvec: Vec3Tuple = [0, 0, 0];
  tempvec[pos] = 1;

  // ProjectPointOnPlane, then normalise.
  const d = dot(src, tempvec);
  const out: Vec3Tuple = [
    tempvec[0] - d * src[0],
    tempvec[1] - d * src[1],
    tempvec[2] - d * src[2],
  ];
  return normalize(out);
}

/**
 * `R_MirrorPoint` — a point in the surface's frame, re-planted in the camera's.
 */
export function mirrorPoint(
  input: ArrayLike<number>,
  surface: Orientation,
  camera: Orientation,
): Vec3Tuple {
  const local: Vec3Tuple = [
    input[0] - surface.origin[0],
    input[1] - surface.origin[1],
    input[2] - surface.origin[2],
  ];
  const out: Vec3Tuple = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const d = dot(local, surface.axis[i]);
    out[0] += d * camera.axis[i][0];
    out[1] += d * camera.axis[i][1];
    out[2] += d * camera.axis[i][2];
  }
  return [
    out[0] + camera.origin[0],
    out[1] + camera.origin[1],
    out[2] + camera.origin[2],
  ];
}

/** `R_MirrorVector` — the same, without the translation. */
export function mirrorVector(
  input: ArrayLike<number>,
  surface: Orientation,
  camera: Orientation,
): Vec3Tuple {
  const out: Vec3Tuple = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const d = dot([input[0], input[1], input[2]], surface.axis[i]);
    out[0] += d * camera.axis[i][0];
    out[1] += d * camera.axis[i][1];
    out[2] += d * camera.axis[i][2];
  }
  return out;
}

/**
 * `RotatePointAroundVector` (q_math.c), for the camera's `roll`.
 *
 * Rodrigues' rotation, which is what id's matrix construction amounts to.
 */
export function rotateAroundVector(
  point: Vec3Tuple,
  axis: Vec3Tuple,
  degrees: number,
): Vec3Tuple {
  const rad = (degrees * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const k = cross(axis, point);
  const d = dot(axis, point) * (1 - c);
  return [
    point[0] * c + k[0] * s + axis[0] * d,
    point[1] * c + k[1] * s + axis[1] * d,
    point[2] * c + k[2] * s + axis[2] * d,
  ];
}

/**
 * `SP_misc_portal_surface` plus `locateCamera`, resolved from the entity lump.
 *
 * The game side runs `locateCamera` on a think 100ms into the level, following
 * `target` to a `misc_portal_camera` and then that camera's own `target` to
 * whatever it looks at. All of that is static map data, so it is resolved once
 * here rather than on a timer.
 */
export function parsePortalEntities(entities: readonly EntityDict[]): PortalEntity[] {
  const byName = new Map<string, EntityDict>();
  for (const e of entities) {
    if (e['targetname']) {
      byName.set(e['targetname'].toLowerCase(), e);
    }
  }

  const out: PortalEntity[] = [];

  for (const e of entities) {
    if (e['classname'] !== 'misc_portal_surface') {
      continue;
    }
    const origin = vec(e['origin']);
    if (!origin) {
      continue;
    }

    // "if ( !ent->target ) { VectorCopy( ent->s.origin, ent->s.origin2 ); }"
    // -- and `R_GetPortalOrientations` tests that equality to spot a mirror.
    const camera = e['target'] ? byName.get(e['target'].toLowerCase()) : undefined;
    const cameraOrigin = camera ? vec(camera['origin']) : null;
    if (!camera || !cameraOrigin) {
      out.push({
        origin,
        origin2: [...origin],
        direction: null,
        roll: 0,
        mirror: true,
      });
      continue;
    }

    /*
     * `locateCamera`: the camera's aim is its own target if it has one, and
     * otherwise `G_SetMovedir(owner->s.angles)`. Only the first case appears in
     * the rotation -- q3dm7's camera targets `t44` -- so the angles fallback is
     * the yaw-only form rather than a full `G_SetMovedir` with its
     * up/down angle hacks.
     */
    let direction: Vec3Tuple | null = null;
    const lookAt = camera['target'] ? byName.get(camera['target'].toLowerCase()) : undefined;
    const lookOrigin = lookAt ? vec(lookAt['origin']) : null;
    if (lookOrigin) {
      direction = normalize([
        lookOrigin[0] - cameraOrigin[0],
        lookOrigin[1] - cameraOrigin[1],
        lookOrigin[2] - cameraOrigin[2],
      ]);
    } else {
      const angles = vec(camera['angles']) ?? [0, Number(camera['angle'] ?? 0) || 0, 0];
      const yaw = (angles[1] * Math.PI) / 180;
      const pitch = (angles[0] * Math.PI) / 180;
      direction = normalize([
        Math.cos(yaw) * Math.cos(pitch),
        Math.sin(yaw) * Math.cos(pitch),
        -Math.sin(pitch),
      ]);
    }

    out.push({
      origin,
      origin2: cameraOrigin,
      direction,
      roll: Number.parseFloat(camera['roll'] ?? '0') || 0,
      mirror: false,
    });
  }

  return out;
}

/**
 * Every world surface whose shader is `SS_PORTAL`, with its plane.
 *
 * `R_PlaneForSurface` takes the plane from the first triangle's winding. This
 * uses the same idea over the whole surface: Newell's method, which is stable
 * for a nearly-degenerate first triangle where a single cross product is not.
 */
export function findPortalSurfaces(
  bsp: BspFile,
  shaders: ReadonlyMap<string, Shader>,
): PortalSurface[] {
  const portalShader = new Set<number>();
  for (let i = 0; i < bsp.shaders.length; i++) {
    const sh = shaders.get(shaderKey(bsp.shaders[i].shader));
    if (sh && sh.sort === SS_PORTAL) {
      portalShader.add(i);
    }
  }
  if (portalShader.size === 0) {
    return [];
  }

  const out: PortalSurface[] = [];

  for (const surface of bsp.surfaces) {
    if (!portalShader.has(surface.shaderNum) || surface.numVerts < 3) {
      continue;
    }

    let nx = 0;
    let ny = 0;
    let nz = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;

    for (let k = 0; k < surface.numVerts; k++) {
      const a = (surface.firstVert + k) * 3;
      const b = (surface.firstVert + ((k + 1) % surface.numVerts)) * 3;
      const ax = bsp.drawVerts[a];
      const ay = bsp.drawVerts[a + 1];
      const az = bsp.drawVerts[a + 2];
      const bx = bsp.drawVerts[b];
      const by = bsp.drawVerts[b + 1];
      const bz = bsp.drawVerts[b + 2];

      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);

      cx += ax;
      cy += ay;
      cz += az;
    }

    const normal = normalize([nx, ny, nz]);
    const center: Vec3Tuple = [
      cx / surface.numVerts,
      cy / surface.numVerts,
      cz / surface.numVerts,
    ];

    out.push({
      shaderNum: surface.shaderNum,
      normal,
      dist: dot(normal, center),
      center,
    });
  }

  return out;
}

/** How far a portal entity may sit from the surface plane. `SP_misc_portal_surface`. */
export const PORTAL_MATCH_DISTANCE = 64;

/**
 * `R_GetPortalOrientations` — pair a surface with its entity and build both
 * orientations.
 *
 * Returns null when no entity is within 64 units of the plane, which is id's
 * "if we didn't locate a portal entity, don't render anything". A portal
 * surface with no entity is NOT treated as a mirror, deliberately: id says so
 * at length, and a wrong guess there shows the player a reflection of a room
 * they are not in.
 */
export function portalOrientations(
  surface: PortalSurface,
  entities: readonly PortalEntity[],
): { surface: Orientation; camera: Orientation; mirror: boolean } | null {
  const axis0 = surface.normal;
  const axis1 = perpendicularVector(axis0);
  const axis2 = cross(axis0, axis1);

  for (const e of entities) {
    const d = dot(surface.normal, e.origin) - surface.dist;
    if (d > PORTAL_MATCH_DISTANCE || d < -PORTAL_MATCH_DISTANCE) {
      continue;
    }

    const surf: Orientation = {
      origin: [0, 0, 0],
      axis: [axis0, axis1, axis2],
    };

    if (e.mirror) {
      // `VectorScale( plane.normal, plane.dist, surface->origin )`, then the
      // camera is the same point with a flipped normal -- a reflection.
      surf.origin = [
        axis0[0] * surface.dist,
        axis0[1] * surface.dist,
        axis0[2] * surface.dist,
      ];
      return {
        surface: surf,
        camera: {
          origin: [...surf.origin],
          axis: [[-axis0[0], -axis0[1], -axis0[2]], axis1, axis2],
        },
        mirror: true,
      };
    }

    // "project the origin onto the surface plane to get an origin point we can
    // rotate around"
    const proj = dot(surface.normal, e.origin) - surface.dist;
    surf.origin = [
      e.origin[0] - proj * axis0[0],
      e.origin[1] - proj * axis0[1],
      e.origin[2] - proj * axis0[2],
    ];

    /*
     * The camera's axes, with id's two negations:
     *
     *     AxisCopy( e->e.axis, camera->axis );
     *     VectorSubtract( vec3_origin, camera->axis[0], camera->axis[0] );
     *     VectorSubtract( vec3_origin, camera->axis[1], camera->axis[1] );
     *
     * `e->e.axis` is built from the direction `locateCamera` computed, so
     * axis[0] is the view direction and the negations turn the camera to face
     * back through the portal.
     */
    const dir = e.direction ?? [1, 0, 0];
    const camAxis1 = perpendicularVector(dir);
    const camAxis2 = cross(dir, camAxis1);

    let a1: Vec3Tuple = [-camAxis1[0], -camAxis1[1], -camAxis1[2]];
    let a2: Vec3Tuple = camAxis2;
    const a0: Vec3Tuple = [-dir[0], -dir[1], -dir[2]];

    // "clientNum holds the rotate offset" -- a fixed roll about the view axis.
    if (e.roll) {
      a1 = rotateAroundVector(a1, a0, e.roll);
      a2 = cross(a0, a1);
    }

    return {
      surface: surf,
      camera: { origin: [...e.origin2], axis: [a0, a1, a2] },
      mirror: false,
    };
  }

  return null;
}

/**
 * Where the portal view's eye goes, and which way it looks.
 *
 * `R_MirrorViewBySurface`'s three lines, and the reason a Quake portal reads as
 * a window: the eye is the PLAYER'S, carried through the surface-to-camera
 * transform.
 */
export function portalView(
  surface: Orientation,
  camera: Orientation,
  viewerOrigin: ArrayLike<number>,
  viewerAxis: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
): { origin: Vec3Tuple; axis: [Vec3Tuple, Vec3Tuple, Vec3Tuple] } {
  return {
    origin: mirrorPoint(viewerOrigin, surface, camera),
    axis: [
      mirrorVector(viewerAxis[0], surface, camera),
      mirrorVector(viewerAxis[1], surface, camera),
      mirrorVector(viewerAxis[2], surface, camera),
    ],
  };
}
