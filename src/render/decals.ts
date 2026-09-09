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
import type { EntityDynamicLight, EntityLight } from './light-grid.js';
import { applyDynamicLights } from './light-grid.js';
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
 * `CG_MissileHitWall`'s per-weapon table, narrowed to the weapons this port
 * has. Colour is `(1,1,1,1)` at spawn for all but one: the rail's mark is
 * "colorize[d] with client color" (cg_weapons.c:1947-1951), the player's
 * `color2`, whose Quake default `"5"` is magenta through `CG_ColorFromString`.
 */
type MarkKind = 'burn' | 'energy' | 'bullet';

type Tint = readonly [number, number, number];
const WHITE: Tint = [1, 1, 1];
/** `color2` "5" (cl_main.c:2357): bits 1 and 4, blue and red. */
const RAIL_MARK_COLOR: Tint = [1, 0, 1];

const WEAPON_MARKS: Record<string, { kind: MarkKind; radius: number; tint: Tint }> = {
  rocket: { kind: 'burn', radius: 64, tint: WHITE },
  grenade: { kind: 'burn', radius: 64, tint: WHITE },
  plasma: { kind: 'energy', radius: 16, tint: WHITE },
  // cg_weapons.c:1919 -- `radius = 8` for WP_MACHINEGUN, an eighth of a
  // rocket's crater.
  bullet: { kind: 'bullet', radius: 8, tint: WHITE },
  // cg_weapons.c:1872-1877 -- the same `bulletMarkShader` at HALF the
  // machine gun's radius, eleven of them per blast.
  shotgun: { kind: 'bullet', radius: 4, tint: WHITE },
  // cg_weapons.c:1854-1855 -- the plasma mark again, half as large again.
  rail: { kind: 'energy', radius: 24, tint: RAIL_MARK_COLOR },
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
  /** The mark's own colour; every fade below multiplies into it. */
  tint: Tint;
  /** Where it was stamped, for the dynamic lights. */
  origin: [number, number, number];
  /** The surface's normal, for `N . L`. */
  normal: [number, number, number];
  /** The light grid where it was stamped, sampled once. Null: unlit pool. */
  grid: EntityLight | null;
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
      /*
       * 1, and it has to stay 1: three orders transparent objects by
       * `renderOrder` before depth, and a mark has to draw AFTER any blended
       * world stage on the surface it sits on (a floor whose shader has a
       * blended pass is in the same transparent list) or that stage paints
       * over it. It was moved to 0 once, to get marks under the smoke, and
       * the marks vanished on such floors. The effects that float over a
       * mark are at `EFFECT_RENDER_ORDER` (2) instead -- `explosion-fx.ts`.
       * The depth TIE with the surface is the polygon offset's job.
       */
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

      this.slots.push({
        mesh,
        material,
        positions,
        uvs,
        born: 0,
        tint: WHITE,
        origin: [0, 0, 0],
        normal: [0, 0, 1],
        grid: null,
      });
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

  spawn(
    fragment: TexturedMarkFragment,
    now: number,
    tint: Tint = WHITE,
    origin: ArrayLike<number> = [0, 0, 0],
    normal: ArrayLike<number> = [0, 0, 1],
    grid: EntityLight | null = null,
  ): void {
    const n = Math.min(fragment.verts.length, MAX_FRAGMENT_VERTS);
    if (n < 3) {
      return;
    }

    const slot = this.claim();
    slot.born = now;
    slot.tint = tint;
    slot.origin[0] = origin[0];
    slot.origin[1] = origin[1];
    slot.origin[2] = origin[2];
    slot.normal[0] = normal[0];
    slot.normal[1] = normal[1];
    slot.normal[2] = normal[2];
    slot.grid = grid;
    slot.material.color.setRGB(tint[0], tint[1], tint[2]);
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

  /**
   * `CG_AddMarks`, one pool's worth: age, fade, free -- and light.
   *
   * `lights` are this frame's dynamic lights. A lit mark (`slot.grid` set)
   * is shaded the way a model is: `R_SetupEntityLighting`'s grid sample at
   * the impact, the dynamic lights folded in by `applyDynamicLights`, then
   * `RB_CalcDiffuseColor`'s `ambient + directed * max(0, N . L)` with the
   * surface normal as N. Per slot per frame, which is a few dozen dot
   * products; a mark does not move, so the grid half is sampled once.
   */
  update(now: number, lights: readonly EntityDynamicLight[] = []): void {
    for (const slot of this.slots) {
      if (slot.born === 0) {
        continue;
      }
      if (now >= slot.born + MARK_TOTAL_TIME) {
        slot.born = 0;
        slot.mesh.visible = false;
        continue;
      }

      let lr = 1;
      let lg = 1;
      let lb = 1;
      if (slot.grid) {
        const l = applyDynamicLights(slot.grid, slot.origin, lights);
        const n = slot.normal;
        const incoming = Math.max(0, n[0] * l.dir[0] + n[1] * l.dir[1] + n[2] * l.dir[2]);
        lr = Math.min(1, l.ambient[0] + l.directed[0] * incoming);
        lg = Math.min(1, l.ambient[1] + l.directed[1] * incoming);
        lb = Math.min(1, l.ambient[2] + l.directed[2] * incoming);
      }

      if (this.alphaFade) {
        // `CG_AddMarks`'s energy-burst dim: a plasma mark starts full-bright
        // and darkens on its own clock (nothing to do with the end-of-life
        // fade below), fully black by 3s, and stays black until removed.
        const age = now - slot.born;
        const burst = Math.min(1, Math.max(0, (450 - (450 * age) / 3000) / 255));
        const t = slot.tint;
        slot.material.color.setRGB(t[0] * burst * lr, t[1] * burst * lg, t[2] * burst * lb);
      }

      const remaining = slot.born + MARK_TOTAL_TIME - now;
      if (remaining < MARK_FADE_TIME) {
        const fade = remaining / MARK_FADE_TIME;
        if (this.alphaFade) {
          slot.material.opacity = fade;
        } else {
          const t = slot.tint;
          slot.material.color.setRGB(t[0] * fade, t[1] * fade, t[2] * fade);
        }
      }
    }
  }
}

export interface DecalsOptions {
  /** Where to add the meshes. Expected to be the Quake-space world group. */
  parent: Object3D;
  /**
   * `R_SetupEntityLighting`'s grid sample, for lighting the alpha-blended
   * marks (plasma, rail) like models. Omitted, those marks draw at full
   * brightness -- which is what Quake does with them, and what looked wrong
   * here: a `blendfunc blend` mark ignores the light on the wall it sits on,
   * where the burn and bullet marks' `GL_ZERO GL_ONE_MINUS_SRC_COLOR`
   * multiply the LIT framebuffer and so inherit it for free. This project
   * has real dynamic lights on its walls, and a plasma mark that stays
   * bright while a rocket lights the wall around it is the odd one out.
   */
  sampleLight?: (origin: ArrayLike<number>) => EntityLight;
}

export class Decals {
  private readonly model: CollisionModel;
  private readonly burnPool: MarkPool | null;
  private readonly energyPool: MarkPool | null;
  private readonly bulletPool: MarkPool | null;
  private readonly sampleLight: ((origin: ArrayLike<number>) => EntityLight) | null;

  private constructor(
    model: CollisionModel,
    burnPool: MarkPool | null,
    energyPool: MarkPool | null,
    bulletPool: MarkPool | null,
    sampleLight: ((origin: ArrayLike<number>) => EntityLight) | null = null,
  ) {
    this.model = model;
    this.burnPool = burnPool;
    this.energyPool = energyPool;
    this.bulletPool = bulletPool;
    this.sampleLight = sampleLight;
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
      options.sampleLight ?? null,
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
    // Only the alpha-blended (energy) marks are lit -- see `DecalsOptions`.
    // The darkening ones multiply the lit wall and need nothing.
    const grid =
      params.kind === 'energy' && this.sampleLight ? this.sampleLight(originVec) : null;
    for (const fragment of fragments) {
      pool.spawn(fragment, now, params.tint, originVec, normalVec, grid);
    }
  }

  /** `CG_AddMarks`. */
  update(now: number, lights: readonly EntityDynamicLight[] = []): void {
    this.burnPool?.update(now);
    this.energyPool?.update(now, lights);
    this.bulletPool?.update(now);
  }
}

function toVec3(v: Vec3 | readonly number[]): Vec3 {
  return v instanceof Float32Array ? v : (Float32Array.from(v) as Vec3);
}
