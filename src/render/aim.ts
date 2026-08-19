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

/**
 * How far to lift the impact point off the surface it landed on, in Q3 units.
 *
 * The trace endpoint lies exactly ON the plane, so a depth-tested dot centred
 * there is half buried and z-fights with the wall over the other half. Quake
 * has the same problem with bullet marks and solves it the same way --
 * `CG_ImpactMark` offsets along the normal before building the polygon.
 *
 * 2 units against a dot of radius 3.5: enough to clear the surface and its
 * depth precision, small enough that the dot still reads as touching it.
 */
const SURFACE_PULLBACK = 2;

export type AimTraceFn = (
  results: TraceResult,
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  contentMask: number,
) => void;

/** What the laser found where it landed. */
export interface AimHit {
  point: [number, number, number];
  /** The surface normal's z. 1 is a flat floor; 0 a wall. */
  normalZ: number;
  /** Nothing was within range. */
  missed: boolean;
}

export interface AimLaser {
  object: Object3D;
  /** Recompute from the player's current state. */
  update(ps: PlayerState): AimHit;
  /**
   * Recolour the impact dot.
   *
   * The dot is the only part of the HUD that lives where the player is
   * looking, so it is where an overbounce readout belongs: a letter in the
   * corner makes you choose between watching your aim and watching the
   * indicator.
   */
  setHitColor(color: number): void;
  setVisible(visible: boolean): void;
}

export interface AimLaserOptions {
  trace: AimTraceFn;
  contentMask: number;
  color?: number;
  /**
   * `?laser=xray` -- draw through everything, which is what this used to do.
   *
   * The default is depth tested, because the laser drawing over the PLAYER'S
   * OWN MODEL is a rendering fault: the muzzle is inside the torso, so the
   * first stretch of the line always crossed the player's chest.
   *
   * The x-ray mode is kept because it is not only a bug. From a side view the
   * camera can end up with level geometry between it and the player, and an
   * aim indicator that a wall can hide is an aim indicator that fails exactly
   * when the shot is hardest. Which of the two costs more depends on the map,
   * so it is a switch rather than a decision.
   */
  xray?: boolean;
}

export function createAimLaser(options: AimLaserOptions): AimLaser {
  const group = new Group();

  // A two-point line whose second vertex is rewritten every frame.
  const geometry = new BufferGeometry();
  const positions = new Float32Array(6);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));

  /*
   * DEPTH TESTED, and it did not used to be.
   *
   * `depthTest: false` was here so the laser could not vanish behind the
   * geometry it is aimed at -- but that is not what it was protecting against.
   * The line ENDS at what the trace hit, so the only thing it can be swallowed
   * by is that surface itself, and that is z-fighting rather than occlusion.
   * `SURFACE_PULLBACK` below fixes the actual problem, and it fixes it without
   * the side effect: with the depth test off the laser also drew straight
   * through the player MODEL, which is what it was reported as. The muzzle is
   * inside the torso, so the first stretch of the line always crossed the
   * player's own chest.
   *
   * What the old setting DID buy is real and is kept behind `?laser=xray`: a
   * side camera can end up with level geometry between it and the player, and
   * an aim indicator a wall can hide fails exactly when the shot is hardest.
   */
  const line = new Line(
    geometry,
    new LineBasicMaterial({
      color: options.color ?? 0xff4d4d,
      transparent: true,
      opacity: 0.45,
      depthTest: !options.xray,
    }),
  );
  // Still drawn last, so it composites over other transparent things rather
  // than being sorted against them by distance.
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
      depthTest: !options.xray,
    }),
  );
  dot.renderOrder = 1000;
  group.add(dot);

  const forward = vec3();
  const muzzle = vec3();
  const end = vec3();
  const pulled = vec3();
  const results = createTrace();

  return {
    object: group,

    update(ps: PlayerState): AimHit {
      angleVectors(ps.viewangles, forward, null, null);
      // The same muzzle the weapon code uses, so the laser cannot disagree with
      // where a rocket actually comes from.
      calcMuzzlePoint(ps, forward, muzzle);
      vectorMA(muzzle, MAX_RANGE, forward, end);

      // A ray, not a box: this is a shot, and Quake traces shots as points.
      options.trace(results, muzzle, vec3(), vec3(), end, options.contentMask);

      /*
       * Lift the endpoint off the surface before drawing it. See
       * `SURFACE_PULLBACK`: now that the laser is depth tested, an endpoint
       * exactly on the plane z-fights with it.
       *
       * Along the NORMAL rather than back down the ray, so the offset is the
       * same however obliquely the shot landed -- a grazing hit pulled back
       * along the ray would move the dot a long way from where the rocket goes.
       * `fraction >= 1` means nothing was hit and there is no plane, so the
       * normal is zero and this is a no-op, which is correct.
       */
      const hit = results.endpos;
      /*
       * `drawn` is the RENDER position and `hit` is the answer. Keeping them
       * separate is not fastidiousness: `point` feeds `classifyOverbounce`,
       * which decides an overbounce from the drop height, and folding two
       * units of render offset into it would move a prediction. The offset is
       * a depth-buffer workaround and must not leave this file's geometry.
       */
      const drawn = vectorMA(hit, SURFACE_PULLBACK, results.plane.normal, pulled);
      positions[0] = muzzle[0];
      positions[1] = muzzle[1];
      positions[2] = muzzle[2];
      positions[3] = drawn[0];
      positions[4] = drawn[1];
      positions[5] = drawn[2];
      geometry.attributes.position.needsUpdate = true;
      geometry.computeBoundingSphere();

      dot.position.set(drawn[0], drawn[1], drawn[2]);
      // Nothing was hit within range, so there is no impact point to mark.
      dot.visible = results.fraction < 1;

      return {
        point: [hit[0], hit[1], hit[2]],
        normalZ: results.plane.normal[2],
        missed: results.fraction >= 1,
      };
    },

    setHitColor(color: number): void {
      (dot.material as MeshBasicNodeMaterial).color.setHex(color);
      (line.material as LineBasicMaterial).color.setHex(color);
    },

    setVisible(visible: boolean): void {
      group.visible = visible;
    },
  };
}
