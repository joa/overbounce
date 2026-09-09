/**
 * The rail beam: `CG_RailTrail` (cg_weapons.c:215) drawn the way
 * `RB_SurfaceRailCore` (tr_surface.c:484) draws an `RT_RAIL_CORE`.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `.agent/plans/RAILGUN.md` is the plan this was built from; the constants
 * are cited there. What is here is the DEFAULT look -- `cg_oldRail 1`, the
 * core alone -- because that is what Quake ships with. The `railDisc` rings
 * of `cg_oldRail 0` are not drawn.
 *
 * ## What a core is
 *
 * One quad from `start` to `end`, `r_railCoreWidth` (6) either side of the
 * line, facing the camera:
 *
 *     VectorSubtract( start, backEnd.viewParms.or.origin, v1 );
 *     VectorSubtract( end,   backEnd.viewParms.or.origin, v2 );
 *     CrossProduct( v1, v2, right );
 *
 * -- `right` is perpendicular to the plane the eye and the beam span, which
 * is the one orientation that never shows the quad edge-on. It has to be
 * recomputed per frame from wherever the camera now is, and here the camera
 * is hundreds of units to the side of the player, so it is nothing like the
 * player's own `right`.
 *
 * `DoRailCore` (tr_surface.c:338) has one quirk that is ported rather than
 * tidied: the FIRST vertex alone gets `shaderRGBA * 0.25`, the other three
 * the full colour. It gives the muzzle end a dark corner.
 *
 * ## Colour and fade
 *
 * The beam is the player's `color1` -- Quake's default is `"4"`, which
 * `CG_ColorFromString` turns into pure red. `CG_RailTrail` sets the local
 * entity's colour to `color1 * 0.75` and its type to `LE_FADE_RGB`, and
 * `CG_AddFadeRGB` (cg_localents.c:332) then rewrites `shaderRGBA` every frame
 * as `color * remaining-fraction`. The initial full-strength `shaderRGBA` is
 * therefore never drawn: 0.75 is the brightest the beam ever is, on the
 * first frame, and it is gone `cg_railTrailTime` (400ms) later.
 *
 * `railCore` (`scripts/weapon_railgun.shader`): `blendfunc add`, `rgbGen
 * vertex`, `tcMod scroll -1 0` on `models/weapons2/railgun/railcore.tga`,
 * with `u` running `0 .. len / 256` along the beam.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  RepeatWrapping,
} from 'three/webgpu';
import type { Object3D, Texture } from 'three/webgpu';
import type { Vec3 } from '../math/vec3.js';
import { applyAdditiveBlend } from './blend.js';
import { freezeTransform } from './transform.js';

/** `cg_railTrailTime`, cg_main.c:237. */
export const RAIL_TRAIL_TIME = 400;
/** `r_railCoreWidth`, tr_init.c:940. Half the beam's width. */
export const RAIL_CORE_WIDTH = 6;
/** `color1` "4" (cl_main.c:2356) through `CG_ColorFromString`: red. */
export const RAIL_COLOR: readonly [number, number, number] = [1, 0, 0];
/** `le->color = ci->color1 * 0.75`, cg_weapons.c:251-253. */
const RAIL_COLOR_SCALE = 0.75;
/** `t = len / 256.0f`, tr_surface.c:342 -- one texture repeat per 256 units. */
const RAIL_TEXTURE_LENGTH = 256;

/**
 * How many beams can be alive at once. The rail fires every 1500ms and a beam
 * lasts 400, so one is the steady state; the headroom is for a restart that
 * fires again before the last beam of the previous life has faded.
 */
const POOL_SIZE = 4;

interface Beam {
  mesh: Mesh;
  material: MeshBasicNodeMaterial;
  positions: Float32Array;
  uvs: Float32Array;
  start: [number, number, number];
  end: [number, number, number];
  /** Visual-clock ms this beam was fired. 0 means the slot is free. */
  born: number;
}

export interface RailTrailOptions {
  /** The Quake-space world group. */
  parent: Object3D;
  /** `railcore.tga`, or null to draw the beam as flat colour. */
  texture: Texture | null;
}

export class RailTrail {
  private readonly group = new Group();
  private readonly beams: Beam[] = [];
  private readonly texture: Texture | null;

  constructor(options: RailTrailOptions) {
    this.texture = options.texture;
    if (this.texture) {
      this.texture.wrapS = RepeatWrapping;
      this.texture.needsUpdate = true;
    }
    freezeTransform(this.group);
    options.parent.add(this.group);

    for (let i = 0; i < POOL_SIZE; i++) {
      this.beams.push(this.makeBeam());
    }
  }

  private makeBeam(): Beam {
    const material = new MeshBasicNodeMaterial({
      map: this.texture,
      vertexColors: true,
      depthWrite: false,
      side: DoubleSide, // `cull disable`
    });
    applyAdditiveBlend(material);

    const positions = new Float32Array(4 * 3);
    const uvs = new Float32Array(4 * 2);
    // `rgbGen vertex`, with DoRailCore's quirk: vertex 0 at a quarter.
    const colors = new Float32Array([0.25, 0.25, 0.25, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    // tr_surface.c:388-395: (0,1,2) and (2,1,3).
    geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1));

    const mesh = new Mesh(geometry, material);
    mesh.visible = false;
    // `sort nearest`: after everything opaque and after the marks.
    mesh.renderOrder = 2;
    // The vertices are absolute world points; the mesh never moves, and the
    // bounds would be stale anyway. Same arrangement as a decal slot.
    mesh.frustumCulled = false;
    freezeTransform(mesh);
    this.group.add(mesh);

    return {
      mesh,
      material,
      positions,
      uvs,
      start: [0, 0, 0],
      end: [0, 0, 0],
      born: 0,
    };
  }

  /** `CG_AllocLocalEntity`: the free slot, or the oldest if there is none. */
  private claim(): Beam {
    let oldest = this.beams[0];
    for (const beam of this.beams) {
      if (beam.born === 0) {
        return beam;
      }
      if (beam.born < oldest.born) {
        oldest = beam;
      }
    }
    return oldest;
  }

  /**
   * `CG_RailTrail(ci, start, end)`. `start` is the game's `origin2` -- the
   * muzzle nudged 4 right and 1 down -- and `end` the snapped impact.
   */
  spawn(start: Vec3 | readonly number[], end: Vec3 | readonly number[], now: number): void {
    const beam = this.claim();
    beam.born = now;
    // `start[2] -= 4;` (cg_weapons.c:225), then under cg_oldRail:
    //     // nudge down a bit so it isn't exactly in center
    //     re->origin[2] -= 8;
    //     re->oldorigin[2] -= 8;
    // (cg_weapons.c:268-269). `re->origin` is the END and `oldorigin` the
    // START (cg_weapons.c:248-249), so both drop 8 and the start drops 12.
    beam.start[0] = start[0];
    beam.start[1] = start[1];
    beam.start[2] = start[2] - 4 - 8;
    beam.end[0] = end[0];
    beam.end[1] = end[1];
    beam.end[2] = end[2] - 8;

    const len = Math.hypot(
      beam.end[0] - beam.start[0],
      beam.end[1] - beam.start[1],
      beam.end[2] - beam.start[2],
    );
    const t = len / RAIL_TEXTURE_LENGTH;
    // tr_surface.c: (0,0) (0,1) (t,0) (t,1).
    beam.uvs.set([0, 0, 0, 1, t, 0, t, 1]);
    (beam.mesh.geometry.attributes.uv as BufferAttribute).needsUpdate = true;

    beam.mesh.visible = true;
  }

  /**
   * Per frame: age out, fade, and re-face every live beam to `eye` -- the
   * camera in Quake coordinates, `backEnd.viewParms.or.origin`.
   */
  update(now: number, eye: ArrayLike<number>): void {
    if (this.texture) {
      // `tcMod scroll -1 0`: one texture width per second, towards the muzzle.
      //
      // Driven through `Texture.offset`, which a node material's `map` reads
      // via the texture's own uv matrix (`TextureNode` refreshes it each frame
      // while `matrixAutoUpdate` is on). The beam and its colour fade were
      // verified on screen (2026-09-09); the scroll was NOT -- a 400ms beam
      // is too short to catch twice in a screenshot. If it turns out static,
      // the fix is a TSL `uv()` offset the way `smoke-trail.ts` animates.
      this.texture.offset.x = -((now / 1000) % 1);
    }

    for (const beam of this.beams) {
      if (beam.born === 0) {
        continue;
      }
      const remaining = beam.born + RAIL_TRAIL_TIME - now;
      if (remaining <= 0) {
        beam.born = 0;
        beam.mesh.visible = false;
        continue;
      }

      // CG_AddFadeRGB: `c = (endTime - cg.time) * lifeRate`, colour times c.
      const c = (RAIL_COLOR_SCALE * remaining) / RAIL_TRAIL_TIME;
      beam.material.color.setRGB(RAIL_COLOR[0] * c, RAIL_COLOR[1] * c, RAIL_COLOR[2] * c);

      const s = beam.start;
      const e = beam.end;
      // v1 = normalize(start - eye), v2 = normalize(end - eye), right = v1 x v2.
      let v1x = s[0] - eye[0];
      let v1y = s[1] - eye[1];
      let v1z = s[2] - eye[2];
      let v2x = e[0] - eye[0];
      let v2y = e[1] - eye[1];
      let v2z = e[2] - eye[2];
      const l1 = Math.hypot(v1x, v1y, v1z) || 1;
      const l2 = Math.hypot(v2x, v2y, v2z) || 1;
      v1x /= l1;
      v1y /= l1;
      v1z /= l1;
      v2x /= l2;
      v2y /= l2;
      v2z /= l2;
      let rx = v1y * v2z - v1z * v2y;
      let ry = v1z * v2x - v1x * v2z;
      let rz = v1x * v2y - v1y * v2x;
      let rl = Math.hypot(rx, ry, rz);
      if (rl < 1e-6) {
        // The eye is on the beam's own line: Quake's normalize leaves a zero
        // vector and the quad collapses. Any perpendicular is better than
        // nothing -- cross with world up, and with +X if the beam IS up.
        const dx = e[0] - s[0];
        const dy = e[1] - s[1];
        const dz = e[2] - s[2];
        rx = dy;
        ry = -dx;
        rz = 0;
        rl = Math.hypot(rx, ry, rz);
        if (rl < 1e-6) {
          rx = 0;
          ry = dz;
          rz = -dy;
          rl = Math.hypot(rx, ry, rz) || 1;
        }
      }
      rx = (rx / rl) * RAIL_CORE_WIDTH;
      ry = (ry / rl) * RAIL_CORE_WIDTH;
      rz = (rz / rl) * RAIL_CORE_WIDTH;

      const p = beam.positions;
      // start + right, start - right, end + right, end - right.
      p[0] = s[0] + rx;
      p[1] = s[1] + ry;
      p[2] = s[2] + rz;
      p[3] = s[0] - rx;
      p[4] = s[1] - ry;
      p[5] = s[2] - rz;
      p[6] = e[0] + rx;
      p[7] = e[1] + ry;
      p[8] = e[2] + rz;
      p[9] = e[0] - rx;
      p[10] = e[1] - ry;
      p[11] = e[2] - rz;
      (beam.mesh.geometry.attributes.position as BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    for (const beam of this.beams) {
      beam.mesh.geometry.dispose();
      beam.material.dispose();
    }
    this.group.removeFromParent();
  }
}
