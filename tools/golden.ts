/**
 * Regenerate the golden per-tick snapshots.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run golden           # rewrite every snapshot
 *   npm run golden -- ramp   # rewrite the ones whose name contains "ramp"
 *   npm run golden -- --check  # write nothing; report which would change
 *
 * READ THIS BEFORE RUNNING IT.
 *
 * These files are the gate that proves an optimization changed no behaviour
 * (`.agent/plans/PERFORMANCE.md`, phase 0.1). Running this command makes a
 * failing golden test pass *by definition*, which is the exact inversion
 * CLAUDE.md's testing section prohibits — "never update a golden value to match
 * new output without first proving the new output is what Q3 does".
 *
 * So there are only two legitimate reasons to run it:
 *
 *   1. A scenario was added or its script was edited. The diff should then be
 *      confined to that scenario's file.
 *   2. A deliberate behaviour change landed, its correctness was established
 *      some other way (id's C, a physics unit test), and the snapshot is being
 *      brought along. The commit message has to say which.
 *
 * "The test went red after I refactored" is not one of them. That is the gate
 * doing its job.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS } from '../test/golden/scenarios.js';
import { SNAPSHOT_DIR } from '../test/golden/paths.js';

const args = process.argv.slice(2);
const check = args.includes('--check');
const filters = args.filter((a) => !a.startsWith('--'));

mkdirSync(SNAPSHOT_DIR, { recursive: true });

let changed = 0;
let written = 0;

for (const scenario of SCENARIOS) {
  if (filters.length && !filters.some((f) => scenario.name.includes(f))) {
    continue;
  }

  const path = join(SNAPSHOT_DIR, `${scenario.name}.tsv`);
  const next = scenario.run();
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : null;

  if (prev === next) {
    console.log(`  ok      ${scenario.name}`);
    continue;
  }

  changed++;
  const label = prev === null ? 'new' : 'CHANGED';
  console.log(`  ${label.padEnd(7)} ${scenario.name}${firstDiff(prev, next)}`);

  if (!check) {
    writeFileSync(path, next);
    written++;
  }
}

if (check) {
  console.log(`\n${changed} scenario(s) would change.`);
  process.exit(changed === 0 ? 0 : 1);
} else {
  console.log(`\n${written} snapshot(s) written, ${SCENARIOS.length} total.`);
}

/** Where the two texts first disagree, for the one-line report above. */
function firstDiff(prev: string | null, next: string): string {
  if (prev === null) {
    return '';
  }
  const a = prev.split('\n');
  const b = next.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      // Line 0 is the header, so the tick is one less than the line number.
      return ` (first diff at line ${i + 1}${i > 0 ? `, tick ${i - 1}` : ''})`;
    }
  }
  return '';
}
