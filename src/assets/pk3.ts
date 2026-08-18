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
  /** Higher wins when the same path exists in several paks. */
  priority: number;
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
   * Precedence follows Quake 3: pak files are searched in DESCENDING name
   * order, so pak8.pk3 overrides pak0.pk3, and a map pack dropped in later
   * overrides both. Mount order does not matter; the name does.
   */
  async mount(name: string, blob: Blob): Promise<MountedPak> {
    const archive = await openZip(blob);
    const pak: MountedPak = { name, archive, priority: 0 };
    this.paks.push(pak);
    this.reindex();
    return pak;
  }

  private reindex(): void {
    // Descending by name, so higher-numbered paks win.
    this.paks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
