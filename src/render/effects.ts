/**
 * Projectile visuals: rocket models, smoke trails and explosions.
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
 * 800ms, but a plasma gun fires every 100ms and each ball can spawn trail
 * puffs, so the churn is real and a pool keeps it off the GC.
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
  smokeCount?: number;
  explosionCount?: number;
}

/**
 * Point an object along a direction, Quake style.
 *
 * A rocket MD3 models along +x, so the visible orientation is just yaw and
 * pitch derived from the velocity. Roll is meaningless for a projectile.
 */
export function orientAlong(object: Object3D, dir: Vec3 | readonly number[]): void {
  const yaw = Math.atan2(dir[1], dir[0]);
  const flat = Math.hypot(dir[0], dir[1]);
  const pitch = Math.atan2(dir[2], flat);

  object.rotation.set(0, 0, 0);
  object.rotation.z = yaw;
  object.rotation.y = -pitch;
}

export class Effects {
  private readonly smoke: Particle[] = [];
  private readonly explosions: Particle[] = [];
  private readonly group = new Group();

  constructor(options: EffectsOptions) {
    options.parent.add(this.group);

    const smokeGeom = new SphereGeometry(1, 6, 5);
    for (let i = 0; i < (options.smokeCount ?? 160); i++) {
      this.smoke.push(this.makeParticle(smokeGeom, 0x9a9aa2, false));
    }

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

  /**
   * A puff of rocket smoke.
   *
   * Q3's trail is a stream of short-lived sprites left at the projectile's
   * position, drifting slightly and growing as they fade. Reproduced with
   * geometry rather than sprites because the renderer has no sprite path yet.
   */
  spawnSmoke(origin: Vec3 | readonly number[], now: number): void {
    const p = this.claim(this.smoke, now);
    if (!p) {
      return;
    }

    p.born = now;
    p.until = now + 700;
    p.startScale = 3;
    p.endScale = 11;
    p.startAlpha = 0.32;
    // A gentle upward drift, so a trail reads as smoke rather than a dotted line.
    p.velocity = [
      (Math.random() - 0.5) * 14,
      (Math.random() - 0.5) * 14,
      10 + Math.random() * 16,
    ];

    p.mesh.position.set(origin[0], origin[1], origin[2]);
    p.mesh.visible = true;
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
    for (const pool of [this.smoke, this.explosions]) {
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
      }
    }
  }
}
