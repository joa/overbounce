/**
 * Which items get their `models[1]` shell drawn.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `bg_itemlist` gives several items a second model -- the transparent sphere or
 * ring around the pickup -- but `CG_Item` (cg_ents.c:374) only ever draws it
 * for health and powerups:
 *
 *     if ( item->giType == IT_HEALTH || item->giType == IT_POWERUP )
 *     {
 *         if ( ( ent.hModel = cg_items[es->modelindex].models[1] ) != 0 )
 *
 * Armour carries one and Quake never draws it. Drawing it anyway puts a ball
 * around every armour shard -- and `shard_sphere` has no shader at all, so it
 * resolves to a JPEG, which has no alpha to rescue it. The result is an opaque
 * blob where a crystal should be.
 */

import { describe, it, expect } from 'vitest';
import { hasShell } from '../../src/render/item-mesh.js';
import { ITEMS, ItemType, findItem } from '../../src/game/items.js';

describe('the accompanying sphere', () => {
  it('is drawn for health and powerups only', () => {
    expect(hasShell(ItemType.HEALTH)).toBe(true);
    expect(hasShell(ItemType.POWERUP)).toBe(true);

    expect(hasShell(ItemType.ARMOR)).toBe(false);
    expect(hasShell(ItemType.WEAPON)).toBe(false);
    expect(hasShell(ItemType.AMMO)).toBe(false);
    expect(hasShell(ItemType.HOLDABLE)).toBe(false);
  });

  it('matters because armour really does carry a second model', () => {
    // If the table had no second model for armour the rule would be moot, and
    // this test would be passing for the wrong reason.
    const shard = findItem('item_armor_shard')!;
    expect(shard.models).toHaveLength(2);
    expect(shard.models[1]).toBe('models/powerups/armor/shard_sphere.md3');
    expect(hasShell(shard.type)).toBe(false);
  });

  it('leaves at least one health and one powerup shell to draw', () => {
    const withShell = ITEMS.filter((i) => i.models.length > 1 && hasShell(i.type));
    expect(withShell.some((i) => i.type === ItemType.HEALTH)).toBe(true);
    expect(withShell.some((i) => i.type === ItemType.POWERUP)).toBe(true);
  });
});
