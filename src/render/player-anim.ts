/**
 * Driving a player model's MD3 frames from the simulation.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `ps.legsAnim` and `ps.torsoAnim` say *which* animation; animation.cfg says
 * which MD3 frames that animation spans; this walks the clock between them and
 * rewrites the vertex buffers.
 *
 * The one thing that is easy to get wrong: **ANIM_TOGGLEBIT**. The animation
 * number is only the low 7 bits; the high bit flips every time pmove restarts
 * an animation. Two consecutive jumps set `legsAnim` to the same LEGS_JUMP
 * number but with the toggle bit inverted, and comparing the packed value is
 * how you tell "jumped again" from "still jumping". Compare the stripped number
 * and the second jump never replays its animation.
 */

import type { BufferAttribute, Object3D } from 'three/webgpu';
import { Anim } from '../physics/anim.js';
import type { PlayerState } from '../physics/types.js';
import { animationFrame, parseAnimationFile } from '../assets/animation.js';
import type { AnimationSet } from '../assets/animation.js';
import type { Pk3FileSystem } from '../assets/pk3.js';
import { lerpSurfaceFrames, lerpTag } from '../assets/md3.js';
import { applyTag } from './md3-mesh.js';
import type { LoadedMd3, PlayerModel } from './md3-mesh.js';
import type { EntityLight } from './light-grid.js';

/** One half of the player: the legs, or the torso. */
class AnimPart {
  /** The packed value (number + toggle bit) currently playing. */
  private packed = -1;
  private startedAt = 0;
  /** The frames this part is currently between, for tag interpolation. */
  frameA = 0;
  frameB = 0;
  lerp = 0;

  constructor(readonly loaded: LoadedMd3) {}

  update(packed: number, set: AnimationSet, now: number): void {
    // The packed comparison is deliberate -- see the file header.
    if (packed !== this.packed) {
      this.packed = packed;
      this.startedAt = now;
    }

    const number = packed & 0x7f;
    const anim = set.animations[number];
    if (!anim || anim.numFrames <= 0) {
      return;
    }

    const { frameA, frameB, lerp } = animationFrame(anim, now - this.startedAt);
    // Kept so the tag chain can be interpolated on the same frames the
    // vertices are: a tag read at a different frame detaches the model.
    this.frameA = frameA;
    this.frameB = frameB;
    this.lerp = lerp;

    for (let i = 0; i < this.loaded.model.surfaces.length; i++) {
      const surface = this.loaded.model.surfaces[i];
      const mesh = this.loaded.meshes[i];
      if (!mesh) {
        continue;
      }

      const position = mesh.geometry.getAttribute('position') as BufferAttribute;
      const normal = mesh.geometry.getAttribute('normal') as BufferAttribute;

      lerpSurfaceFrames(
        surface,
        frameA,
        frameB,
        lerp,
        position.array as Float32Array,
        normal.array as Float32Array,
      );

      position.needsUpdate = true;
      normal.needsUpdate = true;
    }
  }
}

/** The three shells `CG_AddRefEntityWithPowerups` can draw. */
export type ShellKind = 'quad' | 'battlesuit' | 'regen';

/** Which shells should be drawn this frame. */
export interface ActivePowerups {
  quad: boolean;
  battlesuit: boolean;
  regen: boolean;
}

export class AnimatedPlayer {
  private readonly legs: AnimPart;
  private readonly torso: AnimPart;
  /** Hangs off the torso's tag_weapon. */
  private weapon: Object3D | null = null;
  /** The extra draws, by kind. Empty until `setShell` is called. */
  private readonly shells = new Map<ShellKind, readonly Object3D[]>();

  constructor(
    private readonly model: PlayerModel,
    private readonly set: AnimationSet,
  ) {
    this.legs = new AnimPart(model.legs);
    this.torso = new AnimPart(model.torso);
  }

  get animations(): AnimationSet {
    return this.set;
  }

  /**
   * Put a weapon in the player's hands.
   *
   * `cg_weapons.c` uses the ITEM's world model for this -- the same
   * `models/weapons2/...` MD3 that spins on the floor as a pickup -- rather
   * than a separate first-person model, so what you see the player carrying is
   * literally the thing they picked up.
   */
  /**
   * Re-light the whole player from the grid.
   *
   * Called every frame, unlike an item's once: `R_SetupEntityLighting` runs per
   * entity per frame, and the player is the one entity that moves. Running from
   * a dark corridor into a lit room has to change how the model looks or the
   * lighting reads as a texture rather than as light.
   *
   * Legs, torso and head are three separate MD3 loads with three sets of
   * uniforms, and all three take the SAME sample -- Quake lights an entity, not
   * a limb, so lighting them independently would visibly seam at the waist.
   */
  setLight(light: EntityLight): void {
    this.model.legs.setLight(light);
    this.model.torso.setLight(light);
    this.model.head?.setLight(light);
  }

  /**
   * Hand over the meshes `buildPowerupShell` made for one powerup.
   *
   * They are already parented next to the body's own meshes and start hidden;
   * all this does is give `setPowerups` something to switch.
   */
  setShell(kind: ShellKind, objects: readonly Object3D[]): void {
    this.shells.set(kind, objects);
  }

  /**
   * `CG_AddRefEntityWithPowerups`, as a visibility switch.
   *
   * Quake decides this by simply not making the second `AddRefEntityToScene`
   * call; a retained scene graph does the same thing by not drawing the mesh.
   *
   * `cgTime` is the client clock in milliseconds and is only used by regen,
   * which flashes rather than glowing steadily:
   *
   *     if ( ( ( cg.time / 100 ) % 10 ) == 1 ) { ... }
   *
   * One frame in ten -- 100ms on out of every second. Not a fade, and not a
   * sine: a hard blink, which is what makes regeneration read differently from
   * the Quad at a glance.
   */
  setPowerups(active: ActivePowerups, cgTime: number): void {
    const regenBlink = Math.floor(cgTime / 100) % 10 === 1;
    this.showShell('quad', active.quad);
    this.showShell('battlesuit', active.battlesuit);
    this.showShell('regen', active.regen && regenBlink);
  }

  private showShell(kind: ShellKind, visible: boolean): void {
    const objects = this.shells.get(kind);
    if (!objects) {
      return;
    }
    for (const o of objects) {
      o.visible = visible;
    }
  }

  /**
   * `R_ComputeFogNum`, applied to all three parts.
   *
   * The radius is the largest of the three model frames' bounding spheres --
   * Quake tests each entity separately, but legs, torso and head are ONE entity
   * here and fogging them by different volumes would seam at the waist for
   * exactly the reason `setLight` samples the grid once.
   */
  setFog(index: number): void {
    this.model.legs.setFog(index);
    this.model.torso.setFog(index);
    this.model.head?.setFog(index);
  }

  /** The bounding radius `R_ComputeFogNum` wants, over all three parts. */
  get radius(): number {
    return Math.max(
      this.model.legs.radius,
      this.model.torso.radius,
      this.model.head?.radius ?? 0,
    );
  }

  setWeapon(object: Object3D | null): void {
    if (this.weapon) {
      this.weapon.removeFromParent();
    }
    this.weapon = object;
    if (object) {
      this.model.torso.object.add(object);
    }
  }

  /**
   * `now` is any monotonic millisecond clock. It does not have to be the
   * simulation clock — animation is decorative, so it should run smoothly at
   * the display's rate rather than stepping at 125Hz.
   */
  update(ps: PlayerState, now: number): void {
    this.legs.update(ps.legsAnim, this.set, now);

    // Overbounce does not port PM_Weapon, so torsoAnim is never set by pmove.
    // Standing is the honest default rather than leaving frame 0, which on most
    // models is a death pose.
    const torso = ps.torsoAnim === 0 ? Anim.TORSO_STAND : ps.torsoAnim;
    this.torso.update(torso, this.set, now);

    // Re-hang the chain on THIS frame's tags. Tags move with the animation --
    // sarge's tag_torso travels 30 units between frames -- so a chain built
    // once at frame 0 comes apart at the waist as soon as the legs move.
    const torsoTag = lerpTag(
      this.legs.loaded.model,
      this.legs.frameA,
      this.legs.frameB,
      this.legs.lerp,
      'tag_torso',
    );
    if (torsoTag) {
      applyTag(this.model.torso.object, torsoTag);
    }

    // The weapon rides tag_weapon, which moves with the torso animation just
    // as tag_head does -- and for the same reason must be re-read every frame.
    if (this.weapon) {
      const weaponTag = lerpTag(
        this.torso.loaded.model,
        this.torso.frameA,
        this.torso.frameB,
        this.torso.lerp,
        'tag_weapon',
      );
      if (weaponTag) {
        applyTag(this.weapon, weaponTag);
      }
    }

    if (this.model.head) {
      const headTag = lerpTag(
        this.torso.loaded.model,
        this.torso.frameA,
        this.torso.frameB,
        this.torso.lerp,
        'tag_head',
      );
      if (headTag) {
        applyTag(this.model.head.object, headTag);
      }
    }
  }
}

/** Load a model's animation.cfg. Returns null if it has none. */
export async function loadAnimations(
  fs: Pk3FileSystem,
  name: string,
): Promise<AnimationSet | null> {
  const text = await fs.readText(`models/players/${name}/animation.cfg`);
  return text ? parseAnimationFile(text) : null;
}
