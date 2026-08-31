/**
 * The racing ghost, drawn as a real player model.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The ghost used to be a translucent box, on the reasoning that it "has to
 * read as 'not you' at a glance, and a ghost you can mistake for yourself is
 * worse than no ghost." That constraint still holds -- what changes here is
 * the mechanism. A box throws away everything a model tells you about the run
 * you are chasing: which way it is facing, whether it is mid-jump, where its
 * feet are relative to the ledge you are both aiming at. Opacity plus a tint
 * in the SAME blue the box already used keeps "not you" while giving that
 * information back.
 *
 * It wears the model the recording player wore (`GhostRun.player`), falling
 * back to the renderer's own preference list when that one is not in the
 * mounted paks -- a ghost carried between installs is the ordinary case, not
 * an error.
 *
 * A GHOST NEVER SHARES THE LIVE PLAYER'S `PlayerModel`, even when both are
 * wearing the same one -- which, racing your own personal best, is the common
 * case. `AnimPart.update` writes interpolated frames into the geometry's
 * `position.array` IN PLACE, so one shared load means both avatars snap to
 * whichever `update` ran last: the ghost and the player would animate as a
 * single body in two places. Textures dedupe through `loadTexture`'s cache
 * anyway, so the second load costs a parse and some vertex buffers, not the
 * skins.
 */

import { Color, Group } from 'three/webgpu';
import type { MeshBasicNodeMaterial, Node } from 'three/webgpu';
import { vec3 } from 'three/tsl';
import type { Pk3FileSystem } from '../assets/pk3.js';
import { AnimatedPlayer, loadAnimations } from './player-anim.js';
import { choosePlayerModel, loadPlayerModel, splitPlayerName } from './md3-mesh.js';
import type { Md3ShaderContext, PlayerModel } from './md3-mesh.js';

/**
 * The blue the box hull was drawn in (`0x5ad2ff`), as a multiplier.
 *
 * Reused rather than picked fresh so the thing players already recognise as
 * the ghost keeps its colour through the change of mechanism.
 */
const GHOST_TINT: readonly [number, number, number] = [0x5a / 255, 0xd2 / 255, 0xff / 255];

/** How solid the ghost is. Higher than the box's 0.28: a model has detail
 *  worth seeing, and the tint is already doing most of the "not you" work. */
const GHOST_OPACITY = 0.4;

export interface GhostAvatar {
  /** Parent this into the world; it sits at the ghost's player origin. */
  object: Group;
  /** Drives the MD3 frames from the ghost simulation's `PlayerState`. Null
   *  when the model has no `animation.cfg`, in which case it is frozen on
   *  frame 0 -- same degradation the live player takes. */
  animated: AnimatedPlayer | null;
  /** The model that was actually loaded, `model/skin`. Not necessarily the
   *  one asked for. */
  name: string;
}

/**
 * Make one loaded player see-through.
 *
 * `castShadow` is forced off AFTER the materials are mutated, not left to
 * `loadMd3`'s own `castsShadow(material)` call -- that ran while the material
 * was still opaque, and the shadow pass draws casters solid black, so a
 * translucent ghost would drag a filled silhouette across the floor. Same
 * reasoning `buildPowerupShell` documents for its shells.
 *
 * `depthWrite = false` is a real tradeoff taken on purpose. With depth writes
 * the ghost's own parts resolve against each other in whatever order the
 * meshes happen to be drawn, which flickers as the torso swings past the
 * legs; without them the ghost is see-through THROUGH ITSELF, which is what a
 * ghost is supposed to look like anyway.
 */
function makeTranslucent(model: PlayerModel): void {
  const tint = vec3(GHOST_TINT[0], GHOST_TINT[1], GHOST_TINT[2]);
  const tintColor = new Color(GHOST_TINT[0], GHOST_TINT[1], GHOST_TINT[2]);
  for (const part of [model.legs, model.torso, model.head]) {
    if (!part) {
      continue;
    }
    for (const mesh of part.meshes) {
      const material = mesh.material as MeshBasicNodeMaterial;
      material.transparent = true;
      material.opacity = GHOST_OPACITY;
      material.depthWrite = false;
      // On a node material `opacityNode` defaults to `materialOpacity`, so the
      // `opacity` above composes with whatever `colorNode` the skin or its
      // shader built rather than being ignored.
      const existing = material.colorNode as Node<'vec3'> | null;
      if (existing) {
        material.colorNode = existing.mul(tint);
      } else {
        // The missing-texture path never sets `colorNode` at all and leaves a
        // flat grey in `material.color`, which IS read when there is no node.
        material.color.multiply(tintColor);
      }
      material.needsUpdate = true;
      mesh.castShadow = false;
    }
  }
}

/**
 * Load a ghost's avatar: the recorded model if the paks have it, otherwise the
 * first of `fallbacks` that they do.
 *
 * Returns null when no player model can be drawn at all (no paks carry one, or
 * the load failed) -- the caller keeps its box for that case, the same way the
 * live player keeps `playerMesh`.
 */
export async function loadGhostAvatar(
  fs: Pk3FileSystem,
  /** The model the ghost was recorded with, if it recorded one. */
  recorded: string | undefined,
  /** Tried in order when `recorded` is absent or not in the paks. */
  fallbacks: readonly string[],
  ctx: Md3ShaderContext | null = null,
): Promise<GhostAvatar | null> {
  const preference = recorded ? [recorded, ...fallbacks] : [...fallbacks];
  const choice = choosePlayerModel(fs, preference);
  if (!choice) {
    return null;
  }
  if (recorded && choice.name.toLowerCase() !== recorded.toLowerCase()) {
    console.warn(
      `[overbounce] ghost was recorded with "${recorded}", which is not in the ` +
        `loaded paks. Drawing it as "${choice.name}".`,
    );
  }

  const { model: modelName, skin } = splitPlayerName(choice.name);
  const model = await loadPlayerModel(fs, modelName, skin, ctx);
  if (!model) {
    return null;
  }
  makeTranslucent(model);

  const object = new Group();
  object.add(model.object);

  // Without animation.cfg the model is frozen on frame 0, which on most Quake
  // models is a death pose -- worth saying out loud, but not worth refusing
  // to draw the ghost over.
  const set = await loadAnimations(fs, modelName);
  if (!set) {
    console.warn(`[overbounce] ghost model ${choice.name} has no animation.cfg; it will not animate`);
  }

  // No weapon and no powerup shells, deliberately. Both would need their own
  // second instance of a model for exactly the in-place-frames reason at the
  // top of this file, and the ghost's projectiles are not rendered either --
  // an empty-handed ghost is the consistent choice, not an omission.
  return {
    object,
    animated: set ? new AnimatedPlayer(model, set) : null,
    name: choice.name,
  };
}
