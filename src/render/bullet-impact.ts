/**
 * The bullet impact flash: `CG_MissileHitWall`'s `bulletFlashModel` drawn
 * with `bulletExplosionShader`, ported from Quake III Arena's cg_weapons.c
 * (lines 1872-1877, 1906-1919), cg_effects.c (`CG_MakeExplosion`, line 433)
 * and cg_localents.c (`CG_AddExplosion`, line 474).
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A bullet or a shotgun pellet leaves two things on a wall: the mark
 * (`decals.ts`) and, for 600ms, THIS -- `models/weaphits/bullet.md3`, a
 * shallow eight-triangle cone with its apex on the wall and its rim
 * thirteen units out, textured by the `bulletExplosion` shader's eight
 * additive frames at 12 fps:
 *
 *     case WP_MACHINEGUN:                      // and WP_SHOTGUN, likewise
 *         mod = cgs.media.bulletFlashModel;
 *         shader = cgs.media.bulletExplosionShader;
 *         ...
 *     le = CG_MakeExplosion( origin, dir, mod, shader, duration, isSprite );
 *
 * `CG_MakeExplosion` for a MODEL (`isSprite` false) puts it AT the impact --
 * no sixteen-unit lift, that is the sprite path -- and orients it with
 * `axis[0]` along the surface normal and a random roll about it
 * (`RotateAroundDirection`). The animation starts at frame 0 on spawn:
 * `shaderTime = startTime` is what biases the `animMap` clock. Nothing
 * fades; the model simply stops being added at `endTime`. `startTime` is
 * skewed back by `rand() & 63` "so they aren't all in sync", which matters
 * for a shotgun's eleven at once.
 *
 * The geometry is the real MD3 out of the pak, not a hand-made quad: the
 * cone's rim stands off the wall, so from the side view the flash is a
 * visible bump rather than a decal-thin disc.
 */

import type { BufferGeometry, Object3D, Texture } from 'three/webgpu';
import {
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { Pk3FileSystem } from '../assets/pk3.js';
import type { Shader } from '../assets/shader.js';
import { parseMd3 } from '../assets/md3.js';
import type { Md3Model } from '../assets/md3.js';
import { buildSurfaceGeometry, loadTexture } from './md3-mesh.js';
import { EFFECT_RENDER_ORDER } from './explosion-fx.js';
import { applyAdditiveBlend } from './blend.js';

/** `cgs.media.bulletFlashModel`, cg_main.c:986. */
export const BULLET_FLASH_MODEL = 'models/weaphits/bullet.md3';
/** `cgs.media.bulletExplosionShader`, cg_main.c:985. */
export const BULLET_FLASH_SHADER = 'bulletExplosion';
/**
 * The fallback animation, used only when the mounted paks have no
 * `bulletExplosion` with an `animMap` stage in them.
 *
 * These are OpenArena's own numbers, read out of its
 * `scripts/weaponhits.shader`: `animmap 12` over eight frames. They used to
 * be the ONLY numbers -- hardcoded, with the shader named in a comment -- and
 * that was the bug. A pak whose `bulletExplosion` says something else (retail
 * Quake III's is not OpenArena's; OA's own file carries two other, disabled
 * versions of this shader under different names) was animated at OA's rate
 * over OA's frames regardless, which is what "the impact plays in slow
 * motion" turned out to be.
 */
export const BULLET_FLASH_FRAMES = Array.from(
  { length: 8 },
  (_, i) => `models/weaphits/bullet_000${i}.tga`,
);
/** The fallback's frames per second. See `BULLET_FLASH_FRAMES`. */
export const BULLET_FLASH_FPS = 12;
/** `CG_MissileHitWall`'s `duration = 600` default, cg_weapons.c:1780. */
export const BULLET_FLASH_TIME_MS = 600;
/** `offset = rand() & 63`, cg_effects.c:446. */
export const BULLET_FLASH_SKEW = 63;

/** One `animMap` stage: what to show and how fast. */
export interface BulletFlashAnim {
  readonly frames: readonly string[];
  readonly fps: number;
}

/**
 * What the MOUNTED PAKS say `bulletExplosion` animates, falling back to
 * OpenArena's.
 *
 * The shader is data, not code. Reading it is the difference between playing
 * the effect the player's own pak defines and playing a copy of one pak's
 * version over everybody's art -- and Quake resolves this shader by name at
 * runtime exactly like any other (`cgs.media.bulletExplosionShader` is a
 * `trap_R_RegisterShader` handle).
 *
 * Only a stage with more than one `animMap` frame counts. A `bulletExplosion`
 * built some other way -- OpenArena ships two such, as `oldbulletExplosion`
 * (a scrolling `bulletscroll.tga`) and `bitoutofdatebulletExplosion` -- has no
 * frame list to drive this pool, so the fallback stands rather than the flash
 * disappearing.
 */
export function bulletFlashAnim(shaders: ReadonlyMap<string, Shader> | null): BulletFlashAnim {
  const shader = shaders?.get(BULLET_FLASH_SHADER.toLowerCase());
  for (const stage of shader?.stages ?? []) {
    if (stage.animFrames.length > 1 && stage.animFps > 0) {
      return { frames: stage.animFrames, fps: stage.animFps };
    }
  }
  return { frames: BULLET_FLASH_FRAMES, fps: BULLET_FLASH_FPS };
}

/**
 * Which frame `animMap` shows at `now` for a flash that started at `start`:
 * `RB_CalcShaderTime`'s `(time - shaderTime) * animMapFrequency`, modulo the
 * frame count (tr_shade.c, `R_BindAnimatedImage`).
 *
 * `count` is how many frames actually LOADED, not how many the shader names.
 * Those differ whenever a pak is missing one, and the difference used to be
 * silent and ugly: the index was taken modulo the path list, so a missing
 * frame indexed past the end of the texture array and the material's `map`
 * became `undefined` -- an untextured white cone for as long as that frame
 * was up, which reads as both a stutter and a filtering fault.
 */
export function bulletFlashFrame(start: number, now: number, fps: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  const index = Math.floor(((now - start) / 1000) * fps);
  return ((index % count) + count) % count;
}

export interface BulletImpactAssets {
  model: Md3Model | null;
  frames: Texture[];
  /** The animation the paks actually defined. */
  anim: BulletFlashAnim;
}

/** The model and the frames its shader names, out of the mounted paks. */
export async function loadBulletImpactAssets(
  paks: Pk3FileSystem,
  shaders: ReadonlyMap<string, Shader> | null = null,
): Promise<BulletImpactAssets> {
  const anim = bulletFlashAnim(shaders);
  const [bytes, ...frames] = await Promise.all([
    paks.readFile(BULLET_FLASH_MODEL),
    ...anim.frames.map((path) => loadTexture(paks, path)),
  ]);
  let model: Md3Model | null = null;
  if (bytes) {
    try {
      // A fresh, unshared ArrayBuffer: the pak reader may hand back a view
      // into a larger (or shared) buffer.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      model = parseMd3(copy.buffer);
    } catch (err) {
      console.warn(`[overbounce] ${BULLET_FLASH_MODEL}: ${(err as Error).message}`);
    }
  }
  const loaded = frames.filter((t): t is Texture => t !== null);
  /*
   * Said once per course, because the numbers behind this effect live in the
   * player's own `.pk3` and every report about it ("the impact plays in slow
   * motion") is a report about a value nobody here can see. What reads as
   * SPEED is mostly the last figure: the flash lives 600ms whatever its rate,
   * so a shader with twice the frames at the same rate shows half as much of
   * itself and looks half as fast. `tools/diag/bullet-flash.ts` answers the
   * same question against a pak file, without a browser.
   */
  const shown = (BULLET_FLASH_TIME_MS / 1000) * anim.fps;
  console.log(
    `[overbounce] ${BULLET_FLASH_SHADER}: ${anim.fps} fps over ${anim.frames.length} frames ` +
      `(${loaded.length} loaded), ${shown.toFixed(1)} of them shown in ${BULLET_FLASH_TIME_MS}ms` +
      (shaders ? '' : ' — from the stock fallback, no shader table'),
  );
  if (loaded.length !== anim.frames.length) {
    // Not fatal -- the pool animates over what it has -- but it means the
    // effect is a frame or more short of what its own shader asked for, and
    // that is worth saying once rather than looking like a stutter.
    console.warn(
      `[overbounce] ${BULLET_FLASH_SHADER}: ${loaded.length} of ${anim.frames.length} ` +
        'animMap frames loaded; the rest are missing from the mounted paks',
    );
  }
  return { model, frames: loaded, anim };
}

interface Flash {
  mesh: Mesh;
  material: MeshBasicNodeMaterial;
  start: number;
  /** 0 when free. */
  until: number;
  frame: number;
}

export interface BulletImpactsOptions {
  parent: Object3D;
  assets: BulletImpactAssets;
  /**
   * Ten machine gun rounds a second at 600ms is six alive; a shotgun blast
   * is eleven at once, and a second blast can land before the first has
   * gone. 32 covers both with a burst to spare.
   */
  count?: number;
}

export interface BulletImpacts {
  /** What is alive right now, for `npm run shot -- --eval`. */
  debug(): { live: number; ready: boolean; frames: number[] };
  /** `CG_MissileHitWall` for a bullet or pellet at `origin` on a face with `normal`. */
  spawn(origin: ArrayLike<number>, normal: ArrayLike<number>, now: number): void;
  update(now: number): void;
  dispose(): void;
}

/**
 * `RotateAroundDirection( axis, rand() % 360 )`: `axis[1]` is
 * `PerpendicularVector(axis[0])` turned about `axis[0]` by the roll, and
 * `axis[2]` the cross product. The perpendicular's choice is id's -- the
 * axis the direction leans on least -- so the un-rolled orientation matches
 * Quake's; the roll itself is random on both sides.
 */
function orientAlong(normal: ArrayLike<number>, roll: number, out: Matrix4): void {
  const a0 = new Vector3(normal[0], normal[1], normal[2]);
  if (a0.lengthSq() === 0) {
    a0.set(0, 0, 1);
  }
  a0.normalize();
  // PerpendicularVector: unit vector along the smallest-magnitude axis,
  // projected onto the plane and normalized.
  let pos = 0;
  let minelem = 1;
  const comps = [Math.abs(a0.x), Math.abs(a0.y), Math.abs(a0.z)];
  for (let i = 0; i < 3; i++) {
    if (comps[i] < minelem) {
      minelem = comps[i];
      pos = i;
    }
  }
  const temp = new Vector3(pos === 0 ? 1 : 0, pos === 1 ? 1 : 0, pos === 2 ? 1 : 0);
  const a1 = temp.sub(a0.clone().multiplyScalar(temp.dot(a0))).normalize();
  // RotatePointAroundVector: turn a1 about a0 by `roll`.
  a1.applyAxisAngle(a0, roll);
  const a2 = new Vector3().crossVectors(a0, a1);
  // Q3's `axis[i]` is the model's local +i direction in world space, so the
  // rotation's columns are the axes.
  out.makeBasis(a0, a1, a2);
}

export function createBulletImpacts(options: BulletImpactsOptions): BulletImpacts {
  const group = new Group();
  options.parent.add(group);
  const pool: Flash[] = [];
  const { model, frames, anim } = options.assets;
  const ready = model !== null && model.surfaces.length > 0 && frames.length > 0;

  // One geometry for every flash: the model has one frame and one surface.
  const geometry: BufferGeometry | null = ready ? buildSurfaceGeometry(model.surfaces[0]) : null;
  const count = options.count ?? 32;

  if (geometry) {
    for (let i = 0; i < count; i++) {
      // `map` at construction, then swapped by reference per frame -- the
      // same rule `explosion-fx.ts`'s `frames` follows. `cull disable` in
      // the shader is `DoubleSide`; `blendfunc add` is the additive blend.
      const material = new MeshBasicNodeMaterial({
        map: frames[0],
        side: DoubleSide,
        depthWrite: false,
      });
      applyAdditiveBlend(material);
      const mesh = new Mesh(geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = EFFECT_RENDER_ORDER;
      mesh.name = `overbounce.bulletflash${i}`;
      group.add(mesh);
      pool.push({ mesh, material, start: 0, until: 0, frame: 0 });
    }
  }

  const claim = (now: number): Flash | null => {
    for (const f of pool) {
      if (f.until <= now) {
        return f;
      }
    }
    return null;
  };

  const free = (f: Flash): void => {
    f.mesh.visible = false;
    f.until = 0;
  };

  const basis = new Matrix4();

  return {
    debug() {
      const live = pool.filter((f) => f.mesh.visible);
      return { live: live.length, ready, frames: live.map((f) => f.frame) };
    },

    spawn(origin, normal, now) {
      const f = claim(now);
      if (!f) {
        return;
      }
      // "skew the time a bit so they aren't all in sync"
      f.start = now - Math.floor(Math.random() * (BULLET_FLASH_SKEW + 1));
      f.until = f.start + BULLET_FLASH_TIME_MS;
      // `ang = rand() % 360`
      orientAlong(normal, Math.floor(Math.random() * 360) * (Math.PI / 180), basis);
      basis.setPosition(origin[0], origin[1], origin[2]);
      f.mesh.matrix.copy(basis);
      f.mesh.matrixWorldNeedsUpdate = true;
      f.frame = bulletFlashFrame(f.start, now, anim.fps, frames.length);
      f.material.map = frames[f.frame];
      f.mesh.visible = true;
    },

    update(now) {
      for (const f of pool) {
        if (f.until <= now) {
          if (f.mesh.visible) {
            free(f);
          }
          continue;
        }
        const frame = bulletFlashFrame(f.start, now, anim.fps, frames.length);
        if (frame !== f.frame) {
          f.frame = frame;
          f.material.map = frames[frame];
        }
      }
    },

    dispose() {
      for (const f of pool) {
        group.remove(f.mesh);
        f.material.dispose();
      }
      geometry?.dispose();
      options.parent.remove(group);
    },
  };
}
