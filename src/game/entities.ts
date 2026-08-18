/**
 * Map entities, as the game layer sees them.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `parseEntities` in cm-load.ts gives raw key/value dictionaries straight out
 * of the BSP. This turns those into a typed model with the conversions Quake's
 * spawn parser applies — the `angle` shorthand, the `*N` brush-model reference,
 * the numeric defaults — and provides the target lookup that triggers fire
 * through.
 *
 * Ports `g_spawn.c`'s field table (the parts that matter here), `G_Find` and
 * `G_PickTarget` from `g_utils.c`.
 */

import type { EntityDict } from '../collision/cm-load.js';
import { parseOrigin } from '../collision/cm-load.js';

export interface MapEntity {
  classname: string;
  targetname: string | null;
  /** The `targetname` this entity fires when used. */
  target: string | null;
  origin: [number, number, number];
  /** Quake angle order: pitch, yaw, roll. */
  angles: [number, number, number];
  /**
   * Index into `CollisionModel.submodels` for a brush entity (`"model": "*3"`),
   * or -1 for a point entity. Triggers are always brush entities.
   */
  submodel: number;
  spawnflags: number;
  /** Every key as it appeared, for anything this interface does not name. */
  raw: EntityDict;
}

/** A `wait`/`random`/`speed` style numeric key, with the caller's default. */
export function entityFloat(entity: MapEntity, key: string, fallback: number): number {
  const raw = entity.raw[key];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseFloat(raw);
  return Number.isNaN(value) ? fallback : value;
}

/** A `"*N"` brush-model reference, or -1. */
function parseSubmodel(value: string | undefined): number {
  if (!value || value[0] !== '*') {
    return -1;
  }
  const index = Number.parseInt(value.slice(1), 10);
  return Number.isNaN(index) ? -1 : index;
}

function parseAngles(dict: EntityDict): [number, number, number] {
  const angles = dict['angles'];
  if (angles) {
    const v = parseOrigin(angles);
    if (v) {
      return v;
    }
  }
  // F_ANGLEHACK: a bare `angle` is a yaw, and clears pitch and roll.
  const angle = dict['angle'];
  if (angle !== undefined) {
    const yaw = Number.parseFloat(angle);
    if (!Number.isNaN(yaw)) {
      return [0, yaw, 0];
    }
  }
  return [0, 0, 0];
}

/**
 * `G_SpawnGEntityFromSpawnVars`' gametype filter.
 *
 * A Quake map stores EVERY gametype's entities in one BSP and throws away the
 * ones the current gametype does not want. Skip this and a map spawns the union
 * of all of them, stacked on top of each other.
 *
 * q3dm6 is the clearest case: the red and yellow armour swap places between
 * free-for-all and team play, so each of the two armour spots holds two
 * entities --
 *
 *     { "origin" "-1472 448 528"  "notfree" "1"  "classname" "item_armor_combat" }
 *     { "origin" "-1472 448 528"  "notteam" "1"  "classname" "item_armor_body"   }
 *
 * -- and without the filter you get a red armour and a yellow armour occupying
 * the same square foot of floor, at both spots. The same pattern is scattered
 * through most id maps.
 *
 * Overbounce is free-for-all: there are no teams and there is no single-player
 * campaign, so `notfree` removes and `notteam` / `notsingle` keep. `notq3a`
 * removes unconditionally -- it marks Team Arena content, and this is baseline
 * Quake III.
 */
function wantedInFreeForAll(dict: EntityDict): boolean {
  // `if ( g_gametype.integer >= GT_TEAM ) { notteam } else { notfree }`.
  // GT_FFA is below GT_TEAM, so it is the `notfree` branch that applies.
  if (truthy(dict['notfree'])) {
    return false;
  }
  if (truthy(dict['notq3a'])) {
    return false;
  }

  // `if ( G_SpawnString( "gametype", ... ) )` -- a substring match against the
  // gametype's name, so "ffa team ctf" keeps the entity and "team ctf" drops it.
  const gametype = dict['gametype'];
  if (gametype !== undefined && !gametype.includes('ffa')) {
    return false;
  }

  return true;
}

/** `G_SpawnInt(key, "0", &i); if (i)` -- any non-zero integer. */
function truthy(value: string | undefined): boolean {
  const n = Number.parseInt(value ?? '0', 10);
  return !Number.isNaN(n) && n !== 0;
}

export function buildEntities(dicts: readonly EntityDict[]): MapEntity[] {
  const entities: MapEntity[] = [];

  for (const dict of dicts) {
    const classname = dict['classname'];
    if (!classname) {
      continue;
    }
    if (!wantedInFreeForAll(dict)) {
      continue;
    }

    const spawnflags = Number.parseInt(dict['spawnflags'] ?? '0', 10);

    entities.push({
      classname,
      targetname: dict['targetname'] ?? null,
      target: dict['target'] ?? null,
      origin: (dict['origin'] ? parseOrigin(dict['origin']) : null) ?? [0, 0, 0],
      angles: parseAngles(dict),
      submodel: parseSubmodel(dict['model']),
      spawnflags: Number.isNaN(spawnflags) ? 0 : spawnflags,
      raw: dict,
    });
  }

  return entities;
}

/** `G_Find(from, FOFS(targetname), match)` — every entity with this targetname. */
export function findByTargetname(
  entities: readonly MapEntity[],
  targetname: string,
): MapEntity[] {
  // Quake compares with Q_stricmp, so the match is case insensitive.
  const wanted = targetname.toLowerCase();
  return entities.filter((e) => e.targetname !== null && e.targetname.toLowerCase() === wanted);
}

/**
 * `G_PickTarget` — one entity with the given targetname, chosen at random when
 * several share it.
 *
 * The randomness is real Quake behaviour and is what makes a teleporter with
 * several destinations scatter players, so it is kept rather than tidied into
 * "pick the first". `rng` is injectable so tests can pin it.
 */
export function pickTarget(
  entities: readonly MapEntity[],
  targetname: string | null,
  rng: () => number = Math.random,
): MapEntity | null {
  if (!targetname) {
    return null;
  }
  // MAXCHOICES is 32 in Q3; beyond that the list is truncated.
  const choices = findByTargetname(entities, targetname).slice(0, 32);
  if (!choices.length) {
    return null;
  }
  return choices[Math.floor(rng() * choices.length)];
}

/** The classnames Quake accepts as a player start. */
const SPAWN_CLASSNAMES = [
  'info_player_deathmatch',
  'info_player_start',
  'team_CTF_redplayer',
  'team_CTF_blueplayer',
  'team_CTF_redspawn',
  'team_CTF_bluespawn',
];

export interface SpawnPoint {
  origin: [number, number, number];
  yaw: number;
}

/** The first usable spawn point, preferring deathmatch starts as Quake does. */
export function findSpawn(entities: readonly MapEntity[]): SpawnPoint | null {
  for (const classname of SPAWN_CLASSNAMES) {
    const entity = entities.find((e) => e.classname === classname);
    if (entity) {
      return { origin: [...entity.origin], yaw: entity.angles[1] };
    }
  }
  return null;
}
