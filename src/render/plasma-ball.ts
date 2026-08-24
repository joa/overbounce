/**
 * The plasma gun's projectile: a billboarded energy sprite, not a model.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `cg_ents.c :: CG_Missile` special-cases `WP_PLASMAGUN` before it ever
 * reaches the generic missile-model path: `ent.reType = RT_SPRITE`, radius
 * 16, `cgs.media.plasmaBallShader` -- a camera-facing quad, not a spinning
 * model. That shader is `sprites/plasma1` (present under that exact name in
 * the OpenArena pak this project ships against): two layers of
 * `sprites/plasmaa.tga`, additively blended (`blendfunc gl_src_alpha
 * gl_one`, three's `AdditiveBlending` preset exactly), each rotating at its
 * own constant rate (`tcMod rotate -145` / `177`, degrees per second).
 *
 * Reproduced with two three.js `Sprite`s rather than the full shader-script
 * pipeline -- the same "load the known image directly" shortcut
 * `shadow.ts`/`decals.ts` already take for their own textures, because a
 * `Sprite`'s texture is fixed at construction the same way a `NodeMaterial`'s
 * is. `Sprite` billboards to the camera on its own; nothing here has to.
 */

import type { Texture } from 'three/webgpu';
import { AdditiveBlending, Group, Sprite, SpriteNodeMaterial } from 'three/webgpu';

/** `ent.radius = 16` in `CG_Missile` -- `RT_SPRITE`'s radius is a half-width. */
const PLASMA_BALL_SIZE = 32;

/** `sprites/plasma1`'s two layers: `tcMod rotate -145` and `177`, deg/s. */
const LAYER_RATES = [-145, 177] as const;

export interface PlasmaBallVisual {
  object: Group;
  /** Advance the layers' rotation. `nowSeconds` is level time, not a delta. */
  update(nowSeconds: number): void;
}

export function createPlasmaBallVisual(texture: Texture): PlasmaBallVisual {
  const group = new Group();
  const sprites = LAYER_RATES.map(() => {
    const material = new SpriteNodeMaterial({
      map: texture,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new Sprite(material);
    sprite.scale.set(PLASMA_BALL_SIZE, PLASMA_BALL_SIZE, 1);
    group.add(sprite);
    return sprite;
  });

  return {
    object: group,
    update(nowSeconds: number): void {
      for (let i = 0; i < sprites.length; i++) {
        // `RB_CalcRotateTexCoords`'s sign convention (shader-anim.ts's own
        // 'rotate' case): negative degreesPerSecond * time.
        const material = sprites[i].material as SpriteNodeMaterial;
        material.rotation = ((-LAYER_RATES[i] * nowSeconds) * Math.PI) / 180;
      }
    },
  };
}
