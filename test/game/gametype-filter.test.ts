/**
 * `G_SpawnGEntityFromSpawnVars`' gametype filter.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A Quake map stores every gametype's entities in one BSP and drops the ones
 * the current gametype does not want. Skip the filter and a map spawns the
 * UNION of all of them, stacked in the same place.
 *
 * q3dm6 makes it obvious: the red and yellow armour swap spots between
 * free-for-all and team play, so each armour position holds two entities and
 * without the filter both render, interpenetrating. The user reported it as
 * "red and yellow armor render in both places", and it is scattered through
 * most id maps.
 */

import { describe, it, expect } from 'vitest';
import { buildEntities } from '../../src/game/entities.js';

describe('free-for-all entity filter', () => {
  it('drops notfree and keeps notteam', () => {
    // Verbatim from q3dm6. GT_FFA is below GT_TEAM, so the C takes the
    // `notfree` branch -- keeping the entity marked "not for team play".
    const entities = buildEntities([
      { classname: 'item_armor_combat', origin: '-1472 448 528', notfree: '1' },
      { classname: 'item_armor_body', origin: '-1472 448 528', notteam: '1' },
    ]);
    expect(entities.map((e) => e.classname)).toEqual(['item_armor_body']);
  });

  it('leaves the two q3dm6 armour spots holding one item each', () => {
    const entities = buildEntities([
      { classname: 'item_armor_combat', origin: '-1472 448 528', notfree: '1' },
      { classname: 'item_armor_body', origin: '256 -1344 208', notfree: '1' },
      { classname: 'item_armor_combat', origin: '256 -1344 208', notteam: '1' },
      { classname: 'item_armor_body', origin: '-1472 448 528', notteam: '1' },
    ]);
    expect(entities).toHaveLength(2);
    // Red at one spot, yellow at the other -- the real FFA layout.
    const at = (x: number): string =>
      entities.find((e) => e.origin[0] === x)!.classname;
    expect(at(-1472)).toBe('item_armor_body');
    expect(at(256)).toBe('item_armor_combat');
  });

  it('keeps notsingle, which only applies to the campaign', () => {
    expect(
      buildEntities([{ classname: 'item_quad', notsingle: '1' }]),
    ).toHaveLength(1);
  });

  it('drops notq3a, which marks Team Arena content', () => {
    expect(buildEntities([{ classname: 'item_quad', notq3a: '1' }])).toHaveLength(0);
  });

  it('treats the flag as an integer, not a string', () => {
    // `G_SpawnInt(key, "0", &i); if (i)` -- any non-zero value, and "0" keeps.
    expect(buildEntities([{ classname: 'a', notfree: '0' }])).toHaveLength(1);
    expect(buildEntities([{ classname: 'a', notfree: '2' }])).toHaveLength(0);
    expect(buildEntities([{ classname: 'a' }])).toHaveLength(1);
  });

  it('matches the gametype key as a substring', () => {
    // `strstr( value, gametypeName )` -- "ffa team ctf" keeps, "team ctf" drops.
    expect(buildEntities([{ classname: 'a', gametype: 'ffa team ctf' }])).toHaveLength(1);
    expect(buildEntities([{ classname: 'a', gametype: 'team ctf' }])).toHaveLength(0);
    expect(buildEntities([{ classname: 'a', gametype: 'ffa' }])).toHaveLength(1);
  });
});
