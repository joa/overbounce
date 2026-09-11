/**
 * Projectiles in flight, drawn from a list of sightings rather than from a
 * simulation.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ## Why a "sighting" and not a `Missile`
 *
 * `runCourse` draws its projectiles straight off `game.missiles`, which is
 * the right thing there: it owns the simulation, so it has `pos.trDelta` and
 * a stable object identity for free. Playback has neither. A `.dm_68` is a
 * recording of what a server SAID, and what it said about a rocket is an
 * entity number, an origin and a `weapon` -- no trajectory, no classname,
 * and certainly no object to hold onto between frames.
 *
 * So the input here is the smallest thing both can produce: where a
 * projectile is, what kind it is, and a number that means "the same one as
 * last frame". Everything that needs history -- which way the model points --
 * is derived from that number, inside.
 *
 * ## Direction comes from the trail, not from the entity's angles
 *
 * `CG_Missile` orients the model along `s.pos.trDelta`, the LAUNCH direction,
 * which is why a Quake grenade points where it was thrown for its whole arc
 * instead of tipping over with the fall. A demo's entity carries `angles`,
 * but for a missile those are not what the cgame reads and are usually zero.
 *
 * What playback does have is the previous frame's origin, so the model is
 * aimed along where the thing has actually been travelling. For a rocket --
 * which flies straight -- that is exactly `trDelta`. For a grenade it is the
 * tangent rather than the launch direction, so an Overbounce grenade tips
 * over where a Quake one would not; that is a visible difference from the
 * game and it is the price of not having the trajectory in the recording.
 */

import { Group, Mesh, MeshBasicNodeMaterial, SphereGeometry } from 'three/webgpu';
import type { Object3D, Texture } from 'three/webgpu';
import type { Pk3FileSystem } from '../assets/pk3.js';
import type { ModelShaderContext } from '../course-world.js';
import { loadMd3, loadTexture } from './md3-mesh.js';
import { createPlasmaBallVisual } from './plasma-ball.js';
import type { PlasmaBallVisual } from './plasma-ball.js';
import { orientAlong } from './effects.js';

/** Which visual a projectile gets. `CG_Missile`'s three cases. */
export type MissileKind = 'rocket' | 'grenade' | 'plasma';

/** One projectile, this frame. */
export interface MissileSighting {
  /**
   * Stable across frames for the same projectile.
   *
   * The source's own entity number, which both a demo and a re-simulated
   * ghost have. It is what lets the view remember where this projectile was
   * last frame, which is the only way it can know which way to point the
   * model -- see the file header.
   */
  id: number;
  origin: readonly [number, number, number];
  kind: MissileKind;
}

export interface MissileView {
  /** The container, already parented. Nothing else needs to touch it. */
  readonly object: Object3D;
  /** Once a frame. `nowSeconds` drives the plasma sprite's own animation. */
  update(sightings: readonly MissileSighting[], nowSeconds: number): void;
  /**
   * Forget every remembered position.
   *
   * A backward scrub is not continuous motion, so the direction carried
   * across it would be nonsense -- a rocket that has un-flown pointing the
   * way it used to go.
   */
  reset(): void;
}

export interface MissileViewOptions {
  parent: Object3D;
  fs: Pk3FileSystem | null;
  shaders: ModelShaderContext;
  /** Pool size. A rocket launcher at 800ms between shots never needs many. */
  max?: number;
}

interface Slot {
  holder: Group;
  rocket: Object3D;
  grenade: Object3D;
  plasma: PlasmaBallVisual | null;
}

export async function createMissileView(options: MissileViewOptions): Promise<MissileView> {
  const { parent, fs, shaders } = options;
  const max = options.max ?? 24;

  const group = new Group();
  parent.add(group);

  // The sphere is the fallback for when no paks are mounted; the real models
  // are swapped in below if they load. Separate instances sharing one
  // geometry and material, since each is independently visible and an
  // Object3D can only have one parent.
  const geom = new SphereGeometry(5, 8, 6);
  const mat = new MeshBasicNodeMaterial({ color: 0xffb03d });

  const rocketModel = fs
    ? await loadMd3(fs, 'models/ammo/rocket/rocket.md3', null, shaders).catch(() => null)
    : null;
  // `models/ammo/grenade1.md3`, cg_weapons.c:770 -- unlike the rocket it sits
  // directly under models/ammo/, not in a subdirectory of its own.
  const grenadeModel = fs
    ? await loadMd3(fs, 'models/ammo/grenade1.md3', null, shaders).catch(() => null)
    : null;
  /*
   * The plasma gun's own visual. `cg_ents.c :: CG_Missile` special-cases
   * `WP_PLASMAGUN` before the generic missile-model path: a camera-facing
   * sprite, never a model. Missing only if the pak has no `sprites/plasmaa.tga`,
   * in which case a plasma bolt shares the rocket visual rather than going
   * invisible.
   */
  const plasmaTexture: Texture | null = fs
    ? await loadTexture(fs, 'sprites/plasmaa.tga').catch(() => null)
    : null;

  const slots: Slot[] = [];
  for (let i = 0; i < max; i++) {
    const holder = new Group();
    holder.visible = false;
    const rocket = rocketModel ? rocketModel.object.clone(true) : new Mesh(geom, mat);
    const grenade = grenadeModel ? grenadeModel.object.clone(true) : new Mesh(geom, mat);
    grenade.visible = false;
    holder.add(rocket, grenade);
    const plasma = plasmaTexture ? createPlasmaBallVisual(plasmaTexture) : null;
    if (plasma) {
      plasma.object.visible = false;
      holder.add(plasma.object);
    }
    group.add(holder);
    slots.push({ holder, rocket, grenade, plasma });
  }

  /*
   * A MISSILE NEVER CASTS, and here that is a correctness decision rather
   * than a cost one.
   *
   * A rocket carries its own dynamic light, at its own origin, INSIDE its own
   * model -- so the model sits between the light and everything the light
   * touches. The shadow pass draws the rocket solid black a few units from a
   * point light with a 200-unit reach and the whole cone in front of it comes
   * back occluded. It does not read as "the rocket has a shadow", it reads as
   * the level going dark ahead of it. Applied after every visual is installed,
   * because `md3-mesh.ts` marks each surface a caster as it builds it and a
   * clone carries the flag with it.
   */
  group.traverse((o) => {
    o.castShadow = false;
  });

  /**
   * Where each projectile was last seen, and the last direction it was
   * actually seen MOVING in.
   *
   * The direction is remembered separately, and that is not tidiness. Two
   * consecutive frames at the same clip time -- a paused viewer studying a
   * shot, or the same instant re-rendered -- give a delta of zero, and
   * `orientAlong` answers a zero direction by pointing the model straight up
   * (id's own `ent.axis[0][2] = 1` fallback). So a paused rocket stood on its
   * tail. Keeping the last real direction means a still frame shows the
   * rocket flying the way it was flying, which is the only answer that makes
   * sense for a paused clip and for an export.
   */
  interface Tracked {
    pos: [number, number, number];
    dir: [number, number, number] | null;
  }
  const lastSeen = new Map<number, Tracked>();

  return {
    object: group,

    update(sightings, nowSeconds): void {
      const seen = new Set<number>();
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!;
        const m = sightings[i];
        if (!m) {
          slot.holder.visible = false;
          continue;
        }
        seen.add(m.id);
        slot.holder.visible = true;
        slot.holder.position.set(m.origin[0], m.origin[1], m.origin[2]);

        const isPlasma = m.kind === 'plasma' && slot.plasma !== null;
        const isGrenade = m.kind === 'grenade' && !isPlasma;
        slot.rocket.visible = !isPlasma && !isGrenade;
        slot.grenade.visible = isGrenade;
        if (slot.plasma) {
          slot.plasma.object.visible = isPlasma;
        }

        let tracked = lastSeen.get(m.id);
        if (tracked) {
          const dx = m.origin[0] - tracked.pos[0];
          const dy = m.origin[1] - tracked.pos[1];
          const dz = m.origin[2] - tracked.pos[2];
          // A real move, not a re-render of the same instant. `1e-4` rather
          // than a strict zero because the origins are interpolated floats.
          if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-4) {
            tracked.dir = [dx, dy, dz];
          }
          tracked.pos[0] = m.origin[0];
          tracked.pos[1] = m.origin[1];
          tracked.pos[2] = m.origin[2];
        } else {
          tracked = { pos: [m.origin[0], m.origin[1], m.origin[2]], dir: null };
          lastSeen.set(m.id, tracked);
        }

        if (isPlasma && slot.plasma) {
          // A sprite billboards on its own -- no orientAlong for this one.
          slot.plasma.update(nowSeconds);
        } else if (tracked.dir) {
          orientAlong(slot.holder, tracked.dir);
        }
        // With no direction yet -- the single frame a projectile appears on
        // -- the model keeps whatever the pool slot last pointed at, which
        // for one frame is less wrong than standing it on its tail.
      }
      // A projectile that has exploded is gone from the list, and its entry
      // would otherwise sit in the map for the rest of the session.
      if (lastSeen.size > seen.size) {
        for (const id of [...lastSeen.keys()]) {
          if (!seen.has(id)) {
            lastSeen.delete(id);
          }
        }
      }
    },

    reset(): void {
      lastSeen.clear();
    },
  };
}
