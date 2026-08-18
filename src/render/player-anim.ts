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

import type { BufferAttribute } from 'three/webgpu';
import { Anim } from '../physics/anim.js';
import type { PlayerState } from '../physics/types.js';
import { animationFrame, parseAnimationFile } from '../assets/animation.js';
import type { AnimationSet } from '../assets/animation.js';
import type { Pk3FileSystem } from '../assets/pk3.js';
import { lerpSurfaceFrames } from '../assets/md3.js';
import type { LoadedMd3, PlayerModel } from './md3-mesh.js';

/** One half of the player: the legs, or the torso. */
class AnimPart {
  /** The packed value (number + toggle bit) currently playing. */
  private packed = -1;
  private startedAt = 0;

  constructor(private readonly loaded: LoadedMd3) {}

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

export class AnimatedPlayer {
  private readonly legs: AnimPart;
  private readonly torso: AnimPart;

  constructor(model: PlayerModel, private readonly set: AnimationSet) {
    this.legs = new AnimPart(model.legs);
    this.torso = new AnimPart(model.torso);
  }

  get animations(): AnimationSet {
    return this.set;
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
