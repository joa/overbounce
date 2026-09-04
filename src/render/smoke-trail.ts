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
  cameraPosition,
  float,
  normalize,
  positionLocal,
  positionWorld,
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
 * The `modern` puff's material: one world-space volume, marched per puff.
 *
 * ## The mistake this is the fix for, because it is the obvious one
 *
 * The first two versions gave every puff its OWN noise field, sampled in the
 * quad's own local space and offset by a per-puff seed. Each puff was
 * therefore a self-contained ball of detail that agreed with none of its
 * neighbours, and forty of them along a trail read as "sprinkle balls" rather
 * than as smoke -- which is exactly how it was reported.
 *
 * Smoke is not a row of objects. It is ONE medium that the puffs are windows
 * onto. So the field here is sampled in WORLD space, at a low frequency, and
 * every puff samples the same field: where two overlap they agree by
 * construction, and the trail merges into a continuous column instead of a
 * string of beads. That single change is what the look depends on; the rest
 * below is shaping.
 *
 * `positionWorld` on a `Sprite` is the fragment's world position on a quad
 * that already faces the viewer, so marching from it along the view direction
 * sweeps a real chord through the puff's sphere -- no depth texture, no
 * fullscreen pass, and no cost at all on a frame with nothing in flight.
 *
 * ## Dissolving
 *
 * Three things happen together as a puff ages, because smoke does all three
 * and doing only one reads as a fade:
 *
 *  - it SPREADS -- Quake's own radius curve already grows it 8 -> 72 units;
 *  - it THINS -- overall density falls with age;
 *  - it BREAKS UP -- the cut the field has to clear rises, so the smoke stops
 *    being a solid mass and becomes separating wisps.
 *
 * Not fluid dynamics, and not pretending to be: there is no advection here.
 * What it is is a static low-frequency field, slowly churned by time, that
 * the puffs reveal more sparsely as they age.
 */

/**
 * Noise cells per Quake unit. ~1 unit is an inch, so this puts a feature every
 * fifty-odd units -- a bit larger than a young puff and a bit smaller than an
 * old one, which is what lets a trail read as one body of smoke with internal
 * structure rather than as either fog or grit.
 */
const WORLD_NOISE_SCALE = 0.019;

/** March steps through the puff. Twelve reads as depth; the cost is per puff-pixel. */
const MARCH_STEPS = 12;

function marchedMaterial(time: { value: number }): SpriteNodeMaterial {
  const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
  const clock = uniform(0).onFrameUpdate(() => time.value);
  /** 0 at birth, 1 at death. Written each frame by `update`. */
  const age = uniform(0);
  /** The puff's world radius, so the march can step in world units. */
  const radius = uniform(8);

  material.colorNode = Fn(() => {
    // The quad's own coordinates, scaled so the inscribed circle is the unit
    // sphere the ray marches through.
    const p = positionLocal.xy.mul(2);
    const r2 = p.dot(p);
    // Half the chord at this pixel: zero at the silhouette, so the march
    // shortens toward the edge on its own and needs no separate mask.
    const half = float(1).sub(r2).max(0).sqrt();

    // The view ray, in world space. The quad faces the viewer, so this is the
    // direction that actually goes THROUGH the puff.
    const dir = normalize(positionWorld.sub(cameraPosition));

    // Older smoke keeps less of the field and less of what it does keep.
    const threshold = float(0.2).add(age.mul(0.42));
    const thinning = float(1).sub(age).max(0);

    const transmittance = float(1).toVar();
    const lit = float(0).toVar();

    Loop({ start: 0, end: MARCH_STEPS, type: 'int' }, ({ i }) => {
      const t = float(i).add(0.5).div(MARCH_STEPS).mul(2).sub(1);
      const z = t.mul(half);

      // ONE field, in world space, shared by every puff. No per-puff seed --
      // that is what made them individual objects.
      const world = positionWorld.add(dir.mul(z.mul(radius)));
      const n = triNoise3D(world.mul(WORLD_NOISE_SCALE), 0.22, clock);

      // A soft sphere, in three dimensions rather than as a 2D mask: the
      // sample's distance from the puff's centre is `r2 + z^2` in unit-sphere
      // terms, which keeps the volume round instead of a cylinder.
      const d2 = r2.add(z.mul(z));
      const shape = float(1).sub(d2).max(0).pow(1.5);

      // A SOFT cut, not `max(n - threshold, 0)`: twelve samples each either in
      // or out leaves visible grain rather than smoke.
      const density = smoothstep(threshold, threshold.add(0.28), n)
        .mul(shape)
        .mul(thinning)
        .mul(1.8);

      // Beer-Lambert, so overlapping density saturates the way a medium does
      // instead of clipping. `stepLen` keeps density meaning the same thing
      // however many steps there are.
      const stepLen = half.mul(2).div(MARCH_STEPS);
      const remaining = density.mul(stepLen).mul(5).negate().exp();
      // Cheap self-shadowing: the far side of the puff is darker, which is
      // most of what makes smoke read as matter rather than as a glow.
      lit.addAssign(transmittance.mul(float(1).sub(remaining)).mul(t.mul(-0.14).add(0.5)));
      transmittance.mulAssign(remaining);
    });

    return vec4(vec3(lit.clamp(0, 1)), float(1).sub(transmittance).clamp(0, 1));
  })();

  applyAlphaBlend(material);
  const handles = material as unknown as { obAge: typeof age; obRadius: typeof radius };
  handles.obAge = age;
  handles.obRadius = radius;
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
        ? marchedMaterial(time)
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
    // Named for the same reason the light pools are: "is it in the scene, and
    // where" is a question worth being able to ask from `--eval` without
    // guessing which of a hundred sprites belongs to whom.
    sprite.name = `overbounce.smokepuff${i}`;
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
          const h = p.material as unknown as {
            obAge?: { value: number };
            obRadius?: { value: number };
          };
          if (h.obAge) {
            h.obAge.value = 1 - at.alpha / TRAIL_ALPHA;
          }
          if (h.obRadius) {
            // World units, so the march can step through the puff rather than
            // through its unit sphere.
            h.obRadius.value = at.radius;
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
