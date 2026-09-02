/**
 * Water reflections: the third render pass.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The mirror-camera and oblique-clipping maths follow three.js's
 * `ReflectorNode` (MIT), which in turn implements Eric Lengyel's "Oblique View
 * Frustum Depth Projection and Clipping" (JGT 2005). Ported rather than used:
 * see "Why not `reflector()`" below.
 *
 * **This is not Quake III.** Quake's water reflects nothing. This is on the
 * modern track with the refraction it extends, and `?waterreflect=0` removes
 * it -- the pass, not just the weight. `.agent/plans/WATER.md` has the whole
 * picture; this header has the decisions that live in this file.
 *
 * ## It is `portal-pass.ts`'s sibling
 *
 * The portal pass is the proven way to draw the whole world a second time
 * under this renderer, and everything below that is not about mirrors is
 * copied from it on purpose: the three-attachment target with the scene
 * pass's attachment names, the renderer's MRT set for the duration, the
 * surfaces hidden while their own view renders, the clear-once-when-culled,
 * the `warm()` at load. Where the two differ is the camera, and it differs in
 * a way worth stating:
 *
 * **A portal mirrors the PLAYER; a reflection mirrors the RENDER CAMERA.**
 * `R_MirrorViewBySurface` carries `oldParms.or.origin` -- the player's eye --
 * through the surface-to-camera transform, because a portal's image is
 * composed for whoever is looking through it. A reflection is sampled in
 * SCREEN space by the camera that drew the screen, so the mirrored view must
 * be that camera's or the two images do not line up. The side camera, the
 * chase camera and FPV all drive the same `PerspectiveCamera`, so one mirror
 * serves all three.
 *
 * ## Why the surface can sample at `screenUV.flipX()`
 *
 * The virtual camera is rebuilt with `lookAt` from the reflected eye, the
 * reflected look target and the reflected up vector, and then given the main
 * camera's projection matrix verbatim. Reflection is an improper rotation, so
 * a right-handed `lookAt` frame built from reflected axes comes out with its
 * RIGHT axis negated relative to the true mirror image: a point on the plane
 * projects to `(-x, y, z)` in the virtual camera's view, exactly where it was
 * on screen with x mirrored. So the surface reads its reflection at the
 * mirrored screen coordinate and needs no texture matrix. This holds only for
 * points ON the plane -- which every water fragment is, up to the quarter-unit
 * `deformVertexes wave` on `clear_calm1` -- and it is asserted numerically in
 * `test/render/water-reflection.test.ts`.
 *
 * ## The clip plane is what makes it a reflection
 *
 * A mirrored camera below a pool sees the pool floor before it sees anything
 * above the surface; without clipping, the "reflection" of a pool is the pool
 * itself, upside down. Lengyel's trick replaces the projection's near plane
 * with the water plane, so nothing below the surface is rasterised at all --
 * no clip-distance shader code, no per-material change, and every pipeline in
 * the map works unchanged. The formula's WebGPU form differs from the GL one
 * in a single term (`[0,1]` depth has no `+1`), and it is written out below.
 *
 * ## One plane per frame, chosen by the frustum
 *
 * A map's water is grouped by plane at load (`findWaterPlanes`). Each frame
 * the plane that can cover the most screen, among those with a surface in
 * view and the eye on their front side, is rendered (`chooseReflectionPlane`);
 * the others get no reflection that frame, which the surface decides per
 * fragment against the active plane (a uniform, because batching can put two
 * pools at different heights in one mesh). q3ctf2 has four planes in one
 * room; q3dm2 has one, once its two zero-area edge faces are thrown out
 * (`MIN_SURFACE_AREA`). The cull is per SURFACE box, not per plane, because
 * a plane's pools can be rooms apart (`WaterPlane.boxes`); it is what keeps
 * the second full scene draw from being paid on every frame.
 *
 * ## Why not `reflector()`
 *
 * three ships `ReflectorNode`, and it was read before this was written. It
 * calls `renderer.setMRT(null)` and renders into a single-attachment target,
 * which is precisely the configuration `post.ts` warns a marked material must
 * never be drawn through: `MRTNode` drops every output not on the current
 * target, the empty struct fails to compile, and every lit material in the
 * map loses its pipeline. It also runs from inside the material's own update
 * hook, mid-pass, which this project's explicit frame order (`syncScene`,
 * portal, main) has no place for. The maths is worth keeping; the plumbing is
 * not.
 */

import {
  Box3,
  Frustum,
  Matrix4,
  PerspectiveCamera,
  Plane,
  RenderTarget,
  Vector2,
  Vector3,
  Vector4,
  WebGPUCoordinateSystem,
} from 'three/webgpu';
import type { CoordinateSystem, Node, Object3D, Scene, Texture, WebGPURenderer } from 'three/webgpu';
import { mrt, normalView, output, uniform, vec4 } from 'three/tsl';
import type { BspFile, BspSurface } from '../collision/bsp.js';
import { SurfaceType } from '../collision/bsp.js';
import type { Shader } from '../assets/shader.js';
import { shaderKey } from '../assets/shader.js';
import { isWaterShader } from './water.js';
import { q3ToThree } from './renderer.js';
import { G_BUFFER, LAVA_BUFFER } from './post.js';

export type Vec3Tuple = [number, number, number];

/** An axis-aligned box in Quake space. */
export interface Bounds {
  mins: Vec3Tuple;
  maxs: Vec3Tuple;
}

/** One plane's worth of water, in Quake space. */
export interface WaterPlane extends Bounds {
  /** Unit normal. */
  normal: Vec3Tuple;
  /** `dot(normal, point)` for every point on the plane. */
  dist: number;
  /**
   * Axis-aligned bounds of every surface on this plane, together (`mins` /
   * `maxs`, for the log) and one by one (`boxes`, for the frustum cull).
   *
   * One by one, because a plane is a map-wide thing: q3ctf2's five pools at
   * z=-48 are in different rooms, and their union AABB spans nearly the whole
   * map. Culled against the union, that plane would pass the frustum test
   * from almost anywhere the eye is above -48, and the pass would run with no
   * water on screen. (A frustum test still knows nothing about walls: a pool
   * behind one is "in view" and costs the pass. Fine -- that is what the
   * portal accepts too, and an occlusion query is not worth its plumbing.)
   */
  boxes: Bounds[];
  /** How many BSP surfaces were folded into it, for the load log. */
  surfaces: number;
}

/**
 * Two surfaces are on the same plane if their normals agree to within this
 * cosine and their distances to within `PLANE_MERGE_DIST` units.
 *
 * `q3map` emits one plane per face and the faces of one pool share it exactly,
 * so the tolerances only have to absorb float noise. A pool at z=0 and one at
 * z=-48 (q3ctf2) must NOT merge, and 1 unit is a long way from 48.
 */
const PLANE_MERGE_COS = 0.999;
const PLANE_MERGE_DIST = 1;

/**
 * How far off the active plane a fragment may be and still count as on it, in
 * Quake units. The surface's `deformVertexes wave` on the shipped shaders is a
 * quarter of a unit; the next pool up in q3ctf2 is 48 away.
 */
export const PLANE_EPSILON = 1;

/**
 * A water surface with less area than this, in square Quake units, is not a
 * pool and gets no plane.
 *
 * q3dm2's `calm_poollight` brush emits two faces along the pool's east edge
 * whose five vertices ALL sit at z=-122 on the line x=-1329: zero-area
 * slivers, presumably bevel faces q3map never culled, with a perfectly good
 * `(1, 0, 0)` normal in the lump. Taken at face value they made a vertical
 * "plane" that won the per-frame pick whenever the eye was just east of the
 * pool -- nearer to that line than to the water below -- and the real pool
 * showed no reflection until the player was standing on it. Reported as
 * "no reflection until the angle works", which is what it looked like.
 */
export const MIN_SURFACE_AREA = 1;

function normalize(v: Vec3Tuple): Vec3Tuple | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-6 ? [v[0] / len, v[1] / len, v[2] / len] : null;
}

/**
 * Every `surfaceparm water` surface in the map, grouped by the plane it lies
 * on. `findPortalSurfaces`'s counterpart.
 *
 * The plane comes from the lump for a planar face -- `ParseFace` copies
 * `lightmapVecs[2]` straight into the plane and the vertex winding carries no
 * facing information, which `portal.ts` learned the hard way -- and from the
 * average vertex normal otherwise. A curved water patch gets a best-fit plane
 * and a reflection that is approximately right; none ship in the rotation.
 */
export function findWaterPlanes(
  bsp: Pick<BspFile, 'shaders' | 'surfaces' | 'drawVerts' | 'drawNormals' | 'drawIndexes'>,
  shaders: ReadonlyMap<string, Shader>,
): WaterPlane[] {
  const water = new Set<number>();
  for (let i = 0; i < bsp.shaders.length; i++) {
    if (isWaterShader(shaders.get(shaderKey(bsp.shaders[i].shader)) ?? null)) {
      water.add(i);
    }
  }
  if (water.size === 0) {
    return [];
  }

  const planes: WaterPlane[] = [];

  for (const surface of bsp.surfaces) {
    if (!water.has(surface.shaderNum) || surface.numVerts < 3) {
      continue;
    }

    let normal: Vec3Tuple | null;
    if (surface.surfaceType === SurfaceType.PLANAR) {
      normal = normalize([surface.normal[0], surface.normal[1], surface.normal[2]]);
    } else {
      const sum: Vec3Tuple = [0, 0, 0];
      for (let k = 0; k < surface.numVerts; k++) {
        const a = (surface.firstVert + k) * 3;
        sum[0] += bsp.drawNormals[a];
        sum[1] += bsp.drawNormals[a + 1];
        sum[2] += bsp.drawNormals[a + 2];
      }
      normal = normalize(sum);
    }
    if (!normal) {
      continue;
    }

    if (surfaceArea(bsp, surface) < MIN_SURFACE_AREA) {
      continue;
    }

    const v0 = surface.firstVert * 3;
    const dist =
      normal[0] * bsp.drawVerts[v0] +
      normal[1] * bsp.drawVerts[v0 + 1] +
      normal[2] * bsp.drawVerts[v0 + 2];

    let plane = planes.find(
      (p) =>
        p.normal[0] * normal[0] + p.normal[1] * normal[1] + p.normal[2] * normal[2] >
          PLANE_MERGE_COS && Math.abs(p.dist - dist) < PLANE_MERGE_DIST,
    );
    if (!plane) {
      plane = {
        normal,
        dist,
        mins: [Infinity, Infinity, Infinity],
        maxs: [-Infinity, -Infinity, -Infinity],
        boxes: [],
        surfaces: 0,
      };
      planes.push(plane);
    }

    const box: Bounds = {
      mins: [Infinity, Infinity, Infinity],
      maxs: [-Infinity, -Infinity, -Infinity],
    };
    for (let k = 0; k < surface.numVerts; k++) {
      const a = (surface.firstVert + k) * 3;
      for (let axis = 0; axis < 3; axis++) {
        const x = bsp.drawVerts[a + axis];
        if (x < box.mins[axis]) {
          box.mins[axis] = x;
        }
        if (x > box.maxs[axis]) {
          box.maxs[axis] = x;
        }
      }
    }
    plane.surfaces++;
    plane.boxes.push(box);
    for (let axis = 0; axis < 3; axis++) {
      plane.mins[axis] = Math.min(plane.mins[axis], box.mins[axis]);
      plane.maxs[axis] = Math.max(plane.maxs[axis], box.maxs[axis]);
    }
  }

  return planes;
}

/**
 * The area of a surface, from its triangles -- see `MIN_SURFACE_AREA`.
 *
 * A patch has no triangles in the lump (they come out of the tessellation),
 * so its control points' bounding box stands in: a box with two zero extents
 * is a line and has no area, one with fewer is a real patch.
 */
export function surfaceArea(
  bsp: Pick<BspFile, 'drawVerts' | 'drawIndexes'>,
  surface: BspSurface,
): number {
  if (surface.surfaceType === SurfaceType.PATCH) {
    const mins = [Infinity, Infinity, Infinity];
    const maxs = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < surface.numVerts; k++) {
      const a = (surface.firstVert + k) * 3;
      for (let axis = 0; axis < 3; axis++) {
        mins[axis] = Math.min(mins[axis], bsp.drawVerts[a + axis]);
        maxs[axis] = Math.max(maxs[axis], bsp.drawVerts[a + axis]);
      }
    }
    const extents = [0, 1, 2].map((axis) => maxs[axis] - mins[axis]).sort((a, b) => b - a);
    return extents[0] * extents[1];
  }

  let area = 0;
  const v = bsp.drawVerts;
  for (let i = 0; i + 2 < surface.numIndexes; i += 3) {
    const a = (surface.firstVert + bsp.drawIndexes[surface.firstIndex + i]) * 3;
    const b = (surface.firstVert + bsp.drawIndexes[surface.firstIndex + i + 1]) * 3;
    const c = (surface.firstVert + bsp.drawIndexes[surface.firstIndex + i + 2]) * 3;
    const abx = v[b] - v[a];
    const aby = v[b + 1] - v[a + 1];
    const abz = v[b + 2] - v[a + 2];
    const acx = v[c] - v[a];
    const acy = v[c + 1] - v[a + 1];
    const acz = v[c + 2] - v[a + 2];
    area +=
      Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx) / 2;
  }
  return area;
}

/** A Quake-space plane as a three.js `Plane` in scene space. */
export function planeToThree(plane: WaterPlane, out: Plane = new Plane()): Plane {
  const n = q3ToThree(plane.normal[0], plane.normal[1], plane.normal[2]);
  // `q3ToThree` is a rotation, so `dot(n, p) = dist` survives it unchanged;
  // three writes the same plane as `dot(n, p) + constant = 0`.
  out.normal.set(n[0], n[1], n[2]);
  out.constant = -plane.dist;
  return out;
}

/**
 * Which plane to reflect this frame, or -1.
 *
 * Candidates: the eye on the plane's front side (a reflection has nothing to
 * show from underneath; a swimmer looking up is the refraction's job) and at
 * least one of its boxes in the frustum. Among them, the one that can cover
 * the most SCREEN wins -- scored per box as its diagonal over its distance
 * from the eye, which is a box's angular size up to a constant -- and only
 * then the nearer plane on a tie.
 *
 * Not "nearest by perpendicular distance", which this replaced. That choice
 * has no notion of how big a pool is: q3dm2's two edge slivers (see
 * `MIN_SURFACE_AREA`) beat its 780-unit pool from anywhere just east of it,
 * and on q3ctf2 a distant pool in another room at z=-48 can be nearer to the
 * plane than the central one at z=120 is, from a balcony above both.
 *
 * `boxes[i]` are `planes[i]`'s per-surface boxes, in scene space.
 */
export function chooseReflectionPlane(
  eye: Vector3,
  frustum: Frustum,
  planes: readonly Plane[],
  boxes: readonly (readonly Box3[])[],
): number {
  let best = -1;
  let bestScore = 0;
  let bestHeight = Infinity;
  for (let i = 0; i < planes.length; i++) {
    const height = planes[i].distanceToPoint(eye);
    if (height <= 0) {
      continue;
    }
    let score = 0;
    for (const box of boxes[i]) {
      if (!frustum.intersectsBox(box)) {
        continue;
      }
      const diagonal = box.min.distanceTo(box.max);
      const distance = Math.max(1, box.getCenter(_center).distanceTo(eye));
      score = Math.max(score, diagonal / distance);
    }
    if (score === 0) {
      continue;
    }
    if (score > bestScore || (score === bestScore && height < bestHeight)) {
      best = i;
      bestScore = score;
      bestHeight = height;
    }
  }
  return best;
}

/** A Quake-space AABB as a three.js `Box3` in scene space. */
export function boundsToThree(bounds: Bounds, out: Box3 = new Box3()): Box3 {
  // (x, y, z) -> (x, z, -y): the y extent flips sign AND order.
  out.min.set(bounds.mins[0], bounds.mins[2], -bounds.maxs[1]);
  out.max.set(bounds.maxs[0], bounds.maxs[2], -bounds.mins[1]);
  return out;
}

const _eye = new Vector3();
const _center = new Vector3();
const _foot = new Vector3();
const _view = new Vector3();
const _target = new Vector3();
const _lookAt = new Vector3(0, 0, -1);
const _rotation = new Matrix4();
const _clipPlane = new Plane();
const _clip = new Vector4();
const _q = new Vector4();

/**
 * Turn `virtual` into `camera`'s mirror image in `plane`, clipped at it.
 *
 * `camera.matrixWorld` must be current. The camera is not parented to the
 * scene in this project, so `scene.updateMatrixWorld()` does not touch it and
 * `renderer.render` only brings it up to date AFTER this pass would need it --
 * the caller updates it explicitly.
 *
 * `coordinateSystem` is the renderer's. The oblique substitution below depends
 * on it, and so does the projection copied from `camera`: three recomputes a
 * camera's projection the first time it renders under a system other than
 * the one it was built for, which would silently discard the clip plane. So
 * the main camera is brought onto the renderer's system first, the virtual
 * camera is stamped with the same one, and the renderer then has nothing to
 * recompute.
 */
export function mirrorCamera(
  camera: PerspectiveCamera,
  plane: Plane,
  virtual: PerspectiveCamera,
  coordinateSystem: CoordinateSystem,
): void {
  if (camera.coordinateSystem !== coordinateSystem) {
    camera.coordinateSystem = coordinateSystem;
    camera.updateProjectionMatrix();
  }

  const n = plane.normal;
  _eye.setFromMatrixPosition(camera.matrixWorld);
  // Any point on the plane serves as the pivot; the eye's own foot is the
  // one with the least cancellation in the reflection below.
  _foot.copy(_eye).addScaledVector(n, -plane.distanceToPoint(_eye));

  // The eye, reflected: foot - reflect(foot - eye).
  _view.subVectors(_foot, _eye);
  _view.reflect(n).negate();
  _view.add(_foot);

  // A point one unit ahead of the camera, reflected the same way, so the
  // virtual camera looks where the mirror image of the real one looks.
  _rotation.extractRotation(camera.matrixWorld);
  _lookAt.set(0, 0, -1).applyMatrix4(_rotation).add(_eye);
  _target.subVectors(_foot, _lookAt);
  _target.reflect(n).negate();
  _target.add(_foot);

  virtual.coordinateSystem = coordinateSystem;
  virtual.position.copy(_view);
  virtual.up.set(0, 1, 0).applyMatrix4(_rotation).reflect(n);
  virtual.lookAt(_target);

  virtual.near = camera.near;
  virtual.far = camera.far;
  virtual.updateMatrixWorld();
  virtual.projectionMatrix.copy(camera.projectionMatrix);

  /*
   * Lengyel's oblique near plane. The water plane in the virtual camera's
   * view space becomes the projection's third row, so depth 0 lands ON the
   * water and everything behind it (below the surface) is clipped by the
   * ordinary near-plane test.
   *
   * `_q` is the far-plane corner opposite the clip plane, in view space, up
   * to a scale that cancels in the division. Both coordinate systems put the
   * far plane at NDC z = 1, which is why `_q` is the same expression in both;
   * only the row itself differs, because GL's near plane is at -1 and
   * WebGPU's at 0.
   */
  _clipPlane.copy(plane).applyMatrix4(virtual.matrixWorldInverse);
  _clip.set(_clipPlane.normal.x, _clipPlane.normal.y, _clipPlane.normal.z, _clipPlane.constant);

  const projection = virtual.projectionMatrix;
  const e = projection.elements;
  _q.x = (Math.sign(_clip.x) + e[8]) / e[0];
  _q.y = (Math.sign(_clip.y) + e[9]) / e[5];
  _q.z = -1;
  _q.w = (1 + e[10]) / e[14];

  _clip.multiplyScalar(1 / _clip.dot(_q));

  e[2] = _clip.x;
  e[6] = _clip.y;
  e[10] = coordinateSystem === WebGPUCoordinateSystem ? _clip.z : _clip.z + 1;
  e[14] = _clip.w;

  // An autosprite reconstructs its view position through the INVERSE
  // projection (`positionView` when `vertexNode` is set); keep the two in
  // step or the sprites in the reflection sit at the wrong depth.
  virtual.projectionMatrixInverse.copy(projection).invert();
}

export interface WaterReflectionPass {
  /** The colour attachment the water surfaces sample. */
  readonly texture: Texture;
  /**
   * The plane rendered into `texture` this frame, in Quake space as
   * `(nx, ny, nz, dist)`. A fragment compares its own position against it --
   * see `PLANE_EPSILON` -- because a batch can hold more than one pool.
   */
  readonly planeNode: Node<'vec4'>;
  /** 1 while `texture` holds this frame's view of `planeNode`, else 0. */
  readonly activeNode: Node<'float'>;
  /**
   * Render the mirror view for this frame, or skip it.
   *
   * Reads the render camera directly. Returns whether anything was drawn, so
   * the caller can tell a culled frame from a broken one.
   */
  render(): boolean;
  /**
   * Render the mirror view once at load, from wherever the camera is,
   * bypassing the culls -- for the same reason `PortalPass.warm` exists: a
   * WebGPU pipeline is compiled per render-target configuration, and this is
   * a new one.
   */
  warm(): void;
  dispose(): void;
}

/**
 * Build the pass.
 *
 * `hide` is the list of water meshes, switched off for the duration of the
 * mirror render: they sit exactly on the clip plane, and a surface that
 * samples the target it is being drawn into is a feedback loop. Handed over
 * by reference and filled after the world build, like `portalHide`.
 *
 * `reveal` is the opposite list: objects switched ON for the mirror render
 * and put back afterwards. It exists for first person. `CG_Player` skips the
 * client's own model in the main view (`RF_THIRD_PERSON`), and
 * `R_AddEntitySurfaces` draws it anyway in a portal or mirror view --
 * `if ( ent->e.renderfx & RF_THIRD_PERSON && !tr.viewParms.isPortal )
 * continue;`. A player looking at a pool in first person sees themselves in
 * it, gun and all, exactly as they would in a Quake mirror. `main.ts` hands
 * over the list photo mode also uses: the model and the weapon riding its
 * `tag_weapon`, without the debug hull. In chase and side views the model is
 * visible already and the list is empty.
 *
 * `scale` is the target's size as a fraction of the drawing buffer.
 */
export function createWaterReflectionPass(params: {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  planes: readonly WaterPlane[];
  hide: readonly Object3D[];
  reveal?: readonly { visible: boolean }[];
  scale: number;
}): WaterReflectionPass | null {
  const { renderer, scene, camera, planes, hide, scale } = params;
  const reveal = params.reveal ?? [];
  if (planes.length === 0) {
    return null;
  }

  /*
   * THREE attachments, matching the scene pass. See `portal-pass.ts` for the
   * full account; the short form is that a material marked with an `mrtNode`
   * compiles to an empty output struct in a single-attachment target, and an
   * unmarked one fails against a three-attachment target unless the renderer's
   * own MRT names all three. Sized on first render, when the drawing buffer
   * size is known.
   */
  const target = new RenderTarget(1, 1, { count: 3 });
  target.textures[0].name = 'output';
  target.textures[1].name = G_BUFFER;
  target.textures[2].name = LAVA_BUFFER;

  const passMrt = mrt({
    output,
    [G_BUFFER]: vec4(normalView, 0),
    [LAVA_BUFFER]: vec4(0, 0, 0, 0),
  });

  const virtual = new PerspectiveCamera(camera.fov, camera.aspect, camera.near, camera.far);

  const planeUniform = uniform(new Vector4(0, 0, 1, 0));
  const activeUniform = uniform(0);

  const threePlanes = planes.map((p) => planeToThree(p));
  // Per surface, not per plane -- see `WaterPlane.boxes`.
  const threeBoxes = planes.map((p) => p.boxes.map((b) => boundsToThree(b)));

  const frustum = new Frustum();
  const projScreen = new Matrix4();
  const size = new Vector2();
  const eye = new Vector3();

  // TRUE to begin with so the first culled frame clears a target that would
  // otherwise hold driver garbage. See `portal-pass.ts`.
  let rendered = true;

  const clearIfStale = (): void => {
    activeUniform.value = 0;
    if (!rendered) {
      return;
    }
    rendered = false;
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.setRenderTarget(previousTarget);
  };

  const fitTarget = (): void => {
    renderer.getDrawingBufferSize(size);
    const w = Math.max(1, Math.round(size.width * scale));
    const h = Math.max(1, Math.round(size.height * scale));
    if (target.width !== w || target.height !== h) {
      target.setSize(w, h);
    }
  };

  const renderView = (index: number): void => {
    fitTarget();
    mirrorCamera(camera, threePlanes[index], virtual, renderer.coordinateSystem);

    const plane = planes[index];
    planeUniform.value.set(plane.normal[0], plane.normal[1], plane.normal[2], plane.dist);

    const wasVisible = hide.map((o) => o.visible);
    for (const o of hide) {
      o.visible = false;
    }
    // Restored EXACTLY, not to false: photo mode may have put the model back
    // on for its own reasons, and the pass must not undo that.
    const wasRevealed = reveal.map((o) => o.visible);
    for (const o of reveal) {
      o.visible = true;
    }

    const previousTarget = renderer.getRenderTarget();
    const previousMrt = renderer.getMRT();
    renderer.setMRT(passMrt);
    renderer.setRenderTarget(target);
    renderer.render(scene, virtual);
    renderer.setRenderTarget(previousTarget);
    renderer.setMRT(previousMrt);

    hide.forEach((o, i) => {
      o.visible = wasVisible[i];
    });
    reveal.forEach((o, i) => {
      o.visible = wasRevealed[i];
    });

    rendered = true;
    activeUniform.value = 1;
  };

  /** Which plane this frame, or -1. See `chooseReflectionPlane`. */
  const pick = (): number => {
    camera.updateMatrixWorld();
    eye.setFromMatrixPosition(camera.matrixWorld);
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen, renderer.coordinateSystem, camera.reversedDepth);
    return chooseReflectionPlane(eye, frustum, threePlanes, threeBoxes);
  };

  return {
    texture: target.textures[0],
    planeNode: planeUniform as unknown as Node<'vec4'>,
    activeNode: activeUniform as unknown as Node<'float'>,

    render(): boolean {
      const index = pick();
      if (index < 0) {
        clearIfStale();
        return false;
      }
      renderView(index);
      return true;
    },

    warm(): void {
      camera.updateMatrixWorld();
      renderView(0);
    },

    dispose(): void {
      target.dispose();
    },
  };
}
