/**
 * The shotgun's muzzle puff: `CG_ShotgunFire`'s one `CG_SmokePuff`, ported
 * from Quake III Arena's cg_weapons.c (lines 2080-2098), cg_effects.c
 * (`CG_SmokePuff`, line 99) and cg_localents.c (`CG_AddMoveScaleFade`,
 * line 354).
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *     VectorSubtract( es->origin2, es->pos.trBase, v );
 *     VectorNormalize( v );
 *     VectorScale( v, 32, v );
 *     VectorAdd( es->pos.trBase, v, v );
 *     ...
 *     VectorSet( up, 0, 0, 8 );
 *     CG_SmokePuff( v, up, 32, 1, 1, 1, 0.33f, 900, cg.time, 0,
 *                   LEF_PUFF_DONT_SCALE, cgs.media.shotgunSmokePuffShader );
 *
 * A single white sprite 32 units out from the muzzle, radius 32 for its whole
 * life (`LEF_PUFF_DONT_SCALE` skips `CG_AddMoveScaleFade`'s growth), rising
 * 8 units a second (`TR_LINEAR`, `trDelta` is units per second), alpha
 * 0.33 -> 0 linearly over 900ms. The shader (`shotgunSmokePuff`,
 * OpenArena's scripts/oanew.shader) is `gfx/misc/smokepuff3.tga` with
 * `blendfunc blend`, `alphaGen entity` and `tcMod rotate -45`.
 *
 * ## Why not `smoke-trail.ts`
 *
 * The rocket trail's puffs are the same `CG_SmokePuff` with different
 * arguments, but that module is hardwired to `CG_AddScaleFade`'s growth
 * curve (8 -> 72 over 2s) and the 50ms emission grid, both of which this
 * puff has none of. A four-sprite pool of its own is smaller than making
 * the trail generic.
 *
 * ## One quirk, ported verbatim
 *
 * `origin2` is `forward * 4096` -- a scaled DIRECTION -- and `pos.trBase`
 * is the muzzle, a POINT. Subtracting one from the other and normalizing
 * only yields `forward` near the world origin; a muzzle at (3000, 0, 0)
 * bends the puff's offset noticeably towards the map's origin. It is id's
 * arithmetic, it is 32 cosmetic units, and it stays.
 */

import { Group, Sprite, SpriteNodeMaterial } from 'three/webgpu';
import type { Object3D, Texture } from 'three/webgpu';
import type { Vec3 } from '../math/vec3.js';
import { EFFECT_RENDER_ORDER } from './explosion-fx.js';
import { applyAlphaBlend } from './blend.js';

/** `CG_SmokePuff( v, up, 32, ...)`: the sprite's radius, never scaled. */
export const SHOTGUN_PUFF_RADIUS = 32;
/** `... 1, 1, 1, 0.33f, ...`: the alpha at birth. */
export const SHOTGUN_PUFF_ALPHA = 0.33;
/** `... 900, ...`: how long it lives, ms. */
export const SHOTGUN_PUFF_TIME_MS = 900;
/** `VectorSet( up, 0, 0, 8 )`: units per second of rise. */
export const SHOTGUN_PUFF_RISE = 8;
/** `VectorScale( v, 32, v )`: how far out from the muzzle it is born. */
export const SHOTGUN_PUFF_OFFSET = 32;
/** `tcMod rotate -45`: degrees per second the texture turns. */
export const SHOTGUN_PUFF_ROTATE = -45;

/** Where `CG_ShotgunFire` puts the puff -- see the header's quirk. */
export function shotgunPuffOrigin(
  muzzle: ArrayLike<number>,
  origin2: ArrayLike<number>,
  out: Vec3,
): Vec3 {
  let vx = origin2[0] - muzzle[0];
  let vy = origin2[1] - muzzle[1];
  let vz = origin2[2] - muzzle[2];
  const len = Math.hypot(vx, vy, vz);
  if (len > 0) {
    vx /= len;
    vy /= len;
    vz /= len;
  }
  out[0] = muzzle[0] + vx * SHOTGUN_PUFF_OFFSET;
  out[1] = muzzle[1] + vy * SHOTGUN_PUFF_OFFSET;
  out[2] = muzzle[2] + vz * SHOTGUN_PUFF_OFFSET;
  return out;
}

/**
 * `CG_AddMoveScaleFade` for this puff at `now`: alpha and how far it has
 * risen. Null once it is over.
 *
 *     c = ( le->endTime - cg.time ) * le->lifeRate;
 *     re->shaderRGBA[3] = 0xff * c * le->color[3];
 */
export function shotgunPuffAt(born: number, now: number): { alpha: number; rise: number } | null {
  const end = born + SHOTGUN_PUFF_TIME_MS;
  if (now >= end || now < born) {
    return null;
  }
  const c = (end - now) / SHOTGUN_PUFF_TIME_MS;
  return {
    alpha: c * SHOTGUN_PUFF_ALPHA,
    // `BG_EvaluateTrajectory`, TR_LINEAR: `trBase + trDelta * seconds`.
    rise: (SHOTGUN_PUFF_RISE * (now - born)) / 1000,
  };
}

interface Puff {
  sprite: Sprite;
  material: SpriteNodeMaterial;
  born: number;
  /** 0 when free. */
  until: number;
  base: [number, number, number];
  rotation: number;
}

export interface ShotgunSmokeOptions {
  parent: Object3D;
  /** `gfx/misc/smokepuff3.tga`, or null when no pak carries it. */
  texture: Texture | null;
  /** One blast a second, 900ms each: two is the most that can be alive. */
  count?: number;
}

export interface ShotgunSmoke {
  /** What is alive right now, for `npm run shot -- --eval`. */
  debug(): { live: number; textured: boolean; alphas: number[] };
  /** `EV_SHOTGUN`: one puff, from the blast's muzzle along its `origin2`. */
  spawn(muzzle: ArrayLike<number>, origin2: ArrayLike<number>, now: number): void;
  update(now: number, viewOrigin: ArrayLike<number>): void;
  dispose(): void;
}

export function createShotgunSmoke(options: ShotgunSmokeOptions): ShotgunSmoke {
  const group = new Group();
  options.parent.add(group);
  const pool: Puff[] = [];
  const count = options.count ?? 4;

  for (let i = 0; i < count; i++) {
    // `map` at CONSTRUCTION -- see `smoke-trail.ts` on why a map attached
    // later is a white sprite rather than an error.
    const material = new SpriteNodeMaterial(
      options.texture ? { map: options.texture, depthWrite: false } : { depthWrite: false },
    );
    applyAlphaBlend(material);
    const sprite = new Sprite(material);
    sprite.renderOrder = EFFECT_RENDER_ORDER;
    sprite.name = `overbounce.shotgunpuff${i}`;
    sprite.visible = false;
    // `cull disable` in the shader, and a sprite has no back face anyway.
    sprite.frustumCulled = false;
    // Fixed for its whole life: LEF_PUFF_DONT_SCALE.
    sprite.scale.setScalar(SHOTGUN_PUFF_RADIUS * 2);
    group.add(sprite);
    pool.push({ sprite, material, born: 0, until: 0, base: [0, 0, 0], rotation: 0 });
  }

  const scratch = new Float32Array(3);

  const claim = (now: number): Puff | null => {
    for (const p of pool) {
      if (p.until <= now) {
        return p;
      }
    }
    return null;
  };

  const free = (p: Puff): void => {
    p.sprite.visible = false;
    p.until = 0;
  };

  return {
    debug() {
      const live = pool.filter((p) => p.sprite.visible);
      return {
        live: live.length,
        textured: pool[0]?.material.map !== null && pool[0]?.material.map !== undefined,
        alphas: live.map((p) => p.material.opacity),
      };
    },

    spawn(muzzle, origin2, now) {
      const puff = claim(now);
      if (!puff) {
        return;
      }
      shotgunPuffOrigin(muzzle, origin2, scratch);
      puff.base = [scratch[0], scratch[1], scratch[2]];
      puff.born = now;
      puff.until = now + SHOTGUN_PUFF_TIME_MS;
      // `re->rotation = Q_random( &seed ) * 360`, cg_effects.c:117: a
      // starting angle, cosmetic. The texture then turns at
      // `tcMod rotate -45` on top of it.
      puff.rotation = Math.random() * Math.PI * 2;
      puff.sprite.position.set(scratch[0], scratch[1], scratch[2]);
      puff.sprite.visible = true;
    },

    update(now, viewOrigin) {
      for (const p of pool) {
        if (p.until <= now) {
          if (p.sprite.visible) {
            free(p);
          }
          continue;
        }
        const at = shotgunPuffAt(p.born, now);
        if (!at) {
          free(p);
          continue;
        }
        const x = p.base[0];
        const y = p.base[1];
        const z = p.base[2] + at.rise;
        // "if the view would be 'inside' the sprite, kill the sprite so it
        // doesn't add too much overdraw" -- against `le->radius`.
        if (Math.hypot(x - viewOrigin[0], y - viewOrigin[1], z - viewOrigin[2]) < SHOTGUN_PUFF_RADIUS) {
          free(p);
          continue;
        }
        p.sprite.position.set(x, y, z);
        p.material.opacity = at.alpha;
        p.material.rotation =
          p.rotation + ((SHOTGUN_PUFF_ROTATE * (now - p.born)) / 1000) * (Math.PI / 180);
      }
    },

    dispose() {
      for (const p of pool) {
        group.remove(p.sprite);
        p.material.dispose();
      }
      options.parent.remove(group);
    },
  };
}
