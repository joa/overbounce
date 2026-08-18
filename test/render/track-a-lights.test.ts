/**
 * The Quake constants behind muzzle flashes, the Quad glow, and blob shadows.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * These are ports, so they are pinned against the C rather than against
 * whatever looked right. Each case below is one a plausible tidy-up would
 * break.
 */

import { describe, it, expect } from 'vitest';
import {
  FLASH_DLIGHT_COLOR,
  MUZZLE_FLASH_LIGHT,
  MUZZLE_FLASH_TIME,
  Weapon,
} from '../../src/game/weapons.js';
import { QUAD_LIGHT, QUAD_LIGHT_COLOR } from '../../src/render/dynamic-lights.js';
import {
  SHADOW_DISTANCE,
  SHADOW_MAXS,
  SHADOW_MINS,
  SHADOW_RADIUS,
} from '../../src/render/shadow.js';

describe('muzzle flash light', () => {
  it('lasts 20ms, which is a strobe rather than a lamp', () => {
    // cg_local.h:55. Barely two physics ticks -- long enough to light the room
    // for an instant. Rounding it up to something "visible" would turn every
    // shot into a lantern.
    expect(MUZZLE_FLASH_TIME).toBe(20);
    expect(MUZZLE_FLASH_LIGHT).toBe(300);
  });

  it('does not give the rocket and grenade launchers the same colour', () => {
    // cg_weapons.c:751 vs :774 -- 0.75 green against 0.70. Quake distinguishes
    // them, and the obvious "these are both orange, share the constant"
    // cleanup would erase that.
    expect(FLASH_DLIGHT_COLOR[Weapon.ROCKET_LAUNCHER]).toEqual([1, 0.75, 0]);
    expect(FLASH_DLIGHT_COLOR[Weapon.GRENADE_LAUNCHER]).toEqual([1, 0.7, 0]);
    expect(FLASH_DLIGHT_COLOR[Weapon.ROCKET_LAUNCHER]).not.toEqual(
      FLASH_DLIGHT_COLOR[Weapon.GRENADE_LAUNCHER],
    );
  });

  it('gives the plasma gun its blue flash', () => {
    // cg_weapons.c:796. This is the plasma gun's ONLY dynamic light in Quake --
    // its projectile has no `missileDlight` at all, which is why a travelling
    // plasma light is an addition and not a port. See .agent/plans/VISUALS.md.
    expect(FLASH_DLIGHT_COLOR[Weapon.PLASMAGUN]).toEqual([0.6, 0.6, 1]);
  });

  it('leaves every fireable weapon with a non-zero colour', () => {
    // `if ( weapon->flashDlightColor[0] || [1] || [2] )` -- an all-zero colour
    // silently means "no light". A weapon that lost its entry would stop
    // flashing rather than flash black, which is much harder to notice.
    for (const w of [Weapon.ROCKET_LAUNCHER, Weapon.GRENADE_LAUNCHER, Weapon.PLASMAGUN]) {
      const c = FLASH_DLIGHT_COLOR[w];
      expect(c[0] + c[1] + c[2]).toBeGreaterThan(0);
    }
    // ...and NONE genuinely has none, so holding nothing throws no light.
    expect(FLASH_DLIGHT_COLOR[Weapon.NONE]).toEqual([0, 0, 0]);
  });
});

describe('the Quad carrier light', () => {
  it('is blue and smaller than a muzzle flash', () => {
    // cg_players.c:1839. It is a steady glow around the player, so it is dimmer
    // than the strobe a shot throws.
    expect(QUAD_LIGHT).toBe(200);
    expect(QUAD_LIGHT_COLOR).toEqual([0.2, 0.2, 1]);
    expect(QUAD_LIGHT).toBeLessThan(MUZZLE_FLASH_LIGHT);
  });
});

describe('blob shadow', () => {
  it('looks 128 units down', () => {
    expect(SHADOW_DISTANCE).toBe(128);
    expect(SHADOW_RADIUS).toBe(24);
  });

  it('traces a flat slab at the feet, not the player hull', () => {
    /*
     * cg_players.c:1993 -- `mins = {-15,-15,0}, maxs = {15,15,2}`.
     *
     * The z extents are the point. The player's own hull is -24 to +32; tracing
     * that downward would catch a ledge beside them and stamp the shadow on the
     * wrong surface. A 2-unit slab at the feet only ever finds the floor they
     * are actually over.
     */
    expect(SHADOW_MINS[2]).toBe(0);
    expect(SHADOW_MAXS[2]).toBe(2);
    expect(SHADOW_MAXS[2] - SHADOW_MINS[2]).toBeLessThan(8);

    // The x/y extents DO match the player's, so the shadow is the right size.
    expect(SHADOW_MINS[0]).toBe(-15);
    expect(SHADOW_MAXS[0]).toBe(15);
  });
});
