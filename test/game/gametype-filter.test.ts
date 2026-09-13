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
import { mapGametype } from '../../src/game/flag-run.js';

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

describe('the CTF branch', () => {
  /*
   * Added 2026-09-13, from a real report. q3ctf1's flags are marked
   * `notfree` -- correctly, since a free-for-all has no flags -- and
   * Overbounce filtered every map as free-for-all, so the flags were dropped
   * before `ItemWorld` ever saw them:
   *
   *     [overbounce] q3ctf1: 2 CTF flag entities in the map were removed by
   *     the free-for-all gametype filter
   *
   * The course card said CTF, the map loaded, and there was no flag anywhere
   * to pick up. The answer is not an exemption for one classname: a map being
   * played as a flag run is not being played free-for-all, and id's filter
   * already says what that means -- GT_CTF is above GT_TEAM, so it is the
   * `notteam` branch that applies.
   */
  it('keeps the flags a free-for-all would drop', () => {
    const dicts = [
      { classname: 'team_CTF_redflag', origin: '0 0 40', notfree: '1' },
      { classname: 'team_CTF_blueflag', origin: '400 0 40', notfree: '1' },
    ];
    expect(buildEntities(dicts, 'ffa')).toHaveLength(0);
    expect(buildEntities(dicts, 'ctf').map((e) => e.classname)).toEqual([
      'team_CTF_redflag',
      'team_CTF_blueflag',
    ]);
  });

  it('takes the notteam branch, which is the mirror of free-for-all', () => {
    const dicts = [
      { classname: 'item_armor_combat', origin: '-1472 448 528', notfree: '1' },
      { classname: 'item_armor_body', origin: '-1472 448 528', notteam: '1' },
    ];
    // The whole map swaps, not just the flags: a CTF map's armour and weapon
    // placements are the layout the route runs through.
    expect(buildEntities(dicts, 'ffa').map((e) => e.classname)).toEqual(['item_armor_body']);
    expect(buildEntities(dicts, 'ctf').map((e) => e.classname)).toEqual(['item_armor_combat']);
  });

  it('matches the gametype key by name in both directions', () => {
    const dicts = [
      { classname: 'item_quad', origin: '0 0 0', gametype: 'ffa tournament' },
      { classname: 'item_haste', origin: '0 0 0', gametype: 'team ctf' },
      { classname: 'item_regen', origin: '0 0 0', gametype: 'ffa team ctf' },
    ];
    expect(buildEntities(dicts, 'ffa').map((e) => e.classname)).toEqual(['item_quad', 'item_regen']);
    expect(buildEntities(dicts, 'ctf').map((e) => e.classname)).toEqual(['item_haste', 'item_regen']);
  });

  it('still drops notq3a in either gametype', () => {
    // Team Arena content. This is baseline Quake III whichever mode a map
    // spawns for.
    const dicts = [{ classname: 'item_scout', origin: '0 0 0', notq3a: '1' }];
    expect(buildEntities(dicts, 'ffa')).toHaveLength(0);
    expect(buildEntities(dicts, 'ctf')).toHaveLength(0);
  });

  it('defaults to free-for-all, which is what every other map gets', () => {
    const dicts = [{ classname: 'item_armor_body', origin: '0 0 0', notteam: '1' }];
    expect(buildEntities(dicts)).toEqual(buildEntities(dicts, 'ffa'));
  });
});

describe('mapGametype', () => {
  it('calls a map with both flags and no start gate CTF', () => {
    expect(mapGametype(['team_CTF_redflag', 'team_CTF_blueflag'])).toBe('ctf');
  });

  it('is asked of the RAW lump, which is the entire point', () => {
    // The bug, as one assertion. Filter first and the flags are gone, so the
    // question answers "not CTF" and the map is filtered as free-for-all --
    // which is what removed them. The order cannot be the other way round.
    const dicts = [
      { classname: 'team_CTF_redflag', origin: '0 0 40', notfree: '1' },
      { classname: 'team_CTF_blueflag', origin: '400 0 40', notfree: '1' },
    ];
    const raw = mapGametype(dicts.map((d) => d.classname));
    expect(raw).toBe('ctf');
    expect(buildEntities(dicts, raw)).toHaveLength(2);

    const filteredFirst = buildEntities(dicts, 'ffa');
    expect(mapGametype(filteredFirst.map((e) => e.classname))).toBe('ffa');
  });

  it('leaves a defrag course alone even when it hangs flags on the walls', () => {
    expect(
      mapGametype(['target_startTimer', 'team_CTF_redflag', 'team_CTF_blueflag']),
    ).toBe('ffa');
  });

  it('needs both flags', () => {
    expect(mapGametype(['team_CTF_redflag'])).toBe('ffa');
    expect(mapGametype(['team_CTF_neutralflag'])).toBe('ffa');
    expect(mapGametype([])).toBe('ffa');
  });
});
