/**
 * Dynamic lights — rockets and explosions lighting the world.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This only became meaningful once the map had lightmaps. Before that every
 * surface was flat-shaded and "adding light" would have been indistinguishable
 * from tinting. Now there is baked light to add to, and a rocket flying down a
 * dark corridor lights the walls as it passes — which in Quake is not just
 * decoration, it is how you see where your own rocket went.
 *
 * Values from the id source rather than taste:
 *
 *   - `cg_ents.c` adds a light at the missile's position every frame, using the
 *     weapon's `missileDlight` / `missileDlightColor`.
 *   - `cg_effects.c` gives a rocket explosion `light = 300` and
 *     `lightColor = (1, 0.75, 0)`.
 *   - `cg_localents.c` holds the explosion at full brightness for the first
 *     half of its life and then fades linearly:
 *     `light < 0.5 ? 1.0 : 1.0 - (light - 0.5) * 2`.
 *
 * The shader side is a fixed-size uniform array rather than a light list,
 * because every world material shares one set of uniforms: 85 materials each
 * carrying their own light state would mean 85 uniform buffers updated per
 * frame, and the whole point is that this is cheap.
 */

import { Vector3, Vector4 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { positionWorld, uniform, vec3 } from 'three/tsl';

/** How many lights can affect the world at once. Quake's own limit is 32. */
export const MAX_DYNAMIC_LIGHTS = 8;

/** `cg_effects.c`: a rocket explosion. */
export const ROCKET_EXPLOSION_LIGHT = 300;
export const ROCKET_LIGHT_COLOR: [number, number, number] = [1, 0.75, 0];

/** `cg_ents.c`: the missile in flight. */
export const ROCKET_MISSILE_LIGHT = 200;

/**
 * `CG_PlayerPowerups`, cg_players.c:1839 -- a player carrying Quad glows.
 *
 *     trap_R_AddLightToScene( cent->lerpOrigin, 200 + (rand()&31), 0.2f, 0.2f, 1 );
 *
 * This is the ONLY powerup light Quake has, CTF flags aside, and it is on the
 * carrier rather than on the item. Lighting the pedestals is an addition; see
 * B6 in .agent/plans/VISUALS.md.
 */
export const QUAD_LIGHT = 200;
export const QUAD_LIGHT_COLOR: [number, number, number] = [0.2, 0.2, 1];

export interface DynamicLight {
  origin: ArrayLike<number>;
  /** Radius; 0 means the slot is unused. */
  radius: number;
  color: ArrayLike<number>;
}

export class DynamicLights {
  /** xyz = position, w = radius. */
  private readonly positions: Vector4[] = [];
  private readonly colors: Vector3[] = [];
  private readonly positionNodes: Node<'vec4'>[] = [];
  private readonly colorNodes: Node<'vec3'>[] = [];

  constructor() {
    // One uniform per slot rather than a uniformArray. Both work on the GPU;
    // this one has a type TSL can follow through a swizzle, and 16 uniforms is
    // not a number worth optimising.
    for (let i = 0; i < MAX_DYNAMIC_LIGHTS; i++) {
      const position = new Vector4(0, 0, 0, 0);
      const color = new Vector3(0, 0, 0);
      this.positions.push(position);
      this.colors.push(color);
      this.positionNodes.push(uniform(position));
      this.colorNodes.push(uniform(color));
    }
  }

  /**
   * Replace the whole light set for this frame.
   *
   * Lights are transient — a missile moves, an explosion fades — so rebuilding
   * the list each frame is simpler and cheaper than tracking identities. Extra
   * lights beyond the limit are dropped rather than replacing an existing one,
   * because a light that flickers in and out as the list reshuffles reads far
   * worse than one that is simply absent.
   */
  set(lights: readonly DynamicLight[]): void {
    for (let i = 0; i < MAX_DYNAMIC_LIGHTS; i++) {
      const light = lights[i];
      if (light) {
        this.positions[i].set(light.origin[0], light.origin[1], light.origin[2], light.radius);
        this.colors[i].set(light.color[0], light.color[1], light.color[2]);
      } else {
        this.positions[i].w = 0;
      }
    }
  }

  /**
   * The TSL node for the light reaching this fragment.
   *
   * A linear `1 - dist/radius` falloff, which is what Quake's own dlight does:
   * not physically correct, but it is the look, and an inverse-square falloff
   * makes a 300-unit rocket light vanish almost immediately.
   */
  contribution(): Node<'vec3'> {
    // Annotated rather than inferred: TSL's node types are precise enough that
    // `vec3(0,0,0)` infers as a VarNode and `.add()` widens to a plain Node, so
    // an inferred accumulator cannot be reassigned to its own sum.
    let total: Node<'vec3'> = vec3(0, 0, 0);

    for (let i = 0; i < MAX_DYNAMIC_LIGHTS; i++) {
      const packed = this.positionNodes[i];
      const color = this.colorNodes[i];

      // A linear falloff, clamped at zero. An unused slot has radius 0, and
      // `max(0.001)` keeps the divide finite so it contributes nothing without
      // needing a per-fragment branch over every slot.
      const dist = positionWorld.distance(packed.xyz);
      const falloff = dist.div(packed.w.max(0.001)).oneMinus().max(0);

      total = total.add(color.mul(falloff));
    }

    return total;
  }
}
