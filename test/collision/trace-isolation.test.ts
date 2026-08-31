/**
 * A trace must not depend on which traces came before it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is the gate for phase 1.1/1.2/1.3 of `.agent/plans/PERFORMANCE.md`:
 * moving `traceInternal`'s per-call `TraceWork` (15 `Float32Array`s, allocated
 * on EVERY trace) and `traceThroughTree`'s per-node `mid`/`mid2` to reusable
 * scratch. The whole risk of that change is state leaking from one trace into
 * the next, and this file states the invariant that forbids it directly:
 *
 *     the result of trace N is the same whether it runs alone or after
 *     any sequence of other traces
 *
 * It exists because the golden snapshots CANNOT catch this, and the reason is
 * worth writing down rather than rediscovering. Every trace pmove makes is a
 * box trace with the player hull — instrumenting the golden scenarios found
 * **zero** point traces across fourteen of the fifteen, and exactly one across
 * the whole of `rocketjump` (a missile). So a naive shared `TraceWork` that
 * leaks `tw.extents` — written only when `!tw.isPoint` at `trace.ts:691`, read
 * unconditionally on the axial path at `trace.ts:349` — passes all fifteen
 * golden scenarios while being wrong. It only misbehaves when a POINT trace
 * follows a BOX trace, which in the real game is the aim laser (`aim.ts` passes
 * two zero vectors as mins/maxs) and missile tracing, neither of which the
 * headless gate reaches.
 *
 * Hence the corpus below deliberately interleaves point and box traces, and
 * hence `mixed order` shuffles them. A pooled `TraceWork` that forgets to zero
 * `extents` on the point path fails `point trace after box trace`; one that
 * forgets `bounds`, `offsets` or `size` fails the size-varying cases; a mid-point
 * stack that aliases across recursion depth fails the deep-tree cases.
 */

import { describe, expect, it } from 'vitest';
import { axialBrush, rampBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import type { CollisionModel } from '../../src/collision/model.js';
import { boxTrace } from '../../src/collision/trace.js';
import { CONTENTS_SOLID, MASK_PLAYERSOLID } from '../../src/physics/constants.js';
import { createTrace } from '../../src/physics/types.js';
import type { TraceResult } from '../../src/physics/types.js';
import { vec3 } from '../../src/math/vec3.js';
import type { Vec3 } from '../../src/math/vec3.js';

/**
 * A world with enough structure to make the BSP walk recurse: a floor, a ramp,
 * a ceiling and a scattering of pillars at different heights, so traces at
 * different depths and against both axial and non-axial planes are available.
 */
function world(): CollisionModel {
  const brushes = [
    axialBrush([-2048, -2048, -64], [2048, 2048, 0], CONTENTS_SOLID),
    axialBrush([-2048, -2048, 512], [2048, 2048, 576], CONTENTS_SOLID),
    rampBrush([256, -512, -64], [768, 512, 0], 1, CONTENTS_SOLID),
  ];
  for (let i = 0; i < 12; i++) {
    const x = -1024 + i * 160;
    const h = 32 + ((i * 37) % 200);
    brushes.push(axialBrush([x, -96 + i * 13, -64], [x + 48, -48 + i * 13, h], CONTENTS_SOLID));
  }
  return brushListModel(brushes);
}

interface Probe {
  name: string;
  start: Vec3;
  end: Vec3;
  mins: Vec3;
  maxs: Vec3;
}

const PLAYER_MINS = vec3(-15, -15, -24);
const PLAYER_MAXS = vec3(15, 15, 32);
const ZERO = vec3(0, 0, 0);

/**
 * The corpus. Point traces and box traces of several sizes, sweeping in every
 * direction, plus a few degenerate ones (zero-length, starting inside solid)
 * because those take the `positionTest` branch — which has scratch of its own
 * (`lmins`/`lmaxs`/`leafs` at `trace.ts:671`).
 */
function probes(): Probe[] {
  const out: Probe[] = [];
  const box = (name: string, s: Vec3, e: Vec3, mins: Vec3, maxs: Vec3): void => {
    out.push({ name, start: s, end: e, mins, maxs });
  };

  // Point traces: mins == maxs == 0. These are the ones a leaked `extents` breaks.
  box('point-down', vec3(0, 0, 300), vec3(0, 0, -100), ZERO, ZERO);
  box('point-across', vec3(-1200, 0, 64), vec3(1200, 30, 64), ZERO, ZERO);
  box('point-ramp', vec3(200, 0, 200), vec3(700, 0, -50), ZERO, ZERO);
  box('point-diagonal', vec3(-900, -400, 480), vec3(900, 400, 20), ZERO, ZERO);
  box('point-pillars', vec3(-1100, 0, 40), vec3(900, 100, 40), ZERO, ZERO);

  // Player-hull box traces, the shape pmove actually uses.
  box('hull-down', vec3(0, 0, 300), vec3(0, 0, -100), PLAYER_MINS, PLAYER_MAXS);
  box('hull-across', vec3(-1200, 0, 64), vec3(1200, 30, 64), PLAYER_MINS, PLAYER_MAXS);
  box('hull-ramp', vec3(200, 0, 200), vec3(700, 0, -50), PLAYER_MINS, PLAYER_MAXS);
  box('hull-ceiling', vec3(0, 0, 100), vec3(0, 0, 600), PLAYER_MINS, PLAYER_MAXS);
  box('hull-pillars', vec3(-1100, 0, 40), vec3(900, 100, 40), PLAYER_MINS, PLAYER_MAXS);

  // Other box sizes: a missile hull, a crouched player, a very wide one. A
  // pooled `size`/`offsets`/`bounds` that is not fully rewritten shows up as
  // one size answering with another's geometry.
  box('tiny', vec3(-1200, 5, 64), vec3(1200, 5, 64), vec3(-2, -2, -2), vec3(2, 2, 2));
  box('crouch', vec3(-1200, 5, 40), vec3(1200, 5, 40), vec3(-15, -15, -24), vec3(15, 15, 16));
  box('wide', vec3(-1200, 5, 90), vec3(1200, 5, 90), vec3(-64, -64, -8), vec3(64, 64, 8));
  box('asym', vec3(-1200, 5, 70), vec3(1200, 5, 70), vec3(-30, -4, -40), vec3(6, 50, 12));

  // Degenerate: zero-length sweeps take `CM_PositionTest` instead of the walk.
  box('pos-open', vec3(0, 0, 200), vec3(0, 0, 200), PLAYER_MINS, PLAYER_MAXS);
  box('pos-solid', vec3(0, 0, -32), vec3(0, 0, -32), PLAYER_MINS, PLAYER_MAXS);
  box('pos-point', vec3(0, 0, -32), vec3(0, 0, -32), ZERO, ZERO);

  // Starting inside solid, which drives `startsolid`/`allsolid`.
  box('in-floor', vec3(0, 0, -32), vec3(0, 0, 200), PLAYER_MINS, PLAYER_MAXS);

  return out;
}

/** Everything a caller can observe about a trace, as a comparable string. */
function describeTrace(t: TraceResult): string {
  return [
    t.allsolid,
    t.startsolid,
    t.fraction,
    t.endpos[0],
    t.endpos[1],
    t.endpos[2],
    t.plane.normal[0],
    t.plane.normal[1],
    t.plane.normal[2],
    t.plane.dist,
    t.plane.type,
    t.plane.signbits,
    t.surfaceFlags,
    t.contents,
    t.entityNum,
  ].join(' ');
}

function runProbe(model: CollisionModel, p: Probe): string {
  const result = createTrace();
  boxTrace(model, result, p.start, p.mins, p.maxs, p.end, MASK_PLAYERSOLID);
  return describeTrace(result);
}

/** A seeded shuffle, so a failure is reproducible rather than "sometimes red". */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('traces are independent of what ran before them', () => {
  const model = world();
  const corpus = probes();

  /*
   * The reference answers. Each is produced by a process that has done nothing
   * else to this model — well, nothing else in this test: `model.checkcount`
   * advances, which is intended and is not scratch. If a future change makes
   * even THIS baseline order-dependent, every case below fails at once, which
   * is the right way for that to be reported.
   */
  const alone = new Map<string, string>();
  for (const p of corpus) {
    alone.set(p.name, runProbe(model, p));
  }

  it('has a corpus that actually reaches both branches', () => {
    // Guards the file against quietly becoming vacuous. Point traces are the
    // whole reason it exists (see the header), so assert they are in here.
    const points = corpus.filter((p) => p.mins === ZERO && p.maxs === ZERO);
    expect(points.length).toBeGreaterThanOrEqual(5);
    // And that the corpus is not all misses: a trace that hits nothing exercises
    // far less of the walk.
    const hits = [...alone.values()].filter((v) => !v.startsWith('false false 1 '));
    expect(hits.length).toBeGreaterThanOrEqual(corpus.length / 2);
  });

  for (const p of corpus) {
    it(`${p.name} is unaffected by a preceding player-hull trace`, () => {
      // The specific pairing that a leaked `tw.extents` breaks: a big box trace
      // followed by the probe. With `extents` pooled and not re-zeroed, a point
      // probe here reads the hull's extents and offsets its node tests by up to
      // 32 units.
      runProbe(model, {
        name: 'warm',
        start: vec3(-1200, 0, 64),
        end: vec3(1200, 30, 64),
        mins: PLAYER_MINS,
        maxs: PLAYER_MAXS,
      });
      expect(runProbe(model, p)).toBe(alone.get(p.name));
    });
  }

  it('every probe survives every possible predecessor', () => {
    for (const before of corpus) {
      for (const p of corpus) {
        runProbe(model, before);
        expect(
          runProbe(model, p),
          `${p.name} changed when it ran after ${before.name}`,
        ).toBe(alone.get(p.name));
      }
    }
  });

  for (const seed of [1, 2, 3, 12345]) {
    it(`mixed order is stable (seed ${seed})`, () => {
      // Long interleaved runs, so a scratch slot that only goes wrong after a
      // particular depth or a particular sequence still gets hit.
      for (let pass = 0; pass < 4; pass++) {
        for (const p of shuffled(corpus, seed + pass)) {
          expect(runProbe(model, p), `${p.name} drifted on pass ${pass}`).toBe(
            alone.get(p.name),
          );
        }
      }
    });
  }
});
