/**
 * Every URL parameter the game reads, enumerated from the source.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run url-params           # the list
 *   npm run url-params -- --doc  # diff it against docs/url-parameters.md
 *
 * `docs/url-parameters.md` opens by claiming its list was produced mechanically
 * rather than from memory. This is the mechanism, and `--doc` is what makes the
 * claim checkable instead of merely stated -- it prints what the source has and
 * the document does not, and vice versa.
 *
 * Two traps, both of which had actually let a parameter through:
 *
 *  - **A line-oriented grep misses a call that wraps.** `mapoverbright` is read
 *    as `num(\n  params,\n  'mapoverbright',\n  ...)` and hid from one for as
 *    long as it has existed. Whitespace is collapsed before matching.
 *  - **Matching every `get('...')` in the tree sweeps up things that are not
 *    parameters.** `surfaceparms.has('lava')` is a shader property; the
 *    receiver has to be part of the pattern.
 *
 * And one exclusion that cannot be expressed as a pattern: `src/game/ghost.ts`
 * reads a recorded JSON frame through a helper that happens to share the name
 * `num`, so `armor`, `pmType` and `speed` look exactly like parameters. Any key
 * seen ONLY in that file is dropped.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

/** The file whose `num('key', …)` calls are record fields, not parameters. */
const NOT_PARAMS = 'src/game/ghost.ts';

const PATTERNS: readonly RegExp[] = [
  // `params.get('x')`, `merged.has('x')`, and the other names a
  // URLSearchParams is bound to in this codebase.
  /(?:params|search|sp|query|merged|fresh|runParams|p)\s*\.\s*(?:get|has)\s*\(\s*'([A-Za-z0-9_]+)'/g,
  // `new URLSearchParams(window.location.search).get('x')`, read in place.
  /new URLSearchParams\([^)]*\)\s*\.\s*(?:get|has)\s*\(\s*'([A-Za-z0-9_]+)'/g,
  // The per-file helpers: `num(params, 'x', fallback)`, and water.ts's
  // closure form `num('x', fallback)`.
  /\b(?:num|str|flag|bool|option|pick|clampRange|clamp01)\s*\(\s*(?:params\s*,\s*)?'([A-Za-z0-9_]+)'/g,
];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sources(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full.split(sep).join(posix.sep));
    }
  }
  return out;
}

/** Parameter name -> the files that read it. */
export function findUrlParams(root = 'src'): Map<string, Set<string>> {
  const hits = new Map<string, Set<string>>();
  for (const file of sources(root)) {
    // Collapsed, so a call that wraps across lines still matches.
    const flat = readFileSync(file, 'utf8').replace(/\s+/g, ' ');
    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(flat)) !== null) {
        const key = m[1];
        const files = hits.get(key) ?? new Set<string>();
        files.add(file);
        hits.set(key, files);
      }
    }
  }
  for (const [key, files] of hits) {
    if (files.size === 1 && files.has(NOT_PARAMS)) {
      hits.delete(key);
    }
  }
  return hits;
}

/** The parameter names `docs/url-parameters.md` gives a table row to. */
export function documentedParams(path = 'docs/url-parameters.md'): Set<string> {
  const rows = readFileSync(path, 'utf8').matchAll(/^\| `([A-Za-z0-9_]+)`/gm);
  return new Set([...rows].map((m) => m[1]));
}

function main(): void {
  const found = [...findUrlParams().keys()].sort();

  if (!process.argv.includes('--doc')) {
    console.log(found.join('\n'));
    console.log(`\n${found.length} parameter(s)`);
    return;
  }

  const documented = documentedParams();
  const missing = found.filter((k) => !documented.has(k));
  const stale = [...documented].filter((k) => !found.includes(k)).sort();

  console.log(`source: ${found.length}   documented: ${documented.size}`);
  if (missing.length) {
    console.log(`\nread by the game, NOT in the document:\n  ${missing.join('\n  ')}`);
  }
  if (stale.length) {
    console.log(`\nin the document, NOT read by the game:\n  ${stale.join('\n  ')}`);
  }
  if (!missing.length && !stale.length) {
    console.log('\nthe document matches the source.');
  }
  // Exit non-zero so this can gate a check, the same way `npm run shot` does.
  process.exitCode = missing.length || stale.length ? 1 : 0;
}

main();
