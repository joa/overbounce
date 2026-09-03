/**
 * A rocket's smoke trail, both ways.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `.agent/plans/SMOKE-TRAIL.md` is the plan this was built from.
 *
 * Two techniques behind `?trail=`, and they are not two dressings of one
 * effect -- they emit on different clocks and draw with different shaders.
 *
 *   - **faithful** is `CG_RocketTrail` (cg_weapons.c:325), ported. Sprites of
 *     `gfx/misc/smokepuff3.tga` on absolute 50ms boundaries, growing 8 -> 72
 *     units while they fade out over two seconds. Every constant here was read
 *     out of the C and is cited where it is used.
 *   - **modern** keeps the emission rhythm and replaces the flat sprite with a
 *     short raymarch through a noise field, so a puff has interior structure
 *     that churns and thins instead of a picture of smoke that shrinks in
 *     opacity.
 *
 * ## Why the march lives in the billboard and not in the post chain
 *
 * A fullscreen pass costs the same whether or not anything is on fire, and
 * this renderer has just been reminded what that is worth: the shadow work in
 * `.agent/plans/LIGHT-SHADOWS.md` took q3ctf2 from 60fps to 39 by adding
 * per-frame passes. Marching inside the quad costs in proportion to the puff's
 * area on screen, so an empty map costs nothing at all and a trail costs what
 * you can see of it. A rocket at 900ups holds about 40 puffs alive at once
 * (2000ms of life, one every 50ms), which is the number the step count below
 * is chosen against.
 */

import { Group, Sprite, SpriteNodeMaterial } from 'three/webgpu';
import type { Object3D, Texture } from 'three/webgpu';
import {
  Fn,
  Loop,
  float,
  positionLocal,
  smoothstep,
  triNoise3D,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import type { Vec3 } from '../math/vec3.js';
import type { Trajectory } from '../game/trajectory.js';
import { evaluateTrajectory, TrType } from '../game/trajectory.js';
import { applyAlphaBlend } from './blend.js';

/** `?trail=`. `off` is `cg_noProjectileTrail` (cg_weapons.c:334). */
export type TrailMode = 'modern' | 'faithful' | 'off';

/**
 * `step`, cg_weapons.c:340. Puffs land on ABSOLUTE multiples of this, so the
 * spacing of a trail does not depend on frame timing.
 */
export const TRAIL_STEP_MS = 50;

/** `wi->wiTrailTime`, cg_weapons.c:746. */
export const TRAIL_TIME_MS = 2000;

/** `wi->trailRadius`, cg_weapons.c:747. */
export const TRAIL_RADIUS = 64;

/** `CG_SmokePuff`'s alpha for a rocket trail, cg_weapons.c:374. */
export const TRAIL_ALPHA = 0.33;

/**
 * The first emission time at or after `since`.
 *
 * `t = step * ( (startTime + step) / step )` -- cg_weapons.c:346, and the
 * division is C INTEGER division, which is the whole point of the line. It
 * snaps the next puff onto the 50ms grid rather than placing it 50ms after
 * whenever the last frame happened to land.
 */
export function firstPuffTime(since: number): number {
  return TRAIL_STEP_MS * Math.floor((since + TRAIL_STEP_MS) / TRAIL_STEP_MS);
}

/**
 * `CG_AddScaleFade`, cg_localents.c -- a puff's radius and alpha at `now`.
 *
 * `c` runs 1 at birth to 0 at death, and both curves are written in terms of
 * it, which is why the radius GROWS: `le->radius * (1 - c) + 8`. Returns null
 * once the puff is over.
 */
export function puffAt(
  born: number,
  now: number,
): { radius: number; alpha: number } | null {
  const end = born + TRAIL_TIME_MS;
  if (now >= end || now < born) {
    return null;
  }
  const c = (end - now) / TRAIL_TIME_MS;
  return { radius: TRAIL_RADIUS * (1 - c) + 8, alpha: c * TRAIL_ALPHA };
}

export function parseTrailMode(search: string | URLSearchParams): TrailMode {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const raw = params.get('trail');
  if (raw === null) {
    return 'modern';
  }
  const v = raw.trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'none' || v === 'no') {
    return 'off';
  }
  if (v === 'faithful' || v === 'q3' || v === 'classic' || v === 'sprite') {
    return 'faithful';
  }
  if (v === 'modern' || v === '' || v === '1' || v === 'volumetric') {
    return 'modern';
  }
  console.warn(`[overbounce] ignoring ?trail=${raw}: expected modern, faithful or off`);
  return 'modern';
}

/** One live puff. Pooled -- see `effects.ts` on why the churn is real. */
interface Puff {
  sprite: Sprite;
  material: SpriteNodeMaterial;
  /** Level time it was emitted at, which is a 50ms boundary. */
  born: number;
  /** 0 when free. */
  until: number;
}

export interface SmokeTrailOptions {
  parent: Object3D;
  mode: TrailMode;
  /**
   * `gfx/misc/smokepuff3.tga`, or null when no pak carries it.
   *
   * Only `faithful` needs it -- the march generates its own density -- so a
   * missing texture downgrades that one mode rather than the feature.
   */
  texture: Texture | null;
  /** Enough for a rocket's 40 plus a few plasma balls' worth. */
  count?: number;
}

/**
 * The `modern` puff's material.
 *
 * `positionLocal` on a `Sprite` runs across the quad in its own space, which
 * is what gives the march a ray to walk without needing the camera: the quad
 * already faces the viewer, so marching along its local `z` IS marching
 * toward the eye. Cheap, and it is why this does not need a depth texture or
 * a fullscreen pass to look like it has volume.
 *
 * 10 steps. Enough to read as depth rather than as a disc, few enough that 40
 * live puffs across a screen do not become the frame's cost -- and unlike a
 * post pass, a frame with no rocket in it runs none of this at all.
 */
function marchedMaterial(time: { value: number }, seed: number): SpriteNodeMaterial {
  const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
  const clock = uniform(0).onFrameUpdate(() => time.value);
  /** 0 at birth, 1 at death. Written each frame by `update`. */
  const age = uniform(0);

  material.colorNode = Fn(() => {
    // The quad's own coordinates, -0.5..0.5. `r` is how far out from the
    // centre the fragment is, and the march walks a chord of the sphere that
    // fits the quad.
    const p = positionLocal.xy;
    const r2 = p.dot(p).mul(4);
    const density = float(0).toVar();
    const halfChord = smoothstep(1, 0, r2).mul(0.5);

    Loop({ start: 0, end: 10, type: 'int' }, ({ i }) => {
      const k = float(i).mul(0.1).sub(0.45);
      const z = k.mul(halfChord).mul(2);
      const sample = vec3(p.x.mul(2), p.y.mul(2), z.mul(2));
      // Time on the fourth axis, so the interior CHURNS rather than merely
      // fading -- the difference between smoke and a picture of smoke. The
      // per-puff seed keeps two puffs from breathing in unison.
      const n = triNoise3D(sample.mul(0.7).add(vec3(seed, seed, 0)), 0.35, clock);
      // Softer toward the sphere's rim, and thinner as the puff ages: the
      // "disappears over time" is a loss of DENSITY, not only of opacity, so
      // an old puff goes wispy instead of merely transparent.
      const falloff = smoothstep(1, 0.15, r2);
      density.addAssign(n.mul(falloff).mul(float(1).sub(age.mul(0.65))));
    });

    const d = density.mul(0.22).clamp(0, 1);
    // Lit slightly from the top, like Quake's own puff texture is painted.
    const shade = float(0.62).add(p.y.mul(0.25));
    return vec4(vec3(shade), d);
  })();

  applyAlphaBlend(material);
  (material as unknown as { obAge: typeof age }).obAge = age;
  return material;
}

export interface SmokeTrail {
  readonly mode: TrailMode;
  /**
   * What is alive right now, for `npm run shot -- --eval`.
   *
   * "Is the trail drawing at all" is a question a screenshot answers badly --
   * a puff can be present and subtle, or absent while something else moved --
   * and every A/B of this against a control had to fight that.
   */
  debug(): { live: number; textured: boolean; scales: number[]; alphas: number[] };
  /**
   * Emit whatever `missile` owes between `since` and `now`.
   *
   * Returns the new trail time, which the caller stores per missile -- Quake
   * keeps it on the entity as `ent->trailTime` and this cannot be global,
   * since two rockets in the air are on independent 50ms grids only by
   * accident of when they were fired.
   */
  emit(pos: Trajectory, since: number, now: number): number;
  update(now: number, viewOrigin: ArrayLike<number>): void;
  dispose(): void;
}

export function createSmokeTrail(options: SmokeTrailOptions): SmokeTrail {
  const group = new Group();
  options.parent.add(group);
  const pool: Puff[] = [];
  const time = { value: 0 };
  const count = options.count ?? 64;

  for (let i = 0; i < count; i++) {
    const material =
      options.mode === 'modern'
        ? marchedMaterial(time, i * 0.37)
        : (() => {
            /*
             * `map` at CONSTRUCTION, not assigned afterwards. A
             * `NodeMaterial` builds its node graph from the properties it has
             * when it is made; a map attached later is not guaranteed to be
             * picked up, and the symptom is a white sprite rather than an
             * error. `explosion-fx.ts` passes it in the constructor for the
             * same reason.
             */
            const m = new SpriteNodeMaterial(
              options.texture
                ? { map: options.texture, depthWrite: false }
                : { depthWrite: false },
            );
            applyAlphaBlend(m);
            return m;
          })();
    const sprite = new Sprite(material);
    sprite.visible = false;
    // `cull none` in the shader, and a sprite has no back face anyway.
    sprite.frustumCulled = false;
    group.add(sprite);
    pool.push({ sprite, material, born: 0, until: 0 });
  }

  const scratch: Vec3 = [0, 0, 0] as unknown as Vec3;

  const claim = (now: number): Puff | null => {
    for (const p of pool) {
      if (p.until <= now) {
        return p;
      }
    }
    return null;
  };

  return {
    mode: options.mode,

    debug() {
      const live = pool.filter((p) => p.sprite.visible);
      return {
        live: live.length,
        // Whether the puff sprite actually got Quake's texture, which a
        // picture cannot tell you: an untextured puff is a white disc and
        // reads as "the trail is faint" rather than "the map never bound".
        textured: pool[0]?.material.map !== null && pool[0]?.material.map !== undefined,
        scales: live.map((p) => p.sprite.scale.x),
        alphas: live.map((p) => p.material.opacity),
      };
    },

    emit(pos: Trajectory, since: number, now: number): number {
      if (options.mode === 'off') {
        return now;
      }
      /*
       * `if ( es->pos.trType == TR_STATIONARY )` -- cg_weapons.c:352. A
       * grenade lying on the floor stops smoking, and it does so by
       * advancing its trail time so it does not emit a burst when it moves
       * again.
       */
      if (pos.trType === TrType.STATIONARY) {
        return now;
      }

      for (let t = firstPuffTime(since); t <= now; t += TRAIL_STEP_MS) {
        const puff = claim(now);
        if (!puff) {
          break;
        }
        // The puff goes where the missile WAS at `t`, not where it is now:
        // `BG_EvaluateTrajectory( &es->pos, t, lastPos )`, cg_weapons.c:369.
        evaluateTrajectory(pos, t, scratch);
        puff.born = t;
        puff.until = t + TRAIL_TIME_MS;
        puff.sprite.position.set(scratch[0], scratch[1], scratch[2]);
        // `re->rotation = Q_random( &seed ) * 360`, cg_effects.c. Once, fixed
        // for the puff's life -- Quake never spins it.
        puff.material.rotation = Math.random() * Math.PI * 2;
        puff.sprite.visible = true;
      }
      return now;
    },

    update(now: number, viewOrigin: ArrayLike<number>): void {
      time.value = now / 1000;
      for (const p of pool) {
        if (p.until <= now) {
          if (p.sprite.visible) {
            p.sprite.visible = false;
            p.until = 0;
          }
          continue;
        }
        const at = puffAt(p.born, now);
        if (!at) {
          p.sprite.visible = false;
          p.until = 0;
          continue;
        }

        /*
         * "if the view would be 'inside' the sprite, kill the sprite so it
         * doesn't add too much overdraw" -- cg_localents.c. An overdraw guard
         * that is also visible behaviour: a puff vanishes as you fly through
         * it, and a port that quietly kept it would look different.
         *
         * Quake compares against `le->radius`, the FINAL radius, not the
         * current one.
         */
        const dx = p.sprite.position.x - viewOrigin[0];
        const dy = p.sprite.position.y - viewOrigin[1];
        const dz = p.sprite.position.z - viewOrigin[2];
        if (Math.hypot(dx, dy, dz) < TRAIL_RADIUS) {
          p.sprite.visible = false;
          p.until = 0;
          continue;
        }

        p.sprite.scale.setScalar(at.radius * 2);
        if (options.mode === 'modern') {
          const age = (material: SpriteNodeMaterial): { value: number } | undefined =>
            (material as unknown as { obAge?: { value: number } }).obAge;
          const a = age(p.material);
          if (a) {
            a.value = 1 - at.alpha / TRAIL_ALPHA;
          }
          p.material.opacity = 1;
        } else {
          p.material.opacity = at.alpha;
        }
      }
    },

    dispose(): void {
      for (const p of pool) {
        group.remove(p.sprite);
        p.material.dispose();
      }
      options.parent.remove(group);
    },
  };
}
