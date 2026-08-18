/**
 * The aim laser.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A side-on camera hides the thing a Quake player relies on most: where they
 * are pointing. In first person the crosshair answers that for free. From the
 * side, aim is invisible, and aim is the whole input to a rocket jump — a few
 * degrees decides whether you go up or across.
 *
 * So this traces the shot the player would actually take and draws it. Not an
 * approximation of it: the same `calcMuzzlePoint` the weapon code fires from,
 * and a real world trace against the same collision model, so the dot lands
 * exactly where a rocket would.
 */

import type { Object3D} from 'three/webgpu';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Group, Line, LineBasicMaterial, Mesh, MeshBasicNodeMaterial, SphereGeometry } from 'three/webgpu';
import { angleVectors } from '../math/angles.js';
import { vec3, vectorMA } from '../math/vec3.js';
import type { Vec3 } from '../math/vec3.js';
import type { PlayerState } from '../physics/types.js';
import type { TraceResult } from '../physics/types.js';
import { createTrace } from '../physics/types.js';
import { calcMuzzlePoint } from '../game/weapons.js';

/** How far the laser reaches before giving up. */
const MAX_RANGE = 8192;

export type AimTraceFn = (
  results: TraceResult,
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  contentMask: number,
) => void;

export interface AimLaser {
  object: Object3D;
  /** Recompute from the player's current state. Returns the impact point. */
  update(ps: PlayerState): [number, number, number];
  setVisible(visible: boolean): void;
}

export interface AimLaserOptions {
  trace: AimTraceFn;
  contentMask: number;
  color?: number;
}

export function createAimLaser(options: AimLaserOptions): AimLaser {
  const group = new Group();

  // A two-point line whose second vertex is rewritten every frame.
  const geometry = new BufferGeometry();
  const positions = new Float32Array(6);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));

  const line = new Line(
    geometry,
    new LineBasicMaterial({
      color: options.color ?? 0xff4d4d,
      transparent: true,
      opacity: 0.45,
      depthTest: false,
    }),
  );
  // Drawn last and without depth testing: a laser that disappears behind the
  // level geometry it is aimed at is worse than useless from a side view.
  line.renderOrder = 999;
  group.add(line);

  const dot = new Mesh(
    new SphereGeometry(3.5, 10, 8),
    new MeshBasicNodeMaterial({
      color: options.color ?? 0xff4d4d,
      transparent: true,
      opacity: 0.9,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  dot.renderOrder = 1000;
  group.add(dot);

  const forward = vec3();
  const muzzle = vec3();
  const end = vec3();
  const results = createTrace();

  return {
    object: group,

    update(ps: PlayerState): [number, number, number] {
      angleVectors(ps.viewangles, forward, null, null);
      // The same muzzle the weapon code uses, so the laser cannot disagree with
      // where a rocket actually comes from.
      calcMuzzlePoint(ps, forward, muzzle);
      vectorMA(muzzle, MAX_RANGE, forward, end);

      // A ray, not a box: this is a shot, and Quake traces shots as points.
      options.trace(results, muzzle, vec3(), vec3(), end, options.contentMask);

      const hit = results.endpos;
      positions[0] = muzzle[0];
      positions[1] = muzzle[1];
      positions[2] = muzzle[2];
      positions[3] = hit[0];
      positions[4] = hit[1];
      positions[5] = hit[2];
      geometry.attributes.position.needsUpdate = true;
      geometry.computeBoundingSphere();

      dot.position.set(hit[0], hit[1], hit[2]);
      // Nothing was hit within range, so there is no impact point to mark.
      dot.visible = results.fraction < 1;

      return [hit[0], hit[1], hit[2]];
    },

    setVisible(visible: boolean): void {
      group.visible = visible;
    },
  };
}
