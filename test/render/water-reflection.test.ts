/**
 * The water reflection's two headless halves: which planes a map has, and
 * whether the mirrored camera lands where the surface expects to sample it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Nothing here needs a GPU, and the second half is the one worth having
 * without one: `bsp-mesh.ts` reads the reflection at `screenUV.flipX()`, which
 * is only right if a point ON the water plane projects to `(-x, y)` through the
 * virtual camera. That identity is a property of how `mirrorCamera` builds
 * its frame, and a screenshot cannot tell a correct reflection from one that is
 * merely plausible -- an image mirrored the wrong way still looks like water.
 */

import { describe, it, expect } from 'vitest';
import {
  PerspectiveCamera,
  Plane,
  Vector3,
  WebGPUCoordinateSystem,
} from 'three/webgpu';
import type { BspShader, BspSurface } from '../../src/collision/bsp.js';
import { SurfaceType } from '../../src/collision/bsp.js';
import { parseShaderFile } from '../../src/assets/shader.js';
import {
  boundsToThree,
  findWaterPlanes,
  mirrorCamera,
  planeToThree,
} from '../../src/render/water-reflection.js';
import type { WaterPlane } from '../../src/render/water-reflection.js';

// ---------------------------------------------------------------- fixtures

const shaders = parseShaderFile(`
textures/liquids/clear_calm1
{
  surfaceparm water
  { map textures/liquids/pool3d_5e.tga blendFunc GL_dst_color GL_one }
}
textures/liquids/clear_ripple1
{
  surfaceparm water
  { map textures/liquids/pool3d_5e.tga blendFunc GL_dst_color GL_one }
}
textures/base_floor/clangdark
{
  { map $lightmap }
  { map textures/base_floor/clangdark.tga blendFunc GL_dst_color GL_zero }
}
`);

const bspShaders: BspShader[] = [
  { shader: 'textures/liquids/clear_calm1', surfaceFlags: 0, contentFlags: 0 },
  { shader: 'textures/liquids/clear_ripple1', surfaceFlags: 0, contentFlags: 0 },
  { shader: 'textures/base_floor/clangdark', surfaceFlags: 0, contentFlags: 0 },
];

/** A synthetic map: quads, each with its own vertices. */
class MapBuilder {
  readonly surfaces: BspSurface[] = [];
  private readonly verts: number[] = [];
  private readonly normals: number[] = [];

  /**
   * An axis-aligned quad. `axis` is the constant axis, `at` its value, and the
   * quad spans `[a0, a1] x [b0, b1]` over the other two axes in order.
   */
  quad(
    shaderNum: number,
    axis: 0 | 1 | 2,
    at: number,
    a0: number,
    a1: number,
    b0: number,
    b1: number,
    normal: [number, number, number],
    type: SurfaceType = SurfaceType.PLANAR,
  ): void {
    const firstVert = this.verts.length / 3;
    const others = [0, 1, 2].filter((i) => i !== axis);
    for (const [a, b] of [
      [a0, b0],
      [a1, b0],
      [a1, b1],
      [a0, b1],
    ]) {
      const v = [0, 0, 0];
      v[axis] = at;
      v[others[0]] = a;
      v[others[1]] = b;
      this.verts.push(...v);
      this.normals.push(...normal);
    }
    this.surfaces.push({
      shaderNum,
      fogNum: -1,
      surfaceType: type,
      firstVert,
      numVerts: 4,
      firstIndex: 0,
      numIndexes: 6,
      lightmapNum: -1,
      // The lump normal is zero on a non-planar surface, as q3map writes it.
      normal: type === SurfaceType.PLANAR ? normal : [0, 0, 0],
      patchWidth: 0,
      patchHeight: 0,
    });
  }

  get bsp() {
    return {
      shaders: bspShaders,
      surfaces: this.surfaces,
      drawVerts: new Float32Array(this.verts),
      drawNormals: new Float32Array(this.normals),
    };
  }
}

// ---------------------------------------------------------------- planes

describe('findWaterPlanes', () => {
  it('folds coplanar faces into one plane and keeps their union bounds', () => {
    const m = new MapBuilder();
    // Two faces of the same pool, sharing z = 120.
    m.quad(1, 2, 120, -296, 0, -952, 392, [0, 0, 1]);
    m.quad(1, 2, 120, 0, 408, -952, 392, [0, 0, 1]);
    // The floor under them is not water.
    m.quad(2, 2, -20, -400, 400, -1000, 400, [0, 0, 1]);

    const planes = findWaterPlanes(m.bsp, shaders);
    expect(planes).toHaveLength(1);
    expect(planes[0].normal).toEqual([0, 0, 1]);
    expect(planes[0].dist).toBe(120);
    expect(planes[0].surfaces).toBe(2);
    expect(planes[0].mins).toEqual([-296, -952, 120]);
    expect(planes[0].maxs).toEqual([408, 392, 120]);
    // And each face keeps its own box, for the frustum cull.
    expect(planes[0].boxes).toEqual([
      { mins: [-296, -952, 120], maxs: [0, 392, 120] },
      { mins: [0, -952, 120], maxs: [408, 392, 120] },
    ]);
  });

  it('keeps the boxes of pools rooms apart on one plane separate', () => {
    // q3ctf2's z=-48: five pools, three rooms. Their union is nearly the
    // whole map, and culling against it would run the pass every frame.
    const m = new MapBuilder();
    m.quad(1, 2, -48, 1328, 1880, 712, 784, [0, 0, 1]);
    m.quad(1, 2, -48, -1768, -1216, -1344, -1272, [0, 0, 1]);
    const planes = findWaterPlanes(m.bsp, shaders);
    expect(planes).toHaveLength(1);
    expect(planes[0].boxes).toHaveLength(2);
    expect(planes[0].mins).toEqual([-1768, -1344, -48]);
    expect(planes[0].maxs).toEqual([1880, 784, -48]);
  });

  it('keeps q3ctf2-style stacked pools apart', () => {
    // The real map: calm water at z=0 and rippled water at z=120 and z=-48,
    // all in one room. Merging any two would reflect the wrong pool.
    const m = new MapBuilder();
    m.quad(0, 2, 0, -1016, 1128, -968, 408, [0, 0, 1]);
    m.quad(1, 2, 120, -296, 408, -952, 392, [0, 0, 1]);
    m.quad(1, 2, -48, -1768, 1880, -1736, 1176, [0, 0, 1]);

    const planes = findWaterPlanes(m.bsp, shaders);
    expect(planes.map((p) => p.dist).sort((a, b) => a - b)).toEqual([-48, 0, 120]);
  });

  it('takes a vertical face as its own plane, as q3dm2 has', () => {
    const m = new MapBuilder();
    m.quad(0, 2, -122, -2112, -1329, -1920, -1152, [0, 0, 1]);
    m.quad(0, 0, -1329, -1920, -1792, -200, -122, [1, 0, 0]);

    const planes = findWaterPlanes(m.bsp, shaders);
    expect(planes).toHaveLength(2);
    const vertical = planes.find((p) => p.normal[0] === 1);
    expect(vertical).toBeDefined();
    expect(vertical?.dist).toBe(-1329);
  });

  it('falls back to the vertex normals when the lump has none', () => {
    const m = new MapBuilder();
    m.quad(0, 2, 64, 0, 100, 0, 100, [0, 0, 1], SurfaceType.TRIANGLE_SOUP);
    const planes = findWaterPlanes(m.bsp, shaders);
    expect(planes).toHaveLength(1);
    expect(planes[0].normal).toEqual([0, 0, 1]);
    expect(planes[0].dist).toBe(64);
  });

  it('returns nothing for a map without water', () => {
    const m = new MapBuilder();
    m.quad(2, 2, 0, 0, 100, 0, 100, [0, 0, 1]);
    expect(findWaterPlanes(m.bsp, shaders)).toEqual([]);
  });
});

// ---------------------------------------------------------------- conversions

describe('Quake to three.js', () => {
  const plane: WaterPlane = {
    normal: [0, 0, 1],
    dist: 120,
    mins: [-296, -952, 120],
    maxs: [408, 392, 120],
    boxes: [{ mins: [-296, -952, 120], maxs: [408, 392, 120] }],
    surfaces: 1,
  };

  it('keeps the plane equation across the Z-up to Y-up rotation', () => {
    const p = planeToThree(plane);
    // `map` because -0: the rotation negates a zero component.
    expect(p.normal.toArray().map((v) => v + 0)).toEqual([0, 1, 0]);
    // three writes `dot(n, x) + constant = 0`; a point at Quake z = 120 is
    // three y = 120 and must sit on the plane.
    expect(p.distanceToPoint(new Vector3(5, 120, 5))).toBeCloseTo(0);
  });

  it('flips the y extent in both sign and order', () => {
    const b = boundsToThree(plane);
    expect(b.min.toArray()).toEqual([-296, 120, -392]);
    expect(b.max.toArray()).toEqual([408, 120, 952]);
    // A degenerate box must still be a box: min <= max on every axis.
    expect(b.isEmpty()).toBe(false);
  });
});

// ---------------------------------------------------------------- the mirror

describe('mirrorCamera', () => {
  const water = new Plane(new Vector3(0, 1, 0), 0);

  const mainCamera = (): PerspectiveCamera => {
    const camera = new PerspectiveCamera(90, 16 / 9, 4, 32768);
    // Above the water, off to one side, looking down at it -- the side
    // camera's kind of pose, with some roll-free yaw so x and z both matter.
    camera.position.set(100, 50, 200);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    return camera;
  };

  it('puts the virtual eye at the mirror image of the real one', () => {
    const camera = mainCamera();
    const virtual = new PerspectiveCamera();
    mirrorCamera(camera, water, virtual, WebGPUCoordinateSystem);
    expect(virtual.position.toArray().map((v) => Math.round(v * 1000) / 1000)).toEqual([
      100, -50, 200,
    ]);
  });

  it('projects a point on the plane to (-x, y): the flipX identity', () => {
    /*
     * This is the property `bsp-mesh.ts` depends on, and the reason the
     * surface needs no texture matrix. Checked at several points across the
     * plane, including off-centre ones where a wrong-handed frame would show
     * up as a y or a scale error rather than a sign flip.
     */
    const camera = mainCamera();
    const virtual = new PerspectiveCamera();
    mirrorCamera(camera, water, virtual, WebGPUCoordinateSystem);

    for (const [x, z] of [
      [0, 0],
      [30, -40],
      [-80, 60],
      [150, 120],
    ]) {
      const p = new Vector3(x, 0, z);
      const main = p.clone().project(camera);
      const mirrored = p.clone().project(virtual);
      expect(mirrored.x).toBeCloseTo(-main.x, 5);
      expect(mirrored.y).toBeCloseTo(main.y, 5);
    }
  });

  it('clips at the water: below is behind the near plane, above is in range', () => {
    const camera = mainCamera();
    const virtual = new PerspectiveCamera();
    mirrorCamera(camera, water, virtual, WebGPUCoordinateSystem);

    // WebGPU depth is [0, 1] with the near plane at 0. The oblique projection
    // puts the WATER at 0, so anything under it comes out negative -- the
    // pool floor, which a reflection must not contain.
    const floor = new Vector3(20, -30, -20).project(virtual);
    expect(floor.z).toBeLessThan(0);

    const wall = new Vector3(20, 40, -20).project(virtual);
    expect(wall.z).toBeGreaterThanOrEqual(0);
    expect(wall.z).toBeLessThanOrEqual(1);

    // And the surface itself is exactly on the boundary.
    const surface = new Vector3(20, 0, -20).project(virtual);
    expect(surface.z).toBeCloseTo(0, 5);
  });

  it('stamps the main camera onto the renderer coordinate system first', () => {
    // A camera that has never rendered carries the GL projection. Copying
    // that into the virtual camera would have the renderer recompute it --
    // and discard the clip plane -- on first use.
    const camera = mainCamera();
    const virtual = new PerspectiveCamera();
    mirrorCamera(camera, water, virtual, WebGPUCoordinateSystem);
    expect(camera.coordinateSystem).toBe(WebGPUCoordinateSystem);
    expect(virtual.coordinateSystem).toBe(WebGPUCoordinateSystem);
  });

  it('keeps the inverse projection in step with the oblique one', () => {
    const camera = mainCamera();
    const virtual = new PerspectiveCamera();
    mirrorCamera(camera, water, virtual, WebGPUCoordinateSystem);
    const p = new Vector3(20, 40, -20);
    const back = p.clone().project(virtual).unproject(virtual);
    expect(back.distanceTo(p)).toBeLessThan(1e-6);
  });
});
