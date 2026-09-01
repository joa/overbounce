/**
 * Weapon impact marks: scorch marks and plasma burns stamped on whatever a
 * rocket, grenade or plasma ball detonates against.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from `cgame/cg_marks.c` (`CG_AddMarks`'s pooling and fade) and the
 * per-weapon table in `cgame/cg_weapons.c :: CG_MissileHitWall`. The actual
 * mark geometry -- `CG_ImpactMark` and the `R_MarkFragments` BSP clip behind
 * it -- is `src/collision/markfragments.ts`'s `buildImpactMark`: it has to
 * live in `src/collision/` because it walks the collision model, and
 * `src/collision/` may not import `three` (CLAUDE.md's import boundary).
 * This file is cgame's side of that split: it takes the fragments
 * `buildImpactMark` already clipped to the surface and turns them into pooled,
 * fading meshes.
 *
 * Divergences from id, all in `.agent/plans/DECALS.md`: single-slot pool
 * eviction instead of id's same-timestamp fragment-group eviction, and no
 * compile-time CSG (`markfragments.ts` clips against collision brushes, not
 * the renderer's already-hollowed-out BSP surfaces).
 *
 * Id keeps every mark kind (burn, energy, blood, bullet holes, the shadow
 * blob) in one 256-entry pool, `cg_markPolys`. Reproduced here as two
 * same-sized-total pools instead, one per texture, because a `NodeMaterial`
 * bakes its texture reference into its shader graph at build time -- there is
 * no cheap "swap this slot's texture" the way id's polygon-soup renderer has.
 * Split unevenly on purpose: only one weapon is ever held at a time, and
 * plasma's 100ms cooldown against the rocket/grenade's 800ms means a plasma
 * spree needs roughly 8x the concurrent fragments a rocket spree does.
 *
 * Everything here is presentation and nothing here feeds back into the
 * simulation, same as `effects.ts`.
 */

import type { Object3D, Texture } from 'three/webgpu';
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import type { CollisionModel } from '../collision/model.js';
import type { TexturedMarkFragment } from '../collision/markfragments.js';
import { buildImpactMark } from '../collision/markfragments.js';
import type { Vec3 } from '../math/vec3.js';
import type { Pk3FileSystem } from '../assets/pk3.js';
import { loadTexture } from './md3-mesh.js';
import { applyAlphaBlend, applyDarkenBlend } from './blend.js';
import { freezeTransform } from './transform.js';

/** `MARK_TOTAL_TIME`, cg_marks.c -- a mark's full lifetime in ms. */
export const MARK_TOTAL_TIME = 10000;

/** `MARK_FADE_TIME`, cg_marks.c -- it fades over the last second of that. */
export const MARK_FADE_TIME = 1000;

/** What `burnMarkShader`/`energyMarkShader` resolve to -- no shader script. */
const BURN_IMAGE = 'gfx/damage/burn_med_mrk';
const ENERGY_IMAGE = 'gfx/damage/plasma_mrk';
/** `cgs.media.bulletMarkShader`, cg_main.c's own path. */
const BULLET_IMAGE = 'gfx/damage/bullet_mrk';

/** Combined, this matches id's single `MAX_MARK_POLYS` = 256. */
const BURN_POOL_SIZE = 64;
const ENERGY_POOL_SIZE = 192;
/**
 * Its own pool, and a deep one.
 *
 * The machine gun fires ten rounds a second, so a five-second burst is fifty
 * marks where a rocket jump is one. Sharing the burn pool would mean every
 * held trigger wiping the explosion marks that tell a player where they last
 * jumped from, which is the one thing decals are actually useful for here.
 */
const BULLET_POOL_SIZE = 192;

/**
 * A fragment rarely comes back with more than a handful of points -- a quad
 * clipped by a couple of brush planes near a corner. Capped generously; a
 * pathological fragment beyond this loses its extra verts, which only
 * shows as a slightly smaller polygon, never a crash.
 */
const MAX_FRAGMENT_VERTS = 12;
const MAX_FRAGMENT_TRIS = MAX_FRAGMENT_VERTS - 2;

/**
 * `CG_MissileHitWall`'s per-weapon table, narrowed to the three weapons this
 * port has. Colour is always `(1,1,1,1)` at spawn: the one path that
 * colourises (`WP_RAILGUN`, client colour) has no railgun to reach it.
 */
type MarkKind = 'burn' | 'energy' | 'bullet';

const WEAPON_MARKS: Record<string, { kind: MarkKind; radius: number }> = {
  rocket: { kind: 'burn', radius: 64 },
  grenade: { kind: 'burn', radius: 64 },
  plasma: { kind: 'energy', radius: 16 },
  // cg_weapons.c:1919 -- `radius = 8` for WP_MACHINEGUN, an eighth of a
  // rocket's crater.
  bullet: { kind: 'bullet', radius: 8 },
};

/** A triangle fan `0,1,2, 0,2,3, ...` up to `MAX_FRAGMENT_VERTS`, shared by every slot. */
function buildFanIndex(): BufferAttribute {
  const idx = new Uint16Array(MAX_FRAGMENT_TRIS * 3);
  for (let i = 0; i < MAX_FRAGMENT_TRIS; i++) {
    idx[i * 3 + 0] = 0;
    idx[i * 3 + 1] = i + 1;
    idx[i * 3 + 2] = i + 2;
  }
  return new BufferAttribute(idx, 1);
}
const fanIndex = buildFanIndex();

interface MarkSlot {
  mesh: Mesh;
  material: MeshBasicNodeMaterial;
  positions: Float32Array;
  uvs: Float32Array;
  /** Level time in ms this fragment was stamped. 0 means the slot is free. */
  born: number;
}

/**
 * One texture's worth of mark fragments: a fixed-size ring of meshes, each
 * with its own geometry (fragments differ in shape) and material (so each
 * can fade independently).
 */
class MarkPool {
  private readonly slots: MarkSlot[] = [];
  readonly alphaFade: boolean;

  constructor(texture: Texture, count: number, alphaFade: boolean, group: Group) {
    this.alphaFade = alphaFade;
    for (let i = 0; i < count; i++) {
      const material = new MeshBasicNodeMaterial({ map: texture });
      // Burn/grenade marks are `blendfunc GL_ZERO GL_ONE_MINUS_SRC_COLOR`
      // (darkens the wall by the texture's own colour); plasma is plain
      // `blendfunc blend`. Using alpha blending for both -- what a bare
      // `transparent: true` material defaults to -- renders burn marks with
      // their source colours inverted relative to what they should look
      // like on the wall. See `blend.ts`.
      if (alphaFade) {
        applyAlphaBlend(material);
      } else {
        applyDarkenBlend(material);
      }
      // Sits on the surface it marks; needs to win the depth tie without
      // fighting it, same reasoning as the blob shadow.
      material.polygonOffset = true;
      material.polygonOffsetFactor = -1;
      material.polygonOffsetUnits = -1;

      const positions = new Float32Array(MAX_FRAGMENT_VERTS * 3);
      const uvs = new Float32Array(MAX_FRAGMENT_VERTS * 2);
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
      // Shared across every slot in every pool: the fan pattern never changes,
      // only which prefix of it `setDrawRange` exposes.
      geometry.setIndex(fanIndex);
      geometry.setDrawRange(0, 0);

      // Fragments are already absolute world-space points (that's what
      // `markFragments` clipped them to), so the mesh itself stays at the
      // identity transform -- no per-instance position or rotation.
      const mesh = new Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;
      /*
       * ...and because it stays at identity for its whole life, three has
       * nothing to recompute. `updateMatrixWorld` walks the graph regardless of
       * `visible`, so without this the pools cost a `compose` and a
       * `multiplyMatrices` per slot per frame with no decal on screen at all --
       * 256 of them on q3dm6, the largest single group in a scene graph of
       * 1012 (`npm run census`).
       *
       * The one `updateMatrix()` below is the last this mesh will ever need. It
       * is not ceremony: with the flag off, `matrixWorld` is only recomputed
       * when `matrixWorldNeedsUpdate` is set or a parent passes `force` down,
       * and the roots no longer force (see `renderer.ts`). Without it a mesh
       * added after the first frame would keep the identity `matrixWorld` it
       * was constructed with and draw in Z-up, in the wrong place, with no
       * error. Unlike the particle pools in `effects.ts` there is no second
       * call to remember later, because a new mark rewrites the geometry's
       * vertices rather than the mesh's transform -- which is what the note
       * above makes true.
       */
      freezeTransform(mesh);
      group.add(mesh);

      this.slots.push({ mesh, material, positions, uvs, born: 0 });
    }
  }

  /** `CG_AllocMark`: always succeeds, evicting the oldest live fragment if full. */
  private claim(): MarkSlot {
    let oldest: MarkSlot | null = null;
    for (const slot of this.slots) {
      if (slot.born === 0) {
        return slot;
      }
      if (!oldest || slot.born < oldest.born) {
        oldest = slot;
      }
    }
    // Pool is full of live fragments; oldest is non-null because count > 0.
    return oldest as MarkSlot;
  }

  spawn(fragment: TexturedMarkFragment, now: number): void {
    const n = Math.min(fragment.verts.length, MAX_FRAGMENT_VERTS);
    if (n < 3) {
      return;
    }

    const slot = this.claim();
    slot.born = now;
    slot.material.color.setScalar(1);
    slot.material.opacity = 1;

    // `fragment.verts` carries Quake's own winding (inherited from
    // `brushSideWinding`'s `baseWindingForPlane`, cm_polylib.c's convention) --
    // opposite three's, same reason `bsp-mesh.ts`'s header note reverses every
    // triangle read off the BSP. Reversed here, not at the collision layer:
    // `markfragments.ts` stays a pure geometry port with no opinion about a
    // renderer's winding convention, same split as everywhere else in this
    // project. Skipping this left every mark back-face culled -- invisible
    // from exactly the side a player is standing on when they fire.
    for (let i = 0; i < n; i++) {
      const v = fragment.verts[n - 1 - i];
      slot.positions[i * 3 + 0] = v.point[0];
      slot.positions[i * 3 + 1] = v.point[1];
      slot.positions[i * 3 + 2] = v.point[2];
      slot.uvs[i * 2 + 0] = v.u;
      slot.uvs[i * 2 + 1] = v.v;
    }
    const geometry = slot.mesh.geometry;
    (geometry.attributes.position as BufferAttribute).needsUpdate = true;
    (geometry.attributes.uv as BufferAttribute).needsUpdate = true;
    geometry.setDrawRange(0, (n - 2) * 3);

    slot.mesh.visible = true;
  }

  /** `CG_AddMarks`, one pool's worth: age, fade, free. */
  update(now: number): void {
    for (const slot of this.slots) {
      if (slot.born === 0) {
        continue;
      }
      if (now >= slot.born + MARK_TOTAL_TIME) {
        slot.born = 0;
        slot.mesh.visible = false;
        continue;
      }

      if (this.alphaFade) {
        // `CG_AddMarks`'s energy-burst dim: a plasma mark starts full-bright
        // and darkens on its own clock (nothing to do with the end-of-life
        // fade below), fully black by 3s, and stays black until removed.
        const age = now - slot.born;
        const burst = (450 - (450 * age) / 3000) / 255;
        slot.material.color.setScalar(Math.min(1, Math.max(0, burst)));
      }

      const remaining = slot.born + MARK_TOTAL_TIME - now;
      if (remaining < MARK_FADE_TIME) {
        const fade = remaining / MARK_FADE_TIME;
        if (this.alphaFade) {
          slot.material.opacity = fade;
        } else {
          slot.material.color.setScalar(fade);
        }
      }
    }
  }
}

export interface DecalsOptions {
  /** Where to add the meshes. Expected to be the Quake-space world group. */
  parent: Object3D;
}

export class Decals {
  private readonly model: CollisionModel;
  private readonly burnPool: MarkPool | null;
  private readonly energyPool: MarkPool | null;
  private readonly bulletPool: MarkPool | null;

  private constructor(
    model: CollisionModel,
    burnPool: MarkPool | null,
    energyPool: MarkPool | null,
    bulletPool: MarkPool | null,
  ) {
    this.model = model;
    this.burnPool = burnPool;
    this.energyPool = energyPool;
    this.bulletPool = bulletPool;
  }

  static async create(
    fs: Pk3FileSystem | null,
    model: CollisionModel,
    options: DecalsOptions,
  ): Promise<Decals> {
    const group = new Group();
    options.parent.add(group);

    const burnTexture = fs ? await loadTexture(fs, BURN_IMAGE) : null;
    const energyTexture = fs ? await loadTexture(fs, ENERGY_IMAGE) : null;
    const bulletTexture = fs ? await loadTexture(fs, BULLET_IMAGE) : null;

    return new Decals(
      model,
      // No art, no pool -- same "no art, no shadow" fallback as shadow.ts.
      burnTexture ? new MarkPool(burnTexture, BURN_POOL_SIZE, false, group) : null,
      energyTexture ? new MarkPool(energyTexture, ENERGY_POOL_SIZE, true, group) : null,
      // Alpha-faded like the burn mark, not the energy one: a bullet hole is
      // a hole, and `CG_ImpactMark`'s `alphaFade` is false for it too.
      bulletTexture ? new MarkPool(bulletTexture, BULLET_POOL_SIZE, false, group) : null,
    );
  }

  /**
   * `CG_ImpactMark`, dispatched through `CG_MissileHitWall`'s table by
   * classname. No-ops for an unknown classname or a mark kind whose texture
   * didn't load. Clips against the collision model via `buildImpactMark`
   * (the real `R_MarkFragments` port) and spawns one pool slot per surviving
   * fragment -- zero, for a mark with nothing nearby to land on, same as id.
   *
   * `origin` and `normal` come straight off the game frame's `Explosion`:
   * `missiles.ts` only omits `normal` when the impact can't leave a mark at
   * all (hit a mover, not the world).
   */
  spawnFor(
    classname: string,
    origin: Vec3 | readonly number[],
    normal: Vec3 | readonly number[],
    now: number,
  ): void {
    const params = WEAPON_MARKS[classname];
    if (!params) {
      return;
    }
    const pool =
      params.kind === 'energy'
        ? this.energyPool
        : params.kind === 'bullet'
          ? this.bulletPool
          : this.burnPool;
    if (!pool) {
      return;
    }

    const originVec = toVec3(origin);
    const normalVec = toVec3(normal);
    const fragments = buildImpactMark(
      this.model,
      originVec,
      normalVec,
      Math.random() * 360,
      params.radius,
    );
    for (const fragment of fragments) {
      pool.spawn(fragment, now);
    }
  }

  /** `CG_AddMarks`. */
  update(now: number): void {
    this.burnPool?.update(now);
    this.energyPool?.update(now);
    this.bulletPool?.update(now);
  }
}

function toVec3(v: Vec3 | readonly number[]): Vec3 {
  return v instanceof Float32Array ? v : (Float32Array.from(v) as Vec3);
}
