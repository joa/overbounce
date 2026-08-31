/**
 * Does V8's sampling heap profiler attribute Float32Array backing stores?
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npx tsx tools/browser/sampler-blindspot.ts     (needs a dev server on 5180)
 *
 * The answer is NO, and this is kept rather than deleted because that is a
 * surprising claim that `npm run profile`'s output depends on entirely. Every
 * allocation in `src/physics/`, `src/collision/` and `src/math/` is a 3-element
 * `Float32Array` -- `vec3()` -- so a profiler that cannot see typed arrays
 * cannot see any of it. The first profile taken of this game duly reported that
 * physics and collision allocate essentially nothing, which is an artifact of
 * the instrument rather than a fact about the code.
 *
 * Measured here: 300 000 escaping allocations of each kind.
 *
 *     Float32Array(3)   0.00 MB attributed
 *     { x, y, z }       0.19 MB attributed
 *
 * A trap worth keeping, because the first version of this check fell into it:
 * if the allocations do not ESCAPE, V8's escape analysis scalar-replaces both
 * and reports 0.00 MB for each -- which looks exactly like the blind spot being
 * measured, for an unrelated reason. Hence `window.__a`/`__b`.
 *
 * See `.agent/docs/perf-gate-findings.md`.
 */

import { withPage } from './session.js';

const N = 300_000;

interface Node {
  callFrame: { functionName: string };
  selfSize: number;
  children?: Node[];
}

function total(node: Node, name: string): number {
  let sum = node.callFrame.functionName === name ? node.selfSize : 0;
  for (const c of node.children ?? []) {
    sum += total(c, name);
  }
  return sum;
}

await withPage('http://localhost:5180/?devpak=dev-q3dm6.pk3&map=q3dm6&player=doom', async ({ page }) => {
  const cdp = await page.createCDPSession();
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 4096 });

  await page.evaluate(`
    window.__a = []; window.__b = [];
    (function () {
      function makeF32() { var a = new Float32Array(3); a[0] = Math.random(); return a; }
      function makePlain() { return { x: Math.random(), y: 0, z: 0 }; }
      // Stored, not summed: the first version of this check summed the values
      // and V8 scalar-replaced BOTH allocations, reporting 0 bytes for each and
      // looking like a profiler blind spot when it was an escape-analysis win.
      for (var i = 0; i < ${N}; i++) { window.__a.push(makeF32()); }
      for (var i = 0; i < ${N}; i++) { window.__b.push(makePlain()); }
    })();
  `);

  const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as unknown as {
    profile: { head: Node };
  };
  await cdp.detach();

  const f32 = total(profile.head, 'makeF32');
  const plain = total(profile.head, 'makePlain');
  console.log(`\n${N.toLocaleString()} of each, 3 floats apiece:`);
  console.log(`  Float32Array(3) attributed: ${(f32 / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  plain {x,y,z}   attributed: ${(plain / 1024 / 1024).toFixed(2)} MB`);
  console.log(
    `\n  => the sampler ${f32 > plain / 10 ? 'DOES' : 'DOES NOT'} see typed-array backing stores.`,
  );
});
