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
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  positionLocal,
  positionWorld,
  smoothstep,
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
 * ## Three mistakes, because each one produced a different wrong picture
 *
 *  1. **Per-puff noise.** Every puff had its own field in its own local space
 *     with its own seed, so neighbours agreed about nothing and forty of them
 *     read as beads on a string.
 *  2. **A domain one cell wide.** Sampling that field over `position * 0.7`
 *     across a unit sphere left it nearly constant, so the march integrated to
 *     a smooth ball -- which is how a raymarch came to look like a texture.
 *  3. **`triNoise3D`, and saturation.** The field is built from triangle
 *     waves, so at the low frequency a shared world field wants it is a
 *     visible egg-carton LATTICE rather than smoke. And each puff's density
 *     saturated, so its sphere read as a solid object that the noise merely
 *     patterned: hard-edged balls with a grid inside.
 *
 * What is here now, and why each part is load-bearing:
 *
 *  - **`mx_fractal_noise_float`** -- Perlin fbm, three octaves. Organic where
 *    `triNoise3D` is regular, and the regularity was the tell.
 *  - **ONE field, in WORLD space.** Two overlapping puffs sample the same
 *    field and agree by construction, so a trail merges into a column instead
 *    of a row of objects.
 *  - **No saturation.** A single puff maxes out around a quarter opaque; the
 *    body of the smoke comes from puffs OVERLAPPING, which is what stops the
 *    sphere's own silhouette being the thing you see. It is the difference
 *    between a volume and a ball with a texture on it.
 *  - **A gaussian weight, not a hard sphere.** `exp(-d2 * k)` has no rim to
 *    see; the visible edge comes from the field falling below the cut, which
 *    is where a smoke silhouette should come from.
 *  - **Drift.** The field slides upward over time, so the smoke rises rather
 *    than merely churning in place.
 *
 * Not fluid dynamics, and not claiming to be: no advection, no pressure. A
 * low-frequency field that rises slowly and is revealed more sparsely as a
 * puff ages -- spreading, thinning and breaking up together, because smoke
 * does all three and doing one alone reads as a fade.
 */

/**
 * Noise cells per Quake unit (~an inch), so a feature is about eighty units --
 * larger than one puff on purpose. Detail smaller than a puff is what made the
 * puffs legible as individuals.
 */
const WORLD_NOISE_SCALE = 0.012;

/**
 * The DETAIL layer's frequency, as a multiple of the base.
 *
 * The low-frequency field decides the silhouette and gives the smoke its
 * body; on its own that is a soft grey mass with nothing happening inside it.
 * This is the layer that breaks the interior up -- six times finer, so a
 * feature is about thirteen units and reads as texture at the distance a
 * trail is actually seen from rather than as a second set of blobs.
 */
const DETAIL_RATIO = 6;

/**
 * How much of the density the detail layer is allowed to take away.
 *
 * It MULTIPLIES rather than adds, because the point is to erode the mass into
 * strands rather than to pile more smoke on top of it -- but only partly: a
 * bare multiply by a [0,1] field halves the smoke on average and punches
 * holes clean through it. Modulating between this and 1 keeps the body the
 * base layer decided and textures it.
 */
const DETAIL_DEPTH = 0.65;

/** March steps. Twelve reads as depth; the cost is per puff-pixel. */
const MARCH_STEPS = 12;

/** Units per second the field rises. Slow -- this is a drift, not a plume. */
const SMOKE_RISE = 26;

/**
 * How much fatter a `modern` puff is than Quake's own radius.
 *
 * At 900ups a rocket leaves a puff every 45 units, and Quake's curve starts
 * them at radius 8 -- so for the first third of their life they are islands
 * with gaps between, which no amount of shading fixes. Widening them is what
 * makes the column continuous, and it costs nothing: the same puffs, drawn
 * bigger, at a density low enough that the overlap adds up instead of
 * saturating.
 */
const MODERN_SPREAD = 2.4;

function marchedMaterial(time: { value: number }): SpriteNodeMaterial {
  const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
  const clock = uniform(0).onFrameUpdate(() => time.value);
  /** 0 at birth, 1 at death. Written each frame by `update`. */
  const age = uniform(0);
  /** The puff's world radius, so the march steps in world units. */
  const radius = uniform(8);

  material.colorNode = Fn(() => {
    const p = positionLocal.xy.mul(2);
    const r2 = p.dot(p);
    const half = float(1).sub(r2).max(0).sqrt();
    // The quad faces the viewer, so this is the direction that goes THROUGH
    // the puff.
    const dir = normalize(positionWorld.sub(cameraPosition));

    // Older smoke keeps less of the field, and less of what it keeps.
    const threshold = float(0.34).add(age.mul(0.34));
    const thinning = float(1).sub(age).max(0);
    // Three's Y is up; the world group carries the Quake rotation, so rising
    // smoke moves along +Y here.
    const rise = vec3(0, clock.mul(SMOKE_RISE), 0);

    /*
     * The detail layer, sampled ONCE per fragment rather than per step.
     *
     * Not an optimisation -- or not only one. A high-frequency field sampled
     * at every step and integrated along the ray averages back toward its own
     * mean, so the detail it is there to add is exactly what the march removes:
     * twelve independent samples of a [0,1] field sum to something very close
     * to flat. Sampling once, at the puff's own surface, keeps the variation
     * coherent along the ray, which is what makes it visible as strands.
     *
     * It also costs one Perlin call per fragment instead of twelve.
     *
     * One octave rather than another fbm: the base is already three octaves,
     * and the interior of something mostly transparent does not need more.
     * Offset so it cannot line up with the base and reinforce it into the same
     * shapes at a smaller scale.
     */
    const fine = mx_noise_float(
      positionWorld.mul(WORLD_NOISE_SCALE * DETAIL_RATIO).sub(rise).add(17.3),
    )
      .mul(0.5)
      .add(0.5);
    const detail = float(1).sub(DETAIL_DEPTH).add(fine.mul(DETAIL_DEPTH));

    const transmittance = float(1).toVar();
    const lit = float(0).toVar();

    Loop({ start: 0, end: MARCH_STEPS, type: 'int' }, ({ i }) => {
      const t = float(i).add(0.5).div(MARCH_STEPS).mul(2).sub(1);
      const z = t.mul(half);
      const world = positionWorld.add(dir.mul(z.mul(radius))).sub(rise);

      // Perlin fbm in [-1, 1], remapped to [0, 1]. One field, world space, no
      // per-puff seed -- that is what makes neighbouring puffs one body.
      const n = mx_fractal_noise_float(world.mul(WORLD_NOISE_SCALE), 3, 2, 0.5).mul(0.5).add(0.5);


      // A soft gaussian weight rather than a sphere: nothing here has an edge,
      // so the silhouette is whatever the field leaves behind.
      const d2 = r2.add(z.mul(z));
      const shape = d2.mul(-2.4).exp();

      const density = smoothstep(threshold, threshold.add(0.26), n)
        .mul(detail)
        .mul(shape)
        .mul(thinning)
        .mul(1.35);

      const stepLen = half.mul(2).div(MARCH_STEPS);
      const remaining = density.mul(stepLen).mul(2.2).negate().exp();
      // Cheap self-shadowing: the far side is darker, which is most of what
      // makes smoke read as matter rather than as a glow.
      lit.addAssign(transmittance.mul(float(1).sub(remaining)).mul(t.mul(-0.16).add(0.46)));
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

        // `MODERN_SPREAD` only widens the DRAWN puff, never the emission
        // rhythm or the growth curve -- those stay Quake's in both modes.
        p.sprite.scale.setScalar(
          at.radius * 2 * (options.mode === 'modern' ? MODERN_SPREAD : 1),
        );
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
            h.obRadius.value = at.radius * MODERN_SPREAD;
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
