/**
 * Cheap per-map course facts, for course select's card row.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `1g` shows checkpoint count and whether a map can be timed at all, for
 * every mounted map, before any of them has been played. `Course` already
 * derives both from the entity lump during an actual run -- this is the same
 * classnames, read once per map at select time via `readEntityLump`, which
 * decodes only the entity lump rather than the whole `BspFile` `parseBsp`
 * builds (planes, nodes, brushes, patches -- none of it needed here). See
 * `.agent/plans/UI.md` R4a.
 */

import { readEntityLump } from '../collision/bsp.js';
import { parseEntities } from '../collision/cm-load.js';
import type { Pk3FileSystem } from '../assets/pk3.js';
import { buildEntities } from './entities.js';
import { isFlagRunMap, mapGametype } from './flag-run.js';

export interface CourseSummary {
  /**
   * Whether the map can be timed at all: `target_startTimer` is present, or
   * it is a CTF map whose two flags are the gates. Must agree with
   * `course-world.ts`'s own test, which is why both read `isFlagRunMap`.
   */
  timed: boolean;
  /** Timed by its FLAGS rather than by a start gate -- see `flag-run.ts`. */
  flagRun: boolean;
  /** Count of `target_checkpoint` entities. */
  checkpoints: number;
}

/** `null` when the map's `.bsp` is missing or not a readable BSP -- course select skips it, not a card that errors. */
export async function scanCourseSummary(
  fs: Pk3FileSystem,
  mapName: string,
): Promise<CourseSummary | null> {
  const data = await fs.readFile(`maps/${mapName}.bsp`);
  if (!data) {
    return null;
  }

  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

  let entities: ReturnType<typeof parseEntities>;
  try {
    entities = parseEntities(readEntityLump(buffer));
  } catch {
    return null;
  }

  /*
   * The same two steps `course-world.ts` takes, in the same order and through
   * the same two functions: decide the gametype from the raw lump, then read
   * what survives filtering FOR that gametype.
   *
   * Both halves matter. Deciding from the raw lump is what stops a CTF map
   * being filtered as free-for-all and losing the flags it is named for;
   * reading the filtered list afterwards is what stops the card promising a
   * mode the map will not have. A badge that sends a player looking for a flag
   * that was never spawned is worse than no badge.
   */
  const gametype = mapGametype(entities.map((e) => e['classname']));
  const spawned = buildEntities(entities, gametype);
  const hasStartTimer = spawned.some((e) => e.classname === 'target_startTimer');
  const flagRun = gametype === 'ctf' && isFlagRunMap(spawned.map((e) => e.classname));
  return {
    timed: hasStartTimer || flagRun,
    flagRun,
    checkpoints: spawned.filter((e) => e.classname === 'target_checkpoint').length,
  };
}
