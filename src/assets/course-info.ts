/**
 * `.arena` and `.defi` files: the metadata a map carries about itself.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Course select (`.agent/plans/UI.md` R4a) needs to show a physics mode and a
 * long name for every mounted map before any of them has been played, and
 * neither is invented here: both file formats are real, community-documented
 * Quake III / DeFRaG conventions, `scripts/<mapname>.arena` and
 * `scripts/<mapname>.defi` inside the map's own `.pk3`, read through
 * `Pk3FileSystem` exactly like a shader or a texture.
 *
 * `.arena` is the format Quake III itself uses for its ffa/tourney/team/ctf
 * menu -- see `template.arena` at https://ws.q3df.org/editing/files/ -- and
 * says nothing about physics. `.defi` is DeFRaG's own equivalent
 * (`template.defi`, same source), and is the ONLY of the two that declares
 * `cpm`/`vq3` -- which is why a map is checked for a `.defi` first and an
 * `.arena` only as a fallback for author/longname on a non-defrag map.
 *
 * Neither format declares a CAMERA (side/chase). There is no community
 * convention for that at all, so it is not invented here either -- see
 * `.agent/plans/UI.md` R4a. A bundled map's camera comes from this project's
 * own table instead (`main.ts`'s `BUNDLED_MAPS`-adjacent metadata), and a
 * player-supplied map has no declared camera until one exists.
 *
 * Grammar is the same `{ "key" "value" ... }` block `parseEntities` reads out
 * of a BSP's entity lump, plus `//` line comments -- entity lumps never carry
 * comments (they are compiler output), but a hand-written `.defi`/`.arena`
 * routinely does, including inside the block itself. Reusing `parseEntities`
 * directly would misparse a comment that happens to contain a quoted pair
 * (the `template.defi` example above has several, as illustrative text), so
 * this strips comments first the same way `shader.ts`'s tokenizer does.
 */

import type { Pk3FileSystem } from './pk3.js';

/** Every top-level `{ ... }` block in the file, each a `key -> value` dict, keys lowercased. */
function parseInfoBlocks(text: string): Record<string, string>[] {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.split('//')[0])
    .join('\n');

  // Depth-tracked, like `parseEntities` in cm-load.ts -- but that parser can't
  // be reused directly: it assumes both key and value are quoted (true of a
  // compiled entity lump, never true of a hand-written .arena/.defi, where
  // only the value is), and it has no comment handling at all, which a
  // hand-written file needs and a compiler-emitted one never does.
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') {
      if (depth === 0) {
        start = i + 1;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        blocks.push(stripped.slice(start, i));
        start = -1;
      }
    }
  }

  const pairRe = /"?([A-Za-z_][A-Za-z0-9_]*)"?\s+"((?:[^"\\]|\\.)*)"/g;
  return blocks.map((block) => {
    const out: Record<string, string> = {};
    pairRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(block)) !== null) {
      out[m[1].toLowerCase()] = m[2];
    }
    return out;
  });
}

/**
 * The block for one map, from a file that may hold more than one.
 *
 * `scripts/<mapname>.arena`/`.defi` is conventionally one block per file, but
 * an aggregate file (a mod's `scripts/arenas.txt`-style listing) and a
 * hand-edited file with a leftover second block both exist in the wild.
 * Matching on `map` rather than blindly taking the first block is what makes
 * both safe: the common case (one block, whatever its `map` says) still
 * works, and a multi-block file returns the right one instead of whichever
 * happened to parse last.
 */
function selectBlock(blocks: Record<string, string>[], mapName: string): Record<string, string> | null {
  const wanted = mapName.toLowerCase();
  const exact = blocks.find((b) => b.map?.toLowerCase() === wanted);
  return exact ?? blocks[0] ?? null;
}

export interface ArenaInfo {
  map: string;
  longname: string | null;
  author: string | null;
  /** Space-separated: some of `ffa`, `tourney`, `team`, `ctf`. */
  type: string | null;
}

/**
 * `scripts/<mapname>.arena`. Quake III's own menu metadata; says nothing about physics.
 *
 * `mapName`, when given, picks the matching block out of a file that holds
 * more than one -- see `selectBlock`. Omit it to take the file's first block,
 * which is right for the overwhelmingly common one-block-per-file case.
 */
export function parseArenaFile(text: string, mapName = ''): ArenaInfo | null {
  const fields = selectBlock(parseInfoBlocks(text), mapName);
  if (!fields?.map) {
    return null;
  }
  return {
    map: fields.map,
    longname: fields.longname ?? null,
    author: fields.author ?? null,
    type: fields.type ?? null,
  };
}

export type DeclaredPhysics = 'vq3' | 'cpm' | 'both';

export interface DefiInfo {
  map: string;
  longname: string | null;
  author: string | null;
  /** DeFRaG's own category: training/run/accuracy/level, as the map author wrote it -- not a closed enum. */
  style: string | null;
  physics: DeclaredPhysics | null;
}

/** `1`/`yes`/`true` all appear in the wild; DeFRaG's own template only shows `0`/`1`. */
function truthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'yes' || v === 'true';
}

/**
 * `scripts/<mapname>.defi`. DeFRaG's map menu metadata -- the only format that declares
 * physics. `mapName` disambiguates a multi-block file; see `parseArenaFile`.
 */
export function parseDefiFile(text: string, mapName = ''): DefiInfo | null {
  const fields = selectBlock(parseInfoBlocks(text), mapName);
  if (!fields?.map) {
    return null;
  }
  const cpm = truthy(fields.cpm);
  const vq3 = truthy(fields.vq3);
  return {
    map: fields.map,
    longname: fields.longname ?? null,
    author: fields.author ?? null,
    style: fields.style ?? null,
    physics: cpm && vq3 ? 'both' : cpm ? 'cpm' : vq3 ? 'vq3' : null,
  };
}

export interface CourseMetadata {
  longname: string | null;
  author: string | null;
  /** From a `.defi`'s `cpm`/`vq3` flags. Null when undeclared -- most `.arena`-only maps, or a map with neither file. */
  physics: DeclaredPhysics | null;
  /** DeFRaG's own category. Null for a non-defrag map. */
  style: string | null;
}

/*
 * `.arena`'s `type` field (ffa/tourney/team/ctf) is deathmatch-MODE metadata
 * for Quake III's own menu, not timer presence -- it is parsed by
 * `parseArenaFile` and deliberately does not appear on `CourseMetadata`.
 * Whether a course can be timed comes from the entity lump (a
 * `target_startTimer` in the map itself, the same check `main.ts`'s `timed`
 * already makes), not from anything in `scripts/`. Course select's TIMED
 * badge reads that scan, not this module.
 */

const EMPTY_METADATA: CourseMetadata = { longname: null, author: null, physics: null, style: null };

/**
 * `.defi` first, `.arena` as a fallback for longname/author on a map that
 * isn't a defrag map at all. Neither present is not an error -- most of a
 * player's own `.pk3` files (a plain deathmatch map, most retail maps) carry
 * neither, and course select falls back to the map's bare filename and
 * `AUTO` physics, exactly as it does today.
 */
export async function loadCourseMetadata(
  fs: Pk3FileSystem,
  mapName: string,
): Promise<CourseMetadata> {
  const defiText = await fs.readText(`scripts/${mapName}.defi`);
  if (defiText) {
    const defi = parseDefiFile(defiText, mapName);
    if (defi) {
      return { longname: defi.longname, author: defi.author, physics: defi.physics, style: defi.style };
    }
  }

  const arenaText = await fs.readText(`scripts/${mapName}.arena`);
  if (arenaText) {
    const arena = parseArenaFile(arenaText, mapName);
    if (arena) {
      return { longname: arena.longname, author: arena.author, physics: null, style: null };
    }
  }

  return EMPTY_METADATA;
}
