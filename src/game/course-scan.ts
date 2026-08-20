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

export interface CourseSummary {
  /** Whether `target_startTimer` is present -- R3's own FREERUN test. */
  timed: boolean;
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

  return {
    timed: entities.some((e) => e.classname === 'target_startTimer'),
    checkpoints: entities.filter((e) => e.classname === 'target_checkpoint').length,
  };
}
