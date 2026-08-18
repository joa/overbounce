/**
 * The blob shadow under a player.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from `cgame/cg_players.c :: CG_PlayerShadow`, which is `cg_shadows 1`
 * -- the look Quake III ships with.
 *
 * It is not a shadow in any lighting sense: it is a dark decal stamped on the
 * floor beneath the player, faded by how far above that floor they are. What it
 * buys is ground contact. Without it a model in a game viewed from outside
 * reads as hovering, and in a game about landing on exact spots that matters
 * more than it would elsewhere.
 *
 * Everything here is Quake space (Z-up). The scene's world group carries the
 * single rotation into three's Y-up at the boundary.
 */

import {
  CircleGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import type { Object3D, Texture } from 'three/webgpu';
import { texture as tslTexture, uv, vec4 } from 'three/tsl';
import type { Pk3FileSystem } from '../assets/pk3.js';
import { loadTexture } from './md3-mesh.js';

/** `SHADOW_DISTANCE`, cg_players.c:1992. How far down to look for a floor. */
export const SHADOW_DISTANCE = 128;

/**
 * The trace box. Note `mins[2] = 0` and `maxs[2] = 2`: a flat slab at the
 * player's feet, not their full bounding box. Tracing the whole hull would
 * catch a ledge beside them and put the shadow on the wrong surface.
 */
export const SHADOW_MINS: readonly [number, number, number] = [-15, -15, 0];
export const SHADOW_MAXS: readonly [number, number, number] = [15, 15, 2];

/** `CG_ImpactMark( ..., radius = 24, ... )`. */
export const SHADOW_RADIUS = 24;

/** What `markShadow` resolves to -- it has no shader script of its own. */
const SHADOW_IMAGE = 'gfx/damage/shadow';

export interface BlobShadow {
  object: Object3D;
  /**
   * Place it, or hide it.
   *
   * `fraction` is the downward trace's; `alpha = 1 - fraction` is Quake's own
   * fade, so a player at the top of a 128-unit drop casts nothing and one
   * standing on the floor casts a full blob.
   */
  place(
    point: ArrayLike<number>,
    normal: ArrayLike<number>,
    yawDegrees: number,
    fraction: number,
  ): void;
  hide(): void;
}

export async function createBlobShadow(
  fs: Pk3FileSystem | null,
): Promise<BlobShadow | null> {
  const map: Texture | null = fs ? await loadTexture(fs, SHADOW_IMAGE) : null;
  if (!map) {
    // No art, no shadow. A procedural stand-in would be inventing a look.
    return null;
  }

  const material = new MeshBasicNodeMaterial({ transparent: true });
  const sample = tslTexture(map, uv());

  /*
   * `gfx/damage/shadow.tga` is a dark blob on a transparent field, and Quake
   * draws marks with `SRC_ALPHA / ONE_MINUS_SRC_ALPHA`. Reproduced literally:
   * the texture supplies the shape through its alpha, the colour is black, and
   * the per-frame fade scales that alpha.
   *
   * The per-frame fade rides on `material.opacity` rather than a TSL uniform:
   * this material belongs to exactly one shadow, and three already multiplies
   * opacity into the alpha for a transparent material.
   */
  material.colorNode = vec4(0, 0, 0, sample.a);
  material.depthWrite = false;
  // Sits ON the floor, so it needs to win the depth tie without z-fighting.
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -1;

  // A disc, because the mark is radial. 16 segments is past the point where
  // more shows at this radius.
  const mesh = new Mesh(new CircleGeometry(SHADOW_RADIUS, 16), material);
  mesh.visible = false;
  mesh.renderOrder = 1;

  const up = new Vector3(0, 0, 1);
  const target = new Vector3();
  const spin = new Quaternion();
  const tilt = new Quaternion();

  return {
    object: mesh,

    place(point, normal, yawDegrees, fraction): void {
      mesh.visible = true;
      // `*shadowPlane = trace.endpos[2] + 1` -- lifted a unit off the surface
      // so it does not fight the floor it is lying on.
      mesh.position.set(point[0], point[1], point[2] + 1);

      // Orient the disc to the surface, then spin it to face the way the legs
      // do. `CG_ImpactMark` passes `cent->pe.legs.yawAngle` for exactly this.
      target.set(normal[0], normal[1], normal[2]);
      if (target.lengthSq() < 1e-6) {
        target.copy(up);
      }
      tilt.setFromUnitVectors(up, target.normalize());
      spin.setFromAxisAngle(up, (yawDegrees * Math.PI) / 180);
      mesh.quaternion.copy(tilt).multiply(spin);

      // `alpha = 1.0 - trace.fraction`.
      material.opacity = Math.max(0, Math.min(1, 1 - fraction));
    },

    hide(): void {
      mesh.visible = false;
    },
  };
}
