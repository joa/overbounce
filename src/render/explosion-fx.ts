/**
 * The "fancy" detonation: real Quake shader textures on billboards, plus
 * emitted spark and smoke particles, layered on top of a rocket/grenade/
 * plasma explosion.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `effects.ts`'s `Effects.spawnExplosion` -- a single expanding flat-colour
 * sphere -- is deliberately left alone (see that file's own doc: "delete this
 * file and the physics is unchanged" applies here too, and it stays as the
 * classic look, and the only look when no paks are mounted). This is a
 * second, independent effect layered on top when paks ARE mounted, built
 * from the same `rocketExplosion`/`grenadeExplosion`/`plasmaExplosion`
 * shaders the real game uses (`scripts/weaponhits.shader`,
 * `scripts/oanew.shader` in the OpenArena pak this project ships against) --
 * not a from-scratch VFX design. Reproduced as a handful of billboards per
 * shader stage (the `plasma-ball.ts` shortcut: load the known image
 * directly, skip the shader-script pipeline), not a literal interpreter of
 * every `tcMod`/`rgbGen` line -- this is decoration, and it only has to read
 * as "the same explosion, richer."
 *
 * `rocketExplosion` itself is two animated 8-frame layers
 * (`models/weaphits/rlboom/rlboom_1..8`) plus four rotating/stretching flame
 * quads (`textures/oa/fiar.tga`/`fiar2.tga`); `grenadeExplosion` is four
 * rotating `grenfiar` quads with no animated frames; `plasmaExplosion` is two
 * rotating `plasring` quads. `oanew.shader`'s `smokePuff` and
 * `scripts/oafx`'s `spark1/2/3` textures are real Quake particle sprites,
 * reused here for the smoke burst and the outward debris respectively --
 * Quake spawns those from `CG_ParticleExplosion`/`CG_SmokePuff`, not from the
 * explosion shader itself, but they belong to the same moment.
 */

import type { Object3D, Texture } from 'three/webgpu';
import { Group, Sprite, SpriteNodeMaterial } from 'three/webgpu';
import type { Pk3FileSystem } from '../assets/pk3.js';
import type { Vec3 } from '../math/vec3.js';
import { vec3 } from '../math/vec3.js';
import type { CollisionModel } from '../collision/model.js';
import { boxTrace } from '../collision/trace.js';
import { createTrace } from '../physics/types.js';
import { MASK_SOLID } from '../physics/constants.js';
import { applyAdditiveBlend, applyAlphaBlend } from './blend.js';
import { loadTexture } from './md3-mesh.js';

/** Everything `loadExplosionTextures` was able to find in the mounted paks. */
export interface ExplosionTextures {
  /** `models/weaphits/rlboom/rlboom_1..8` -- empty if the pak lacks them. */
  rocketFrames: Texture[];
  fiar: Texture | null;
  fiar2: Texture | null;
  grenfiar: Texture | null;
  plasring: Texture | null;
  /** `railExplosion`'s `models/weaphits/smokering2` -- the rail's impact ring. */
  smokering2: Texture | null;
  smokePuff: Texture | null;
  /** `textures/oafx/spark1/2/3` -- may be a shorter list, never assumed full. */
  sparks: Texture[];
}

/** True once there is enough here to draw SOMETHING for at least one weapon. */
export function hasAnyExplosionTexture(t: ExplosionTextures): boolean {
  return (
    t.rocketFrames.length > 0 ||
    t.fiar !== null ||
    t.fiar2 !== null ||
    t.grenfiar !== null ||
    t.plasring !== null ||
    t.smokering2 !== null
  );
}

export async function loadExplosionTextures(paks: Pk3FileSystem): Promise<ExplosionTextures> {
  const [rocketFrames, fiar, fiar2, grenfiar, plasring, smokering2, smokePuff, sparks] =
    await Promise.all([
    Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        loadTexture(paks, `models/weaphits/rlboom/rlboom_${i + 1}.tga`),
      ),
    ),
    loadTexture(paks, 'textures/oa/fiar.tga'),
    loadTexture(paks, 'textures/oa/fiar2.tga'),
    loadTexture(paks, 'textures/oa/grenfiar.tga'),
    loadTexture(paks, 'models/weaphits/plasring.tga'),
    loadTexture(paks, 'models/weaphits/smokering2.tga'),
    loadTexture(paks, 'gfx/misc/smokepuff3.tga'),
    Promise.all([
      loadTexture(paks, 'textures/oafx/spark1.tga'),
      loadTexture(paks, 'textures/oafx/spark2.tga'),
      loadTexture(paks, 'textures/oafx/spark3.tga'),
    ]),
  ]);

  return {
    rocketFrames: rocketFrames.filter((t): t is Texture => t !== null),
    fiar,
    fiar2,
    grenfiar,
    plasring,
    smokering2,
    smokePuff,
    sparks: sparks.filter((t): t is Texture => t !== null),
  };
}

/**
 * `VectorScale( dir, 16, tmpVec )` -- how far `CG_MakeExplosion` moves a
 * sprite explosion off the surface it hit (cg_effects.c:454-455). The whole
 * of Quake's answer to a fireball on a wall: sixteen units out along the
 * impact normal, then an ordinary camera-facing quad (`RB_SurfaceSprite`,
 * tr_surface.c:153) growing from radius 30 to 72 as its alpha fades from a
 * third (`CG_AddSpriteExplosion`, cg_localents.c:501-519).
 */
export const SPRITE_WALL_OFFSET = 16;

/**
 * Where the fireball is centred for an impact at `origin` on a surface with
 * normal `up`: Quake's sixteen units out, no more. A larger lift was tried
 * (the billboard's own half-width, ~69 units for a rocket) and read as an
 * explosion in mid-air with its sparks and mark left behind on the wall.
 * Exported for the classic sphere (`effects.ts`), which sits the same way.
 */
export function explosionLift(origin: ArrayLike<number>, up: ArrayLike<number>): number[] {
  return [
    origin[0] + up[0] * SPRITE_WALL_OFFSET,
    origin[1] + up[1] * SPRITE_WALL_OFFSET,
    origin[2] + up[2] * SPRITE_WALL_OFFSET,
  ];
}

/**
 * Can the camera at `eye` see the explosion centred at `point`? A point
 * trace against the world's solids, from the eye to where the fireball will
 * be drawn (the lifted origin, not the impact -- a trace to the impact ends
 * on the wall it is in). Decides which pool an explosion draws from.
 *
 * An eye INSIDE solid -- the side camera parked in a wall, which the
 * cutaway makes work -- counts as seeing: `startsolid` there says nothing
 * about the room, and hiding every explosion whenever the camera is in a
 * wall would be the wrong default. Quake has no equivalent of this test; it
 * is what lets the untested billboard exist without drawing through walls.
 */
export function explosionInView(
  model: CollisionModel,
  eye: ArrayLike<number>,
  point: ArrayLike<number>,
): boolean {
  const zero = vec3(0, 0, 0);
  boxTrace(
    model,
    losTrace,
    vec3(eye[0], eye[1], eye[2]),
    zero,
    zero,
    vec3(point[0], point[1], point[2]),
    MASK_SOLID,
  );
  return losTrace.startsolid || losTrace.fraction >= 1;
}
const losTrace = createTrace();

/** A pooled billboard: a real Quake sprite texture, moving and fading. */
interface FxSprite {
  sprite: Sprite;
  material: SpriteNodeMaterial;
  until: number;
  born: number;
  velocity: [number, number, number];
  gravity: number;
  startScale: number;
  endScale: number;
  startAlpha: number;
  spinRate: number;
  /**
   * When set, cycles through these textures over the sprite's lifetime --
   * `rocketExplosion`'s `animMap`. `material` already carries a non-null
   * `map` from construction, so reassigning it here is a reference update the
   * node graph re-reads every frame, not a shader rebuild.
   */
  frames: readonly Texture[] | null;
}

export interface ExplosionFxOptions {
  /** Where to add the meshes. Expected to be the Quake-space world group. */
  parent: Object3D;
  textures: ExplosionTextures;
}

/**
 * Random unit vector in the upper hemisphere around `up`, biased toward it.
 *
 * Real Quake debris (`CG_ParticleExplosion`) throws particles in a full
 * sphere with a bit of upward drift baked into gravity instead; a hemisphere
 * bias reads better here for a mostly-ground-level splash and needs no
 * surface trace to justify (see this file's own doc on why not).
 */
function randomOutward(up: readonly number[]): [number, number, number] {
  const theta = Math.random() * Math.PI * 2;
  const height = 0.35 + Math.random() * 0.65; // 0.35..1 along `up`
  const r = Math.sqrt(Math.max(0, 1 - height * height));
  // Build an arbitrary basis around `up` -- doesn't need to be orthonormal to
  // more than visual tolerance for a decorative burst.
  const ax = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const tx = [
    up[1] * ax[2] - up[2] * ax[1],
    up[2] * ax[0] - up[0] * ax[2],
    up[0] * ax[1] - up[1] * ax[0],
  ];
  const tl = Math.hypot(tx[0], tx[1], tx[2]) || 1;
  const t = [tx[0] / tl, tx[1] / tl, tx[2] / tl];
  const b = [
    up[1] * t[2] - up[2] * t[1],
    up[2] * t[0] - up[0] * t[2],
    up[0] * t[1] - up[1] * t[0],
  ];
  const phi = theta;
  return [
    up[0] * height + (t[0] * Math.cos(phi) + b[0] * Math.sin(phi)) * r,
    up[1] * height + (t[1] * Math.cos(phi) + b[1] * Math.sin(phi)) * r,
    up[2] * height + (t[2] * Math.cos(phi) + b[2] * Math.sin(phi)) * r,
  ];
}

export class ExplosionFx {
  private readonly flames: FxSprite[] = [];
  private readonly flamesTested: FxSprite[] = [];
  private readonly sparks: FxSprite[] = [];
  private readonly smoke: FxSprite[] = [];
  private readonly smokeTested: FxSprite[] = [];
  private readonly group = new Group();
  private readonly textures: ExplosionTextures;

  constructor(options: ExplosionFxOptions) {
    this.textures = options.textures;
    options.parent.add(this.group);

    // Up to 4 concurrent explosions' worth of headroom: rocket's the busiest
    // shader at 2 animated + 4 rotating flame layers.
    const flameSeed = options.textures.rocketFrames[0] ?? options.textures.fiar;
    for (let i = 0; i < 24 && flameSeed; i++) {
      this.flames.push(this.makeSprite(flameSeed, true, false));
      this.flamesTested.push(this.makeSprite(flameSeed, true, true));
    }
    const sparkSeed = options.textures.sparks[0];
    for (let i = 0; i < 48 && sparkSeed; i++) {
      this.sparks.push(this.makeSprite(sparkSeed, true, true));
    }
    const smokeSeed = options.textures.smokePuff;
    for (let i = 0; i < 24 && smokeSeed; i++) {
      this.smoke.push(this.makeSprite(smokeSeed, false, false));
      this.smokeTested.push(this.makeSprite(smokeSeed, false, true));
    }
  }

  /**
   * Each fireball and smoke pool exists twice: once depth-tested, once not.
   * Which one an explosion lands in is decided per explosion by whether the
   * camera can see the impact (`explosionInView`, passed in as `inView`).
   *
   * Quake's explosion sprite is an ordinary depth-tested quad, which works
   * in first person because a wall is rarely edge-on to the view. From the
   * side every floor, ceiling and end wall IS edge-on, and a depth-tested
   * billboard sixteen units off one is cut in half by it. Dropping the depth
   * test fixes that and breaks something worse: a grenade lobbed into the
   * next room drew its fireball through the wall. So both are kept, and the
   * line of sight picks: an impact the camera can see gets the untested
   * quad, which no surface it sits on can cut; one it cannot see gets the
   * tested quad, which the wall in the way hides exactly as it should.
   * Sparks are always tested -- small, and flying off the surface.
   *
   * Two pools rather than one pool with a material swap, because a swapped
   * material is a pipeline the warm-up frame never compiled: the stall
   * `prewarm.ts` exists to remove would come back on the first occluded
   * explosion. Every sprite in both pools is in the scene from the start and
   * the warm frame draws them all.
   */
  private makeSprite(seed: Texture, additive: boolean, depthTest: boolean): FxSprite {
    const material = new SpriteNodeMaterial({ map: seed, opacity: 1, depthWrite: false, depthTest });
    if (additive) {
      applyAdditiveBlend(material);
    } else {
      applyAlphaBlend(material);
    }

    const sprite = new Sprite(material);
    sprite.visible = false;
    this.group.add(sprite);

    return {
      sprite,
      material,
      until: 0,
      born: 0,
      velocity: [0, 0, 0],
      gravity: 0,
      startScale: 1,
      endScale: 1,
      startAlpha: 1,
      spinRate: 0,
      frames: null,
    };
  }

  private claim(pool: FxSprite[], now: number): FxSprite | null {
    for (const p of pool) {
      if (p.until <= now) {
        return p;
      }
    }
    return null;
  }

  private fire(
    p: FxSprite,
    origin: readonly number[],
    now: number,
    duration: number,
    startScale: number,
    endScale: number,
    startAlpha: number,
    velocity: [number, number, number],
    gravity: number,
    frames: readonly Texture[] | null,
    texture: Texture | null,
  ): void {
    p.born = now;
    p.until = now + duration;
    p.startScale = startScale;
    p.endScale = endScale;
    p.startAlpha = startAlpha;
    p.velocity = velocity;
    p.gravity = gravity;
    p.frames = frames && frames.length > 0 ? frames : null;
    p.spinRate = (Math.random() - 0.5) * 6;
    p.material.rotation = Math.random() * Math.PI * 2;
    if (texture) {
      p.material.map = texture;
    } else if (frames && frames.length > 0) {
      p.material.map = frames[0];
    }
    p.sprite.position.set(origin[0], origin[1], origin[2]);
    p.sprite.scale.setScalar(startScale);
    p.sprite.visible = true;
  }

  /**
   * A detonation. `kind` picks which real shader's layers to reproduce;
   * anything unrecognised falls back to the rocket look, which is the
   * richest one and a reasonable default for "something exploded".
   * `normal` is the impact surface normal Overbounce's decal system already
   * carries when known (`Explosion.normal`) -- when present, sparks kick away
   * from the surface instead of in a plain upward hemisphere.
   */
  spawnExplosion(
    kind: string,
    origin: Vec3 | readonly number[],
    now: number,
    radius: number,
    normal?: Vec3 | readonly number[],
    /** Can the camera see the impact? Picks the untested pools when true. */
    inView = true,
  ): void {
    const org = [origin[0], origin[1], origin[2]];
    const up = normal ? [normal[0], normal[1], normal[2]] : [0, 0, 1];
    const scale = radius / 120; // normalised to the rocket's own splash radius

    /*
     * `CG_MakeExplosion`: the sprite sits sixteen units off the surface along
     * the impact normal (cg_effects.c:454-455). That is Quake's whole answer,
     * and in first person it is enough, because a wall is rarely edge-on to
     * the view. It is NOT enough from the side: a depth-tested quad centred
     * sixteen units off a floor the camera sees edge-on is still cut in half
     * by that floor. So an impact the camera can see draws from the pools
     * without a depth test, and one it cannot see from the pools with -- see
     * the note above `makeSprite`. The placement stays Quake's. Sparks start
     * at the impact itself; they are what flies OFF the wall.
     */
    const lifted = normal ? explosionLift(org, up) : org;

    this.spawnFlames(kind, lifted, now, radius, inView ? this.flames : this.flamesTested);
    this.spawnSparks(org, now, scale, up);
    this.spawnSmoke(lifted, now, scale, inView ? this.smoke : this.smokeTested);
  }

  private spawnFlames(
    kind: string,
    origin: number[],
    now: number,
    radius: number,
    pool: FxSprite[],
  ): void {
    const t = this.textures;
    const layers: { texture: Texture | null; frames: readonly Texture[] | null }[] = [];

    if (kind === 'plasma' && t.plasring) {
      layers.push({ texture: t.plasring, frames: null }, { texture: t.plasring, frames: null });
    } else if (kind === 'rail' && t.smokering2) {
      // `railExplosion` (scripts/weaponhits.shader): two rotating, stretching
      // `smokering2` quads. Without this branch a rail would fall through to
      // the rocket fireball below, which is not a thing a rail makes.
      layers.push(
        { texture: t.smokering2, frames: null },
        { texture: t.smokering2, frames: null },
      );
    } else if (kind === 'grenade' && t.grenfiar) {
      layers.push(
        { texture: t.grenfiar, frames: null },
        { texture: t.grenfiar, frames: null },
        { texture: t.grenfiar, frames: null },
      );
    } else {
      // rocket, and the fallback for anything else.
      if (t.rocketFrames.length > 0) {
        layers.push({ texture: null, frames: t.rocketFrames });
        layers.push({ texture: null, frames: t.rocketFrames });
      }
      if (t.fiar) layers.push({ texture: t.fiar, frames: null });
      if (t.fiar2) layers.push({ texture: t.fiar2, frames: null });
    }

    for (const layer of layers) {
      const p = this.claim(pool, now);
      if (!p) continue;
      const duration = 380 + Math.random() * 260;
      this.fire(
        p,
        origin,
        now,
        duration,
        radius * (0.15 + Math.random() * 0.1),
        radius * (0.85 + Math.random() * 0.3),
        1,
        [0, 0, 0],
        0,
        layer.frames,
        layer.texture,
      );
    }
  }

  private spawnSparks(origin: number[], now: number, scale: number, up: number[]): void {
    const seeds = this.textures.sparks;
    if (seeds.length === 0) return;

    const count = Math.round((10 + Math.random() * 6) * Math.min(1, Math.max(0.3, scale)));
    for (let i = 0; i < count; i++) {
      const p = this.claim(this.sparks, now);
      if (!p) break;
      const dir = randomOutward(up);
      const speed = (140 + Math.random() * 260) * scale;
      const duration = 350 + Math.random() * 350;
      this.fire(
        p,
        origin,
        now,
        duration,
        3 + Math.random() * 2,
        1.5 + Math.random(),
        1,
        [dir[0] * speed, dir[1] * speed, dir[2] * speed],
        -700,
        null,
        seeds[(Math.random() * seeds.length) | 0],
      );
    }
  }

  private spawnSmoke(origin: number[], now: number, scale: number, pool: FxSprite[]): void {
    const texture = this.textures.smokePuff;
    if (!texture) return;

    const count = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const p = this.claim(pool, now);
      if (!p) break;
      const jitter = [
        origin[0] + (Math.random() - 0.5) * 20 * scale,
        origin[1] + (Math.random() - 0.5) * 20 * scale,
        origin[2] + (Math.random() - 0.5) * 20 * scale,
      ];
      const duration = 900 + Math.random() * 600;
      this.fire(
        p,
        jitter,
        now,
        duration,
        18 * scale,
        70 * scale * (1 + Math.random() * 0.4),
        0.55,
        [(Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, 14 + Math.random() * 22],
        0,
        null,
        texture,
      );
    }
  }

  /** Advance every live effect. `now` is level time in ms; `dt` is seconds. */
  update(now: number, dt: number): void {
    for (const pool of [
      this.flames,
      this.flamesTested,
      this.sparks,
      this.smoke,
      this.smokeTested,
    ]) {
      for (const p of pool) {
        if (p.until <= now) {
          if (p.sprite.visible) p.sprite.visible = false;
          continue;
        }

        const life = (now - p.born) / (p.until - p.born);
        const scale = p.startScale + (p.endScale - p.startScale) * life;
        p.sprite.scale.setScalar(scale);
        p.material.opacity = p.startAlpha * (1 - life) * (1 - life);
        p.material.rotation += p.spinRate * dt;

        if (p.frames) {
          const idx = Math.min(p.frames.length - 1, Math.floor(life * p.frames.length));
          const next = p.frames[idx];
          if (p.material.map !== next) {
            p.material.map = next;
          }
        }

        p.velocity[2] += p.gravity * dt;
        p.sprite.position.x += p.velocity[0] * dt;
        p.sprite.position.y += p.velocity[1] * dt;
        p.sprite.position.z += p.velocity[2] * dt;
      }
    }
  }
}
