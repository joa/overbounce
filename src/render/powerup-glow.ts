/**
 * The volumetric-looking glow around a powerup carrier.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * **NOT Quake.** Quake gives a Quad carrier exactly two things: a 200-unit
 * dlight (`CG_PlayerPowerups`, cg_players.c:1839) and the `powerups/quad` shell
 * re-draw (`CG_AddRefEntityWithPowerups`). Both are ported and both are
 * present. This is a third thing, on the deliberate-additions track alongside
 * the lava bloom, and it exists because the project owner asked for the glow to
 * read as an actual volume of light rather than as a tint on the model.
 *
 * ## Why this is not a three.js light
 *
 * The obvious implementation — `new PointLight(0x3333ff, ...)` — does nothing
 * here, and it is worth writing down why so nobody tries it again. Every
 * surface in this renderer is a `MeshBasicNodeMaterial`: the world is lit by
 * baked lightmaps and models by a light-grid sample, exactly as Quake does it.
 * A `MeshBasicMaterial` is unlit by definition and ignores every light in the
 * scene. Adding a PointLight would cost a shadow-map-adjacent pile of uniforms
 * and change not one pixel.
 *
 * What *does* light this world is `dynamic-lights.ts`, which is Quake's own
 * dlight model reimplemented as a handful of uniforms and a `1 - dist/radius`
 * term composited into every material. The Quad already feeds that. So the
 * missing half was never illumination — it was the light SOURCE having no
 * visible body.
 *
 * ## What it actually is
 *
 * An additive sphere around the carrier whose brightness falls off toward its
 * own silhouette, so it reads as a ball of light with soft edges rather than as
 * a blue balloon. `normalView.z` is the facing term: in view space the camera
 * looks down -Z, so a fragment whose normal points at the camera is the middle
 * of the sphere and one perpendicular to it is the rim.
 *
 * That is a cheap fake and it is the right kind of cheap. True volumetrics
 * means raymarching a participating medium against the depth buffer — a real
 * project, and one whose cost lands on a game that has to hold 125Hz physics.
 * Two additive spheres and a falloff give the read for the price of two draws.
 *
 * The pulse is deliberate too: a perfectly steady glow reads as geometry, and a
 * moving one reads as light.
 */

import {
  AdditiveBlending,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
} from 'three/webgpu';
import type { Object3D } from 'three/webgpu';
import { float, normalView, uniform, vec3, vec4 } from 'three/tsl';

/**
 * How far the glow reaches, in Q3 units.
 *
 * Generous next to a player's 30-unit width, because a glow that stops at the
 * model is a highlight rather than an atmosphere. Well under the 200-unit
 * dlight radius it accompanies, so the lit floor always extends further than
 * the visible ball — light spilling past its own source is what sells it.
 */
export const GLOW_RADIUS = 38;

/** The inner core's share of that radius. */
export const GLOW_CORE_SCALE = 0.5;

/**
 * How sharply brightness falls toward the silhouette. Higher is tighter.
 *
 * Chosen by eye and revised once. 2.5 with a 64-unit radius produced a solid
 * blue balloon that swallowed the player and left a hard straight edge where
 * the sphere cut through the floor — additive geometry intersecting a solid is
 * always going to show that seam, so the answer is to make the rim faint enough
 * that the seam is faint too. 4.5 at 38 units does that; 1 is a flat disc that
 * reads as a decal and 8 is a pinpoint with no volume at all.
 */
export const GLOW_FALLOFF = 4.5;

/** Peak brightness of the outer shell, before the pulse. */
export const GLOW_INTENSITY = 0.42;

/** Cycles per second of the brightness pulse. */
export const GLOW_PULSE_HZ = 1.6;

/** How much the pulse moves the brightness, as a fraction. */
export const GLOW_PULSE_DEPTH = 0.18;

/**
 * Glow colours, matched to the shell shader each powerup already draws.
 *
 * Quake has a dlight colour for the Quad only (`CG_PlayerPowerups`), so the
 * other two are read off their `powerups/*` shaders instead of invented: the
 * battlesuit's shell is `textures/effects/envmapgold2`, and regeneration's is
 * `regenmap2`, which is red. Matching them means the glow and the hull look
 * like one effect rather than two.
 */
export const GLOW_COLORS = {
  quad: [0.2, 0.2, 1] as [number, number, number],
  battlesuit: [1, 0.8, 0.25] as [number, number, number],
  regen: [1, 0.25, 0.2] as [number, number, number],
} as const;

export interface PowerupGlow {
  /** Parent this to whatever follows the carrier. */
  readonly object: Object3D;
  /** Show or hide. Cheap enough to call every frame. */
  setActive(active: boolean): void;
  /** `nowMs` is any monotonic clock; drives the pulse. */
  update(nowMs: number): void;
  dispose(): void;
}

/**
 * Build a glow.
 *
 * Two concentric additive spheres rather than one. A single shell with a strong
 * falloff has a visibly dark middle — the falloff is lowest exactly where the
 * surface faces the camera edge-on, and that band crosses the centre of the
 * sphere as seen from outside. The inner core fills it in, and the two together
 * give a gradient no single sphere produces.
 */
export function createPowerupGlow(
  color: readonly [number, number, number],
  radius = GLOW_RADIUS,
  intensity = GLOW_INTENSITY,
): PowerupGlow {
  const object = new Group();
  object.name = 'overbounce.powerupGlow';
  object.visible = false;

  /** Multiplies both shells; the pulse writes it. */
  const pulse = uniform(1);

  const shell = (scale: number, strength: number, falloff: number): Mesh => {
    const material = new MeshBasicNodeMaterial();

    /*
     * `normalView.z` is the facing term. In view space the camera looks down
     * -Z, so a fragment whose normal points at the viewer has |z| near 1 (the
     * middle of the ball) and one perpendicular to the view has |z| near 0 (the
     * rim). `abs` because the back hemisphere is just as much "facing" for a
     * shape with no inside.
     */
    const facing = normalView.z.abs().clamp(0, 1);
    const brightness = facing.pow(float(falloff)).mul(strength).mul(pulse);

    material.colorNode = vec4(
      vec3(color[0], color[1], color[2]).mul(brightness),
      float(1),
    );
    // Additive, and no depth write. A glow adds light to what is behind it; it
    // does not occlude, and writing depth would let it hide the player it is
    // supposed to be shining off.
    material.blending = AdditiveBlending;
    material.transparent = true;
    material.depthWrite = false;

    const mesh = new Mesh(new SphereGeometry(radius * scale, 24, 16), material);
    // After the player, whose shell is already at +1.
    mesh.renderOrder = 3;
    // The shadow pass draws casters solid black; a glow casting a filled ball
    // onto the floor is the exact opposite of the intended effect.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  };

  const outer = shell(1, intensity, GLOW_FALLOFF);
  const core = shell(GLOW_CORE_SCALE, intensity * 1.6, GLOW_FALLOFF * 0.6);
  object.add(outer);
  object.add(core);

  return {
    object,

    setActive(active: boolean): void {
      object.visible = active;
    },

    update(nowMs: number): void {
      if (!object.visible) {
        return;
      }
      const phase = (nowMs / 1000) * GLOW_PULSE_HZ * Math.PI * 2;
      pulse.value = 1 + Math.sin(phase) * GLOW_PULSE_DEPTH;
    },

    dispose(): void {
      for (const mesh of [outer, core]) {
        mesh.geometry.dispose();
        (mesh.material as MeshBasicNodeMaterial).dispose();
      }
      object.removeFromParent();
    },
  };
}
