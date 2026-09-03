/**
 * Projectile visuals: rocket models and the classic explosion.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Everything here is presentation and nothing here feeds back into the
 * simulation. A trail puff that has drifted, an explosion mid-expansion and a
 * rocket's visible orientation are all derived from state the game layer has
 * already decided; delete this file and the physics is unchanged.
 *
 * Effects are pooled rather than allocated. A rocket launcher fires every
 * 800ms but a plasma gun fires every 100ms, so the churn is real and a pool
 * keeps it off the GC.
 *
 * The SMOKE TRAIL used to live here as a pool of grey spheres drifting
 * upward, under a comment saying it was geometry "because the renderer has no
 * sprite path yet". It has one now, and the trail moved to `smoke-trail.ts`,
 * where it is either a port of `CG_RocketTrail` or a raymarch depending on
 * `?trail=`. What is left here is the classic flat-colour explosion, which
 * stays as the look when no pak is mounted.
 */

import type {
  Object3D} from 'three/webgpu';
import {
  AdditiveBlending,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
} from 'three/webgpu';
import type { Vec3 } from '../math/vec3.js';
import { freezeTransform } from './transform.js';

/** A pooled, self-expiring visual. */
interface Particle {
  mesh: Mesh;
  /** Level time in ms when this becomes free again. 0 means free now. */
  until: number;
  born: number;
  velocity: [number, number, number];
  startScale: number;
  endScale: number;
  startAlpha: number;
}

export interface EffectsOptions {
  /** Where to add the meshes. Expected to be the Quake-space world group. */
  parent: Object3D;
  explosionCount?: number;
}

/**
 * Point an object along a direction, Quake style.
 *
 * A rocket MD3 models along +x, so the orientation is a yaw about Z and a
 * pitch about Y, taken off the direction of travel. `CG_Missile` builds the
 * same thing as an axis outright: `VectorNormalize2( s1->pos.trDelta,
 * ent.axis[0] )`, with `axis[0][2] = 1` when that direction is degenerate.
 *
 * **THE EULER ORDER IS THE WHOLE FUNCTION.** three's default is `'XYZ'`, which
 * composes `R = Rx * Ry * Rz` -- the Z rotation applied FIRST, and the Y pitch
 * then taken about the parent's Y axis rather than the body's own. Yaw and
 * pitch do not commute, so writing
 *
 *     object.rotation.z = yaw;
 *     object.rotation.y = -pitch;      // <- silently wrong
 *
 * points the model somewhere that is only correct when one of the two angles
 * is zero. It looked right for a year of firing to the right (yaw 0) and was
 * mirrored top-to-bottom for every shot to the LEFT: at yaw 180 the nose came
 * out at `(-cos p, 0, -sin p)` where the rocket was travelling
 * `(-cos p, 0, +sin p)`. In a sidescroller that is half of all shots, and a
 * rocket fired up-left pointed down-left -- 90 degrees out.
 *
 * `'ZYX'` composes `R = Rz * Ry * Rx`, which is Quake's own order: pitch about
 * Y, then yaw about Z, exactly `AngleVectors`. The `x` slot is roll about the
 * body's direction of travel, i.e. `RotateAroundDirection`, and is left at
 * zero -- Q3 spins its missiles there (`cg.time / 4`) and this does not.
 */
export function orientAlong(object: Object3D, dir: Vec3 | readonly number[]): void {
  // `if ( VectorNormalize2( s1->pos.trDelta, ent.axis[0] ) == 0 ) {
  //     ent.axis[0][2] = 1; }` -- a missile with no direction points up, and
  // `atan2(0, 0)` would otherwise quietly aim it along +x.
  if (dir[0] === 0 && dir[1] === 0 && dir[2] === 0) {
    object.rotation.set(0, -Math.PI / 2, 0, 'ZYX');
    return;
  }

  const yaw = Math.atan2(dir[1], dir[0]);
  const flat = Math.hypot(dir[0], dir[1]);
  const pitch = Math.atan2(dir[2], flat);

  object.rotation.set(0, -pitch, yaw, 'ZYX');
}

export class Effects {

  private readonly explosions: Particle[] = [];
  private readonly group = new Group();

  constructor(options: EffectsOptions) {
    options.parent.add(this.group);


    const boomGeom = new SphereGeometry(1, 12, 10);
    for (let i = 0; i < (options.explosionCount ?? 12); i++) {
      this.explosions.push(this.makeParticle(boomGeom, 0xffb03d, true));
    }
  }

  private makeParticle(geom: SphereGeometry, color: number, additive: boolean): Particle {
    // Each particle owns its material: they fade independently, and a shared
    // material would make every puff in the world fade with the newest one.
    const material = new MeshBasicNodeMaterial({
      color,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    if (additive) {
      material.blending = AdditiveBlending;
    }

    const mesh = new Mesh(geom, material);
    mesh.visible = false;
    /*
     * A pooled particle is idle almost all of the time, and three does not know
     * that. `updateMatrixWorld` walks the graph regardless of `visible`, so an
     * auto-updating pool pays a `compose` and a `multiplyMatrices` per particle
     * per frame whether or not anything is on fire -- a census of q3dm6 counts
     * 172 of these, out of 1012 objects in the whole scene.
     *
     * So the matrix is maintained by hand instead. Every site that writes a
     * transform below calls `updateMatrix()` immediately after; `update()`
     * skips dead particles with a `continue`, which is exactly the work being
     * saved. Forgetting one of those calls does not throw -- the particle
     * simply draws at its previous position -- so they are kept adjacent to the
     * writes rather than hoisted somewhere tidier.
     */
    freezeTransform(mesh);
    this.group.add(mesh);

    return {
      mesh,
      until: 0,
      born: 0,
      velocity: [0, 0, 0],
      startScale: 1,
      endScale: 1,
      startAlpha: 1,
    };
  }

  private claim(pool: Particle[], now: number): Particle | null {
    for (const p of pool) {
      if (p.until <= now) {
        return p;
      }
    }
    // Everything is busy. Dropping the effect is the right call: stealing the
    // oldest would make a long-lived explosion vanish mid-bloom.
    return null;
  }

  /** A detonation. */
  spawnExplosion(origin: Vec3 | readonly number[], now: number, radius = 120): void {
    const p = this.claim(this.explosions, now);
    if (!p) {
      return;
    }

    p.born = now;
    p.until = now + 500;
    // Q3's rocket splash radius is 120, and matching the visual to it means the
    // effect tells you what actually got hit rather than merely looking big.
    p.startScale = radius * 0.18;
    p.endScale = radius * 0.95;
    p.startAlpha = 1;
    p.velocity = [0, 0, 0];

    p.mesh.position.set(origin[0], origin[1], origin[2]);
    p.mesh.updateMatrix();
    p.mesh.visible = true;
  }

  /**
   * Advance every live effect. `now` is level time in ms; `dt` is seconds.
   *
   * Driven from the render loop rather than the physics tick on purpose: these
   * are decorative, so they should be smooth at the display's framerate instead
   * of stepping at 125Hz.
   */
  update(now: number, dt: number): void {
    for (const pool of [this.explosions]) {
      for (const p of pool) {
        if (p.until <= now) {
          if (p.mesh.visible) {
            p.mesh.visible = false;
          }
          continue;
        }

        const life = (now - p.born) / (p.until - p.born);
        const scale = p.startScale + (p.endScale - p.startScale) * life;
        p.mesh.scale.setScalar(scale);

        const material = p.mesh.material as MeshBasicNodeMaterial;
        // Fade on a curve rather than linearly: a linear fade reads as a hard
        // pop at the end because perceived brightness is not linear.
        material.opacity = p.startAlpha * (1 - life) * (1 - life);

        p.mesh.position.x += p.velocity[0] * dt;
        p.mesh.position.y += p.velocity[1] * dt;
        p.mesh.position.z += p.velocity[2] * dt;
        // `matrixAutoUpdate` is off for these -- see `makeParticle`.
        p.mesh.updateMatrix();
      }
    }
  }
}
