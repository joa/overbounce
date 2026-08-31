/**
 * The HUD's rendered DOM must not change.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * @vitest-environment happy-dom
 *
 * This is phase 3's gate, and it is the golden-snapshot idea from
 * `test/physics/golden.test.ts` pointed at markup instead of movement: drive
 * `hud.update()` through a set of representative states and assert the resulting
 * HTML is byte-identical to what it was before.
 *
 * Phase 3 is entirely made of changes that must not be observable — skipping a
 * rebuild for a panel nobody can see, and skipping a DOM write whose value is
 * already correct. "The DOM ends in the same state" is exactly the claim those
 * changes make, so it is the claim to test, and it is not one a screenshot can
 * make precisely.
 *
 * Two deliberate choices:
 *
 *  - **`outerHTML` of the whole HUD**, not selected fields. A dirty-check that
 *    skips a write it should have made is invisible to a test that only looks
 *    where it expects trouble.
 *  - **Sequences, not single frames.** The bugs this is guarding against are
 *    stateful: a cached "last written value" that goes stale, or a panel that
 *    is not repopulated when it becomes visible again, only misbehave on the
 *    *second* call. Every case below therefore drives several updates in order
 *    and snapshots the end state, and `visibility toggling` snapshots after each
 *    step.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createHud } from '../../src/render/hud.js';
import type { Hud, HudData, HudQuickSettingsInit } from '../../src/render/hud.js';

const QUICK: HudQuickSettingsInit = {
  camera: 'auto',
  obHelp: 'letter',
  ghost: true,
  debugPanel: true,
  volume: 70,
};

function noopCallbacks(): Parameters<typeof createHud>[1] {
  return {
    onRestart: () => {},
    onResume: () => {},
    onExit: () => {},
    onSettings: () => {},
    onCameraChange: () => {},
    onObHelpChange: () => {},
    onGhostToggle: () => {},
    onDebugToggle: () => {},
    onVolumeChange: () => {},
    onFullscreenToggle: () => {},
  } as unknown as Parameters<typeof createHud>[1];
}

/** A plain, mid-run frame. Every case below is a delta from this. */
function base(): HudData {
  return {
    speed: 412.7,
    yaw: 137.4,
    onGround: false,
    origin: [128.4, -64.9, 40.125],
    health: 87,
    armor: 25,
    weapon: 'Rocket Launcher',
    ammo: 8,
    weaponTime: 240,
    missiles: 2,
    fps: 60,
    locked: true,
    backend: 'webgpu',
    airTime: 0.42,
    jumps: 17,
    cpuMs: 8.31,
  };
}

let parent: HTMLElement;
let hud: Hud;

/**
 * A controlled clock.
 *
 * `update()` throttles the speed instrument to `SPEED_UPDATE_INTERVAL_MS`
 * (1000/60) off `performance.now()`, so on the real clock whether a given call
 * redraws the speed number at all depends on how fast the test machine got
 * there. That makes both the snapshots and the sequence comparisons flaky for a
 * reason that has nothing to do with the HUD. Stepping 20ms per reading — just
 * over the interval — makes the throttle fire on every update, deterministically.
 */
let clock = 0;
const CLOCK_STEP_MS = 20;

/** Build (or rebuild) an empty document with one fresh HUD in it. */
function mount(): void {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  parent = document.createElement('div');
  document.body.appendChild(parent);
  hud = createHud(parent, noopCallbacks(), QUICK);
}

beforeEach(() => {
  clock = 0;
  performance.now = (): number => {
    clock += CLOCK_STEP_MS;
    return clock;
  };
  // A fresh document each time: `createHud` appends a <style> to document.head
  // and the HUD root to `parent`, and a leaked previous HUD would be found by
  // the next test's queries.
  mount();
});

/** The whole HUD subtree, which is the thing that must not change. */
function html(): string {
  return (parent.firstElementChild as HTMLElement).outerHTML;
}

/**
 * The HUD minus the elements named by `selectors`.
 *
 * Used to compare "everything except X" without a regex over markup, which is
 * how the first attempt at this file got it wrong.
 */
function htmlWithout(...selectors: readonly string[]): string {
  const clone = (parent.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  for (const sel of selectors) {
    for (const el of Array.from(clone.querySelectorAll(sel))) {
      el.remove();
    }
  }
  return clone.outerHTML;
}

/** Drive several frames, then return the final markup. */
function after(...frames: readonly HudData[]): string {
  for (const f of frames) {
    hud.update(f);
  }
  return html();
}

describe('HUD DOM', () => {
  it('renders a mid-run frame', () => {
    expect(after(base())).toMatchSnapshot();
  });

  it('is stable when the same frame is drawn twice', () => {
    /*
     * The dirty-checking in 3.1 must be idempotent: drawing the same data again
     * leaves the DOM exactly as the first draw left it.
     *
     * The trace is excluded because a second frame legitimately adds a second
     * sample to the rolling graph. With the stepped clock this really does run
     * the throttled branch twice -- on the real clock the second call landed
     * inside the throttle window and the test was passing without testing.
     */
    after(base());
    const once = htmlWithout('[data-trace-svg]');
    hud.update(base());
    expect(htmlWithout('[data-trace-svg]')).toBe(once);
  });

  it('reaches the same DOM whether or not other frames came first', () => {
    /*
     * The property a per-element value cache can break: a cache that records
     * "already wrote 412" and then fails to notice a change would pass a
     * single-frame test and fail here, arriving at the same state from a
     * different history.
     *
     * The speed TRACE is excluded, and legitimately so -- it is the one part of
     * the HUD that is supposed to depend on history. `trace.push` accumulates a
     * rolling ten-second graph, so its markup is a function of the sequence
     * rather than of this frame. Asserting otherwise was this file's first bug:
     * the test failed against unmodified code, which is the test being wrong,
     * not the HUD. Everything else, including the speed NUMBER, is a pure
     * function of the current frame and is compared.
     */
    after(base());
    const direct = htmlWithout('[data-trace-svg]');

    clock = 0;
    mount();

    after(
      { ...base(), speed: 0, health: 100, armor: 0, onGround: true, missiles: 0 },
      { ...base(), speed: 900, health: 12, armor: 100, weapon: 'Plasma Gun', ammo: 0 },
      base(),
    );
    expect(htmlWithout('[data-trace-svg]')).toBe(direct);
  });

  it('renders on the ground, unarmed, at rest', () => {
    expect(
      after({
        ...base(),
        speed: 0,
        onGround: true,
        weapon: 'None',
        ammo: 0,
        weaponTime: 0,
        missiles: 0,
        health: 100,
        armor: 0,
      }),
    ).toMatchSnapshot();
  });

  it('renders a running clock with splits', () => {
    expect(
      after({
        ...base(),
        run: {
          state: 'running',
          elapsed: 12_345,
          best: 11_900,
          splits: [4200, 8100],
          bestSplits: [4000, 8000],
          attempt: 3,
        },
      }),
    ).toMatchSnapshot();
  });

  it('renders a finished personal best', () => {
    expect(
      after({
        ...base(),
        run: {
          state: 'finished',
          elapsed: 11_500,
          best: 11_900,
          splits: [4000, 7800, 11_500],
          bestSplits: [4100, 8000, 11_900],
          personalBest: true,
          attempt: 4,
        },
      }),
    ).toMatchSnapshot();
  });

  /*
   * The splits table's row count VARIES -- `max(splits, bestSplits, 3)` -- and
   * it used to be rebuilt from scratch each frame, so the DOM always held
   * exactly the right number of rows. Now the rows are pooled and surplus ones
   * are detached, which is only equivalent if the count is tracked correctly
   * in both directions. Crossing checkpoints grows it; starting a new run
   * shrinks it back.
   *
   * `[data-clock-badge]` is excluded, and the exclusion was earned rather than
   * assumed: the idle branch sets `elClockBadge.style.color` and the later
   * `best === null` branch clears only the text, so the inline colour survives
   * into the running state. That was checked against the ORIGINAL code and
   * behaves identically there — a latent cosmetic quirk of the HUD, not
   * something the pooling introduced, and so not something to "fix" here.
   */
  it('grows and shrinks the splits table to the same DOM either way', () => {
    after({
      ...base(),
      run: { state: 'running', elapsed: 20_000, best: null, splits: [1, 2, 3, 4, 5], attempt: 1 },
    });
    const fiveRows = htmlWithout('[data-trace-svg]', '[data-clock-badge]');

    clock = 0;
    mount();
    after(
      { ...base(), run: { state: 'idle', elapsed: 0, best: null, splits: [], attempt: 1 } },
      { ...base(), run: { state: 'running', elapsed: 5000, best: null, splits: [1], attempt: 1 } },
      {
        ...base(),
        run: { state: 'running', elapsed: 30_000, best: null, splits: [1, 2, 3, 4, 5, 6, 7], attempt: 1 },
      },
      { ...base(), run: { state: 'running', elapsed: 20_000, best: null, splits: [1, 2, 3, 4, 5], attempt: 1 } },
    );
    expect(htmlWithout('[data-trace-svg]', '[data-clock-badge]')).toBe(fiveRows);
  });

  /*
   * The debug panel carries the performance rows now -- `stats.ts` measures,
   * the HUD draws, and there is ONE panel as the design specifies rather than
   * a second overlay stacked under this one. The group is absent under
   * `?stats=off`, so the grid's row count varies at runtime and the pooled
   * rows have to be detached and reattached correctly.
   */
  it('renders the performance rows when something is measuring', () => {
    expect(
      after({ ...base(), cpuMs: 8.31, gpuMs: 2.14, drawCalls: 179, triangles: 55_912 }),
    ).toMatchSnapshot();
  });

  it('reports gpu as n/a when the backend cannot measure it', () => {
    after({ ...base(), cpuMs: 8.31, gpuMs: null, drawCalls: 179, triangles: 55_912 });
    expect(
      (parent.querySelector('[data-debug-grid]') as HTMLElement).innerText,
    ).toContain('n/a');
  });

  it('adds and drops the performance rows without disturbing the panel', () => {
    const perf = { cpuMs: 8.31, gpuMs: 2.14, drawCalls: 179, triangles: 55_912 };

    after({ ...base(), ...perf });
    const withPerf = htmlWithout('[data-trace-svg]');

    clock = 0;
    mount();
    after(base());
    const withoutPerf = htmlWithout('[data-trace-svg]');
    expect(withoutPerf).not.toBe(withPerf);

    // Nine rows down to six and back up again: the pool must detach the extras
    // and reattach them in the same order, or the panel drifts.
    clock = 0;
    mount();
    after({ ...base(), ...perf }, base(), { ...base(), ...perf });
    expect(htmlWithout('[data-trace-svg]')).toBe(withPerf);

    clock = 0;
    mount();
    after({ ...base(), ...perf }, base());
    expect(htmlWithout('[data-trace-svg]')).toBe(withoutPerf);
  });

  it('renders freerun', () => {
    expect(
      after({ ...base(), freerun: { topSpeed: 1129.4, reason: 'map' } }),
    ).toMatchSnapshot();
  });

  it('renders the strafe gauge, gaining and losing', () => {
    expect(
      after({
        ...base(),
        strafe: {
          currentAngle: 31.5,
          optimalAngle: 28.2,
          minGainAngle: 12.0,
          efficiency: 0.94,
          gainedThisJump: 23.6,
        },
      }),
    ).toMatchSnapshot();
  });

  it('renders the overbounce readout in both registers', () => {
    const letter = after({ ...base(), overbounce: { letter: 'G', height: 312 } });
    expect(letter).toMatchSnapshot('letter');

    clock = 0;
    mount();
    expect(
      after({ ...base(), overbounce: { letter: 'R', height: 88 }, obHelp: 'full' }),
    ).toMatchSnapshot('full');
  });

  it('renders the dead and paused phases', () => {
    expect(
      after({
        ...base(),
        phase: 'dead',
        attemptInfo: { mapName: 'ob_rockets', attempt: 5, elapsed: 9300, voided: true },
      }),
    ).toMatchSnapshot();
  });

  /*
   * The one phase 3.0 is about.
   *
   * `debugRow` was the most expensive function in the whole project (4.8% of
   * busy CPU, measured -- see `.agent/docs/perf-gate-findings.md` finding 10)
   * because the grid was torn down and rebuilt every frame whether or not the
   * panel was on screen: the visibility toggle is a CSS class, and the rebuild
   * below it was not gated on it.
   *
   * Gating it is only safe if the panel is still correct the moment it comes
   * back, so that is what this asserts -- hidden, shown again, and then
   * identical to a HUD that was never hidden at all.
   */
  it('repopulates the debug grid when it becomes visible again', () => {
    after(base(), base());
    const neverHidden = htmlWithout('[data-trace-svg]');

    clock = 0;
    mount();

    hud.update(base());
    hud.setDebugVisible(false);
    hud.update({ ...base(), speed: 5, origin: [0, 0, 0], jumps: 0 });
    hud.update({ ...base(), speed: 900, origin: [1, 2, 3], jumps: 99 });
    hud.setDebugVisible(true);
    hud.update(base());

    // The trace is excluded: the frames driven while the panel was hidden
    // pushed their own samples into the rolling speed graph, so the two runs
    // legitimately have different graphs. Everything else must match.
    expect(htmlWithout('[data-trace-svg]')).toBe(neverHidden);
  });

  it('hides the debug panel without disturbing the rest', () => {
    hud.update(base());
    const shown = html();
    hud.setDebugVisible(false);
    hud.update(base());
    const hidden = html();

    expect(hidden).not.toBe(shown);

    /*
     * Toggling the panel is allowed to change exactly two things: the panel
     * itself, and the PAUSED quick-setting that reports its state
     * (`setDebugVisible` rewrites `debugToggle.className`). Nothing else in the
     * HUD may move -- which is the property that makes gating the rebuild on
     * `debugVisible` safe in the first place.
     */
    const ignore = ['[data-debug]', '[data-qs-debug]', '[data-trace-svg]'] as const;
    const rest = htmlWithout(...ignore);
    hud.setDebugVisible(true);
    hud.update(base());
    expect(htmlWithout(...ignore)).toBe(rest);
  });
});
