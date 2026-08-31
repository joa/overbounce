/**
 * The byte-identical gate: scripted runs whose per-tick output must not move.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Phase 0.1 of `.agent/plans/PERFORMANCE.md`. The rest of this directory checks
 * that the physics is RIGHT, against id's constants. This file checks only that
 * it has not CHANGED — which is what an optimization pass has to guarantee and
 * what no tolerance-based assertion can express.
 *
 * A failure here is not automatically a bug: a deliberate behaviour change fails
 * it too, and should. What a failure means is "you changed observable output,
 * say so out loud". Regenerate with `npm run golden` only for the two reasons
 * listed in `tools/golden.ts`'s header.
 *
 * Lives under `test/physics/` rather than a directory of its own so that
 * `npm run test:physics` — the loop CLAUDE.md says to iterate against — runs it
 * without anyone having to remember to.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../golden/scenarios.js';
import { SNAPSHOT_DIR } from '../golden/paths.js';

interface Divergence {
  where: string;
  expected: string;
  actual: string;
  trailing: number;
}

/**
 * The FIRST place two runs disagree, not the whole diff.
 *
 * These runs are hundreds of ticks long and a single changed ulp on tick 12
 * makes every later tick differ too, so a raw string comparison buries the one
 * line that matters under seven hundred that merely followed from it. The tick
 * number is the useful output: it says which manoeuvre was in progress.
 */
function firstDivergence(expected: string, actual: string): Divergence | null {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const header = a[0].split('\t');

  const cols = (row: string | undefined): string =>
    row === undefined
      ? '(missing — the run is a different length)'
      : row
          .split('\t')
          .map((v, c) => `${header[c] ?? `col${c}`}=${v}`)
          .join(' ');

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) {
      continue;
    }
    return {
      where: i === 0 ? 'the header' : `tick ${i - 1}`,
      expected: cols(a[i]),
      actual: cols(b[i]),
      trailing: Math.max(a.length, b.length) - i,
    };
  }
  return null;
}

function snapshotFor(name: string): string {
  const path = join(SNAPSHOT_DIR, `${name}.tsv`);
  expect(
    existsSync(path),
    `no snapshot for "${name}". Run: npm run golden -- ${name}`,
  ).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('golden scenarios', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} is unchanged`, () => {
      const expected = snapshotFor(scenario.name);
      const actual = scenario.run();
      if (actual === expected) {
        return;
      }

      const d = firstDivergence(expected, actual);
      if (d) {
        expect.fail(
          `"${scenario.name}" diverged at ${d.where}.\n` +
            `  expected: ${d.expected}\n` +
            `  actual:   ${d.actual}\n\n` +
            `${d.trailing} line(s) differ from here on.\n` +
            `If this change is intentional and correct, regenerate with:\n` +
            `  npm run golden -- ${scenario.name}\n` +
            `and say in the commit message why the new output is what Q3 does.`,
        );
      }

      // Same lines, different text: only trailing whitespace could do it.
      expect(actual).toBe(expected);
    });
  }

  /*
   * The tree must not change the answer.
   *
   * `test/collision/bsp-physics.test.ts` already asserts this for a couple of
   * hand-written drop heights; this asserts it for every scenario above whose
   * geometry can be compiled, against the SAME snapshot file. Two things fall
   * out of that:
   *
   *  - the BSP walk is gated by the full breadth of the scenario set rather
   *    than by two cases, and
   *  - `traceThroughTree` is exercised AT ALL. A flat brush list has
   *    `nodes: []`, so `traceInternal` jumps straight to `traceThroughLeaf` and
   *    never enters the walk. Before this block every golden scenario was
   *    testing the leaf test and nothing above it — which is precisely the code
   *    phase 1.2 proposes to rewrite.
   */
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} gives the same result through a BSP tree`, (ctx) => {
      const compiled = scenario.runBsp();
      if (compiled === null) {
        // Non-axial geometry or a hand-built submodel; `writeBsp` cannot
        // express it. Skipped rather than silently absent, so the count of
        // scenarios lacking tree coverage stays visible in the run output.
        ctx.skip();
        return;
      }
      const expected = snapshotFor(scenario.name);
      if (compiled === expected) {
        return;
      }
      const d = firstDivergence(expected, compiled);
      expect.fail(
        `"${scenario.name}" answers differently through a compiled BSP than ` +
          `through a flat brush list, at ${d?.where ?? 'an unknown tick'}.\n` +
          `  flat list (the snapshot): ${d?.expected ?? '?'}\n` +
          `  BSP tree:                 ${d?.actual ?? '?'}\n\n` +
          `The tree is an acceleration structure. It is never allowed to change ` +
          `a result, so this is a bug in the tree walk — NOT a snapshot to ` +
          `regenerate.`,
      );
    });
  }
});
