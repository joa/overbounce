/**
 * Fetch everything this project downloads, from one manifest.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run download-assets            # everything in the manifest
 *   npm run download-assets -- --refs  # only the GPL reference sources
 *   npm run download-assets -- --force # re-fetch even if present
 *
 * The point is reproducibility: if an asset is not in
 * `tools/assets.manifest.json`, it cannot be fetched by this script, and a
 * future session cannot recreate the working tree. Anything downloaded ad hoc
 * during development should be added to the manifest rather than left as a
 * one-off curl in someone's shell history.
 *
 * NOTHING HERE TOUCHES RETAIL QUAKE III CONTENT. That is not redistributable
 * and is not downloadable; it comes from the user's own installation through
 * `tools/build-devpak.ts`. See NOTICE.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openAsBlob, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openZip, readZipEntry } from '../src/assets/zip.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Pull files out of a downloaded archive.
 *
 * `from` is either an exact path inside the zip or a `prefix/*.ext` glob;
 * `to` is a destination file (exact) or directory (glob). `flatten` drops the
 * archive's directory structure, which is what a flat fixture directory wants.
 */
interface Extract {
  from: string;
  to: string;
  flatten?: boolean;
  /** Cap on how many files a glob may extract, so a typo cannot unpack 40MB. */
  limit?: number;
}

interface Download {
  name: string;
  description: string;
  url: string;
  dest: string;
  license: string;
  sha256: string | null;
  optional?: boolean;
  extract?: Extract[];
  /**
   * Set when the source cannot be fetched by a script — a JS bot challenge, a
   * click-through, a login. The script prints instructions instead of pretending
   * it can download it. Documenting provenance is most of a manifest's value
   * even when automation is impossible.
   */
  manual?: string;
}

interface ReferenceSet {
  name: string;
  license: string;
  baseUrl: string;
  files: string[];
}

interface Manifest {
  downloads: Download[];
  references: {
    dest: string;
    sets: ReferenceSet[];
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchTo(url: string, dest: string, force: boolean): Promise<Uint8Array | null> {
  const full = join(root, dest);
  if (existsSync(full) && !force) {
    return new Uint8Array(readFileSync(full));
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());

  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
  return bytes;
}

/**
 * Unpack the files an entry asks for out of the downloaded archive.
 *
 * Reuses `src/assets/zip.ts` -- the same reader the game uses for .pk3 files at
 * runtime, since a .pk3 IS a zip. Node has no built-in zip reader, and using
 * ours means the tool exercises the same code path the browser does.
 */
async function extractFrom(archivePath: string, rules: readonly Extract[]): Promise<void> {
  const blob = await openAsBlob(join(root, archivePath));
  const zip = await openZip(blob);

  for (const rule of rules) {
    const star = rule.from.indexOf('*');

    if (star === -1) {
      const entry = zip.entries.get(rule.from.toLowerCase());
      if (!entry) {
        console.log(`  MISS  ${rule.from} is not in the archive`);
        continue;
      }
      const bytes = await readZipEntry(zip, entry);
      const target = join(root, rule.to);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      console.log(`  ->    ${rule.to}`);
      continue;
    }

    // `prefix/*.ext`
    const prefix = rule.from.slice(0, star).toLowerCase();
    const suffix = rule.from.slice(star + 1).toLowerCase();
    const limit = rule.limit ?? 64;

    let count = 0;
    for (const [name, entry] of zip.entries) {
      if (count >= limit) {
        break;
      }
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
        continue;
      }
      const rest = rule.flatten
        ? // Flattened names must stay unique: models/players/sarge/head.md3
          // and .../sorceress/head.md3 would otherwise collide.
          name.slice(prefix.length).replace(/\//g, '_')
        : name.slice(prefix.length);

      const target = join(root, rule.to, rest);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, await readZipEntry(zip, entry));
      count++;
    }
    console.log(`  ->    ${count} file(s) matching ${rule.from} -> ${rule.to}`);
  }
}

async function downloadReferences(manifest: Manifest, force: boolean): Promise<void> {
  const { dest, sets } = manifest.references;
  let ok = 0;
  let failed = 0;

  for (const set of sets) {
    console.log(`\n${set.name}  (${set.license})`);
    for (const file of set.files) {
      const target = `${dest}/${set.name}/${file}`;
      try {
        const bytes = await fetchTo(`${set.baseUrl}/${file}`, target, force);
        console.log(`  ok    ${file}  ${bytes ? `${(bytes.length / 1024).toFixed(0)}KB` : ''}`);
        ok++;
      } catch (err) {
        // A reference that has moved upstream is worth reporting but must not
        // stop the rest: these are read by humans, not imported by code.
        console.log(`  FAIL  ${file}  ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }
  }
  console.log(`\nreferences: ${ok} fetched, ${failed} failed -> ${dest}/`);
}

async function downloadAssets(manifest: Manifest, force: boolean): Promise<void> {
  for (const item of manifest.downloads) {
    console.log(`\n${item.name}  (${item.license})`);
    console.log(`  ${item.description}`);

    if (item.manual) {
      // Saying "cannot be scripted, here is how" is honest and still useful.
      // Silently skipping would leave the manifest claiming coverage it lacks.
      console.log(`  MANUAL  this source cannot be fetched by a script.`);
      console.log(`          ${item.manual}`);
      console.log(`          url:  ${item.url}`);
      console.log(`          save: ${item.dest}`);
      console.log(
        existsSync(join(root, item.dest))
          ? `  ok      already present at ${item.dest}`
          : `  absent  ${item.dest}`,
      );
      if (existsSync(join(root, item.dest)) && item.extract) {
        await extractFrom(item.dest, item.extract);
      }
      continue;
    }

    try {
      const bytes = await fetchTo(item.url, item.dest, force);
      if (!bytes) {
        continue;
      }
      const hash = sha256(bytes);
      console.log(`  ok    ${item.dest}  ${(bytes.length / 1024 / 1024).toFixed(1)}MB`);

      if (item.sha256 === null) {
        console.log(`  NOTE  sha256 not pinned. Add to the manifest:\n        "sha256": "${hash}"`);
      } else if (item.sha256 !== hash) {
        console.log(`  WARN  sha256 mismatch!\n        expected ${item.sha256}\n        got      ${hash}`);
      }

      if (item.extract) {
        await extractFrom(item.dest, item.extract);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (item.optional) {
        console.log(`  skip  ${message}  (optional)`);
      } else {
        throw err;
      }
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const only = args.includes('--refs') ? 'refs' : args.includes('--assets') ? 'assets' : 'all';

  const manifest = JSON.parse(
    readFileSync(join(root, 'tools/assets.manifest.json'), 'utf8'),
  ) as Manifest;

  if (only === 'all' || only === 'assets') {
    await downloadAssets(manifest, force);
  }
  if (only === 'all' || only === 'refs') {
    await downloadReferences(manifest, force);
  }

  console.log(
    '\nRetail Quake III content is deliberately absent from this manifest.\n' +
      'For a dev pak from your own installation:\n' +
      '  Q3_BASEQ3="<path>/baseq3" npm run build-devpak\n',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
