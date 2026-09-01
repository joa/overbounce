/**
 * A Quake 3 virtual file system over .pk3 archives.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Overbounce ships no game assets. Instead the player points it at their own
 * .pk3 files — their Quake III install, an OpenArena download, a defrag map —
 * and this resolves paths across them the way Quake 3's own file system does.
 *
 * That is a licensing decision as much as a design one: id's pak0.pk3 is not
 * redistributable, so the only lawful way to play with the original maps,
 * models and sounds is for the assets to come from the player's own copy.
 */

import type { ZipArchive, ZipEntry } from './zip.js';
import { openZip, readZipEntry } from './zip.js';

export interface MountedPak {
  /** File name, e.g. "pak0.pk3". */
  name: string;
  archive: ZipArchive;
  /**
   * Which set of game data this came from. Higher wins outright, whatever the
   * filenames are.
   *
   * This exists because OpenArena is a Quake III clone: it uses the SAME asset
   * paths, and it also ships a `pak0.pk3`. Ranking by filename alone -- which
   * is what Quake does, and correct within one game directory -- makes the
   * winner between two games an accident of alphabetical order. A group makes
   * "retail if present, OpenArena to fill the gaps" a decision rather than a
   * coincidence.
   */
  group: number;
  /** Higher wins when the same path exists in several paks. */
  priority: number;
}

/** Asset sources, lowest priority first. */
export const enum PakGroup {
  /** OpenArena, or anything else standing in for missing retail content. */
  Fallback = 0,
  /** Retail Quake III. */
  Base = 1,
  /** A map pack or mod the player loaded on purpose; beats everything. */
  Addon = 2,
}

/**
 * Quake 3 normalises every lookup: lowercase, forward slashes, no leading
 * slash. Shader and model references in map files are inconsistent about all
 * three, so this has to be applied on both sides of the lookup.
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

export class Pk3FileSystem {
  private readonly paks: MountedPak[] = [];
  /** Resolved path -> the pak that wins for it. */
  private index = new Map<string, { pak: MountedPak; entry: ZipEntry }>();

  /**
   * Add an archive.
   *
   * Within a group, precedence follows Quake 3: pak files are searched in
   * DESCENDING name order, so pak8.pk3 overrides pak0.pk3. Mount order does
   * not matter; the name does.
   *
   * ACROSS groups the group wins first, so a retail pak0.pk3 always beats an
   * OpenArena pak0.pk3 no matter what they are called. Without that, "use the
   * original asset and fall back to OpenArena" is not expressible at all --
   * both games use the same paths and the same filenames.
   */
  async mount(
    name: string,
    blob: Blob,
    group: PakGroup = PakGroup.Base,
  ): Promise<MountedPak> {
    const archive = await openZip(blob);
    const pak: MountedPak = { name, archive, group, priority: 0 };
    this.paks.push(pak);
    this.reindex();
    return pak;
  }

  private reindex(): void {
    // Group first, then name. Later in this order wins.
    this.paks.sort((a, b) =>
      a.group !== b.group
        ? a.group - b.group
        : a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : 0,
    );
    this.paks.forEach((p, i) => {
      p.priority = i;
    });

    this.index = new Map();
    for (const pak of this.paks) {
      for (const [key, entry] of pak.archive.entries) {
        // Later in the sorted order wins, so overwrite unconditionally.
        this.index.set(key, { pak, entry });
      }
    }
  }

  get mounted(): readonly MountedPak[] {
    return this.paks;
  }

  get fileCount(): number {
    return this.index.size;
  }

  has(path: string): boolean {
    return this.index.has(normalizePath(path));
  }

  /** Which pak a path resolves to, for diagnostics. */
  sourceOf(path: string): string | null {
    return this.index.get(normalizePath(path))?.pak.name ?? null;
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const hit = this.index.get(normalizePath(path));
    if (!hit) {
      return null;
    }
    return readZipEntry(hit.pak.archive, hit.entry);
  }

  async readText(path: string): Promise<string | null> {
    const data = await this.readFile(path);
    return data ? new TextDecoder().decode(data) : null;
  }

  /** Every path, optionally filtered by prefix and/or extension. */
  list(options: { prefix?: string; ext?: string } = {}): string[] {
    const prefix = options.prefix ? normalizePath(options.prefix) : '';
    const ext = options.ext ? options.ext.toLowerCase() : '';

    const out: string[] = [];
    for (const key of this.index.keys()) {
      if (prefix && !key.startsWith(prefix)) {
        continue;
      }
      if (ext && !key.endsWith(ext)) {
        continue;
      }
      out.push(key);
    }
    return out.sort();
  }

  /**
   * Where a path's winning file came from, as a precedence number: higher
   * beats lower, and it is the same ranking `reindex` uses (group first, then
   * pak name). -1 for a path nothing has.
   *
   * `list()` sorts alphabetically, which is the right answer for a listing and
   * the WRONG one for anything where two paks define the same thing and only
   * one may win. Shader scripts are exactly that case: OpenArena keeps the
   * ammo box shaders in `scripts/ammo.shader` and retail Quake III keeps them
   * in a file that sorts later, so a first-wins merge over an alphabetical
   * listing hands the fight to the letter A rather than to the archive the
   * player mounted. See `loadAllShaders`.
   */
  priorityOf(path: string): number {
    return this.index.get(normalizePath(path))?.pak.priority ?? -1;
  }

  /** Map names, without the `maps/` prefix or `.bsp` suffix. */
  listMaps(): string[] {
    return this.list({ prefix: 'maps/', ext: '.bsp' }).map((p) =>
      p.slice('maps/'.length, -'.bsp'.length),
    );
  }

  /**
   * Resolve a texture or shader reference to a real file.
   *
   * Q3 map and model files name textures without an extension, and the real
   * file may be .tga or .jpg — the engine tries each in turn. Reproduced here
   * so model shader paths from an MD3 resolve against a player's own paks.
   */
  findImage(reference: string): string | null {
    const base = normalizePath(reference).replace(/\.(tga|jpg|jpeg|png)$/, '');
    for (const ext of ['.tga', '.jpg', '.jpeg', '.png']) {
      if (this.has(base + ext)) {
        return base + ext;
      }
    }
    return null;
  }
}
