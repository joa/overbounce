/**
 * The warm-up frame's visibility juggling must be exactly reversible.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `showEverythingForWarmup` flips flags on the LIVE scene graph so one frame
 * behind the loading screen compiles every pooled visual's pipeline. Getting
 * the restore wrong is silent and semantic, not visual noise: a grenade clone
 * left visible inside a rocket-showing holder draws both models on every
 * rocket, and an FPV-hidden player model left visible puts the player's own
 * body in their face. So the contract under test is exactness — every flag
 * returns to the value it had, not to a guessed default.
 *
 * The light exemption is the other load-bearing half: three hashes a light's
 * `visible` into the material light configuration, so flipping it forces the
 * very recompiles the warm-up exists to avoid (`scene-lights.ts` parks lights
 * at intensity 0 for the same reason).
 *
 * Runs headless: `Object3D` needs no GPU and no DOM.
 */

import { describe, expect, it } from 'vitest';
import { Group, Mesh, PointLight, Sprite } from 'three/webgpu';
import { showEverythingForWarmup } from '../../src/render/prewarm.js';

describe('showEverythingForWarmup', () => {
  it('shows hidden objects, un-culls everything, and restores both exactly', () => {
    const root = new Group();

    // A missile-holder shape: hidden holder, visible rocket, hidden grenade.
    const holder = new Group();
    holder.visible = false;
    const rocket = new Mesh();
    const grenade = new Mesh();
    grenade.visible = false;
    holder.add(rocket, grenade);

    // A pooled sprite that opts out of culling on its own (like the decals).
    const decal = new Mesh();
    decal.visible = false;
    decal.frustumCulled = false;

    const plasma = new Sprite();
    plasma.visible = false;

    root.add(holder, decal, plasma);

    const restore = showEverythingForWarmup(root);

    // Everything renderable is drawable for the warm frame...
    for (const o of [holder, rocket, grenade, decal, plasma]) {
      expect(o.visible).toBe(true);
      expect(o.frustumCulled).toBe(false);
    }

    restore();

    // ...and afterwards every flag is what its owner left it, per object.
    expect(holder.visible).toBe(false);
    expect(rocket.visible).toBe(true);
    expect(grenade.visible).toBe(false);
    expect(decal.visible).toBe(false);
    expect(plasma.visible).toBe(false);
    expect(rocket.frustumCulled).toBe(true);
    // The decal chose `frustumCulled = false` for itself; restoring it to
    // true would re-cull geometry whose matrix is identity on purpose.
    expect(decal.frustumCulled).toBe(false);
  });

  it('never touches a light', () => {
    const root = new Group();
    const light = new PointLight(0xffffff, 0);
    light.visible = false; // not how the pools park lights, but the hard case
    root.add(light);

    const restore = showEverythingForWarmup(root);
    expect(light.visible).toBe(false);
    expect(light.frustumCulled).toBe(true);
    restore();
    expect(light.visible).toBe(false);
  });

  it('reaches children of hidden parents', () => {
    // `traverse` (unlike `traverseVisible`) descends into hidden subtrees --
    // which is the whole point: the pools are hidden groups of hidden meshes.
    const root = new Group();
    const pool = new Group();
    pool.visible = false;
    const particle = new Mesh();
    particle.visible = false;
    pool.add(particle);
    root.add(pool);

    const restore = showEverythingForWarmup(root);
    expect(particle.visible).toBe(true);
    restore();
    expect(particle.visible).toBe(false);
    expect(pool.visible).toBe(false);
  });
});
