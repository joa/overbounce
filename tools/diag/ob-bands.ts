/**
 * Print the overbounce bands the detector reports, as ranges.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npx tsx tools/diag/ob-bands.ts [from] [to]
 */

import { ObKind, classifyOverbounce } from '../../src/game/overbounce.js';

const from = Number(process.argv[2] ?? 100);
const to = Number(process.argv[3] ?? 320);
const at = (h: number): ObKind => classifyOverbounce(24 + h, 0, 1);

const runs: { kind: ObKind; from: number; to: number }[] = [];
for (let h = from; h <= to; h += 0.0625) {
  const k = at(h);
  const last = runs[runs.length - 1];
  if (last && last.kind === k) {
    last.to = h;
  } else {
    runs.push({ kind: k, from: h, to: h });
  }
}

const name: Record<number, string> = { 0: 'none', 1: 'DROP(O)', 2: 'JUMP(J)' };
for (const r of runs) {
  if (r.kind !== ObKind.NONE) {
    console.log(
      `${name[r.kind].padEnd(8)} ${r.from.toFixed(4)} .. ${r.to.toFixed(4)}` +
        `  width ${(r.to - r.from + 0.0625).toFixed(4)}`,
    );
  }
}
