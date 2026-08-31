/**
 * Where the frame time and the garbage actually go, in the running game.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run profile                                  # q3dm6, 12 seconds
 *   npm run profile -- --map q3dm7 --seconds 20
 *   npm run profile -- --idle                        # no input, camera only
 *   npm run profile -- --json out.json               # machine-readable
 *
 * Needs a dev server on `--port` (5180 by default): `npx vite --port 5180`.
 *
 * This is phase 0.4 of `.agent/plans/PERFORMANCE.md`, and it exists because
 * nothing else in the project can answer the question the plan turns on.
 *
 *  - fps cannot: the canvas is vsync-limited, so anything inside the frame
 *    budget reads as exactly 60 and a change that doubles GPU cost also reads as
 *    exactly 60. `src/render/stats.ts`'s own header makes this point at length.
 *  - The headless allocation test cannot: it forces a collection at both ends,
 *    so it measures RETAINED bytes. A scratch `vec3()` that dies immediately —
 *    which is nearly all of what phase 1 targets — never appears in it at all.
 *
 * So this measures the two things that do decide the answer:
 *
 *   allocation   V8's sampling heap profiler, attributed to the call site that
 *                allocated. This is the ranked list of what to pool, measured
 *                rather than guessed, and it counts short-lived garbage.
 *   frame times  every rAF interval, reported as a distribution. The p99/p50
 *                ratio is the number that says "stutter"; a mean does not.
 *
 * THREE THINGS THIS TOOL CANNOT TELL YOU. All measured, not guessed.
 *
 * 1. **The allocation ranking is blind to typed arrays.** V8's sampling heap
 *    profiler does not attribute `Float32Array` backing stores at all: 300 000
 *    escaping `Float32Array(3)`s report 0.00 MB where the same number of plain
 *    `{x,y,z}` objects report 0.19 MB. Since `vec3()` IS a `Float32Array`,
 *    every allocation in `src/physics/`, `src/collision/` and `src/math/` is
 *    invisible here. The first profile of this game duly ranked physics at
 *    ~0%; that is the instrument, not the code. Run
 *    `tools/browser/sampler-blindspot.ts` if you want to see it for yourself.
 *    → **Use this tool to rank the RENDER and UI side. Not phase 1.**
 *
 * 2. **`onMouseMove` and `onKeyDown` near the top are not our garbage.** Those
 *    handlers allocate nothing (`src/input/input.ts:110`); the bytes are the
 *    browser's own `MouseEvent`/`KeyboardEvent` objects, attributed to the frame
 *    that received them. Nothing to pool there.
 *
 * 3. **Everything depends on the anti-throttle flags below.** Chrome throttles a
 *    page it thinks nobody is watching -- and a puppeteer window counts as
 *    nobody, HEADFUL AS WELL AS HEADLESS. Without them rAF fires about ten times
 *    a second, which makes every percentile an artifact; the `gpu` timestamp
 *    then measures the vsync WAIT rather than the work (11.9ms throttled versus
 *    1.6ms unthrottled, same scene, same GPU); and `cpu` inflates too, because
 *    at 100ms per callback the fixed-timestep accumulator runs about twelve 8ms
 *    physics ticks instead of two and charges all twelve to that frame. The
 *    first four runs of this tool concluded the game was GPU-bound on exactly
 *    that evidence. It is not. Do not remove the flags.
 *
 * Beyond that: the profiler attributes bytes to a stack and the dev build is
 * unminified, so names are real, but inlining still moves some allocations to a
 * caller. Treat the ranking as sound and the split between two adjacent frames
 * of one stack as approximate.
 */

import { writeFileSync } from 'node:fs';
import type { Page } from 'puppeteer';
import { withPage } from './session.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const port = arg('port', '5180');
const map = arg('map', 'q3dm6');
const seconds = Number(arg('seconds', '12'));
const warmupMs = Number(arg('warmup', '3000'));
const idle = flag('idle');
const jsonOut = arg('json');

const url =
  arg('url') ||
  `http://localhost:${port}/?${new URLSearchParams({
    devpak: arg('devpak', `dev-${map}.pk3`),
    map,
    player: arg('player', 'doom'),
  }).toString()}`;

/* -------------------------------------------------------- the sampled types */

/** `HeapProfiler.SamplingHeapProfileNode`, which puppeteer does not type. */
interface SampleNode {
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  selfSize: number;
  children?: SampleNode[];
}

interface Site {
  label: string;
  /** Bytes attributed to this frame itself, not its children. */
  selfBytes: number;
}

/**
 * Flatten the sampling tree to a per-call-site total.
 *
 * `selfSize` is what matters: a parent's total includes everything its callees
 * allocated, which would rank `loop` first in every profile and say nothing.
 */
function flatten(node: SampleNode, into: Map<string, Site>): void {
  if (node.selfSize > 0) {
    const f = node.callFrame;
    const file = f.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
    const label = `${f.functionName || '(anonymous)'} — ${file}:${f.lineNumber + 1}`;
    const existing = into.get(label);
    if (existing) {
      existing.selfBytes += node.selfSize;
    } else {
      into.set(label, { label, selfBytes: node.selfSize });
    }
  }
  for (const child of node.children ?? []) {
    flatten(child, into);
  }
}

/* -------------------------------------------------- source injected as text */

/**
 * Every rAF interval, pushed onto `window.__obFrames`.
 *
 * Source rather than a function for the `__name` reason given at the call site.
 */
const FRAME_TIMER_SOURCE = `
  window.__obFrames = [];
  (function () {
    var last = performance.now();
    function tick() {
      var now = performance.now();
      window.__obFrames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();
`;

/**
 * The perf overlay plus the speed readout, flattened onto one line.
 *
 * `[data-speed]` is not decoration here. The first profile taken with this tool
 * showed almost no allocation from `src/physics/` and `src/collision/`, which
 * would have been a startling result -- and the first thing to rule out is that
 * the player never moved, because a profile of a stationary player exercises
 * neither. Sampling the speed while the profile runs settles it on the spot.
 */
const HUD_TEXT_SOURCE = `
  (function () {
    var a = document.querySelector('.ob-stats-perf');
    var s = document.querySelector('[data-speed]');
    return [a ? a.innerText : '', s ? 'speed ' + s.innerText + 'ups' : '']
      .filter(Boolean).join(' | ').replace(/\\s+/g, ' ');
  })()
`;

/* ------------------------------------------------------------------ driving */

/** Click the canvas to take pointer lock, so input reaches the game. */
async function grabPointerLock(page: Page): Promise<boolean> {
  await page.mouse.click(640, 360);
  // `input.locked` gates the laser, the OB readout and every movement key, so
  // a profile taken without it is a profile of a different program.
  return page
    .waitForFunction('document.pointerLockElement !== null', { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
}

/**
 * Run about like a player: forward, strafing, jumping, turning, firing.
 *
 * Not a replay — it does not need to be reproducible, it needs to be
 * REPRESENTATIVE. The costs this is looking for (missiles, dynamic lights,
 * explosion effects, decals, the shadow trace, slidemove bumps) only appear when
 * the player is actually moving and shooting, and a profile of someone standing
 * still would rank the HUD first and be useless.
 */
async function play(page: Page, ms: number): Promise<void> {
  const until = Date.now() + ms;
  await page.keyboard.down('KeyW');
  let left = false;
  let i = 0;

  try {
    while (Date.now() < until) {
      // Alternate strafe direction with a mouse turn the same way, which is
      // what strafe jumping is and what makes `PM_Accelerate` do work.
      await page.keyboard.up(left ? 'KeyA' : 'KeyD');
      left = !left;
      await page.keyboard.down(left ? 'KeyA' : 'KeyD');

      for (let step = 0; step < 8; step++) {
        await page.mouse.move(640 + (left ? -18 : 18), 360, { steps: 1 });
        await new Promise((r) => setTimeout(r, 16));
      }

      await page.keyboard.down('Space');
      await new Promise((r) => setTimeout(r, 32));
      await page.keyboard.up('Space');

      // A rocket every second or so: missiles, a dynamic light, smoke, an
      // explosion, a decal and splash knockback all at once.
      if (i % 4 === 0) {
        await page.mouse.down();
        await new Promise((r) => setTimeout(r, 40));
        await page.mouse.up();
      }
      i++;
    }
  } finally {
    await page.keyboard.up('KeyW');
    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyD');
  }
}

/* ------------------------------------------------------------------ reports */

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}kB`;
}

interface Report {
  map: string;
  seconds: number;
  idle: boolean;
  pointerLock: boolean;
  frames: number;
  frameMs: { p50: number; p90: number; p95: number; p99: number; max: number };
  longFrames: number;
  totalAllocatedBytes: number;
  bytesPerFrame: number;
  sites: Site[];
  hud: string;
  /** Highest speed seen while sampling. Zero means the player never moved. */
  peakSpeed: number;
  /** How many samples were above walking pace, out of `speedSamples`. */
  movingSamples: number;
  speedSamples: number;
  problems: string[];
}

async function main(): Promise<void> {
  const report = await withPage(url, async ({ page, problems }): Promise<Report> => {
    const locked = idle ? false : await grabPointerLock(page);

    // Let shader compilation, pak parsing and the first GC settle. Profiling
    // through startup would attribute the whole of map loading to "the frame".
    await new Promise((r) => setTimeout(r, warmupMs));

    // Record every rAF interval from inside the page. Puppeteer cannot see
    // frame boundaries; the page can.
    //
    // Injected as a STRING, not a function. `tsx` compiles this file with
    // esbuild's `keepNames`, which rewrites a named arrow function into a call
    // to esbuild's `__name` helper -- and that helper does not exist in the
    // page, so a perfectly ordinary `page.evaluate(() => {...})` fails at
    // runtime with `__name is not defined`. Anything with a named inner
    // function has to go across as source.
    await page.evaluate(FRAME_TIMER_SOURCE);

    const cdp = await page.createCDPSession();
    await cdp.send('HeapProfiler.enable');
    // 4kB average between samples: fine enough to rank call sites over a
    // ten-second run, coarse enough not to distort the thing being measured.
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 4096 });

    const speeds: number[] = [];
    const sampler = setInterval(() => {
      void page
        .evaluate('(document.querySelector("[data-speed]")||{}).innerText || "0"')
        .then((v) => speeds.push(Number(v) || 0))
        .catch(() => undefined);
    }, 250);

    try {
      if (idle) {
        await new Promise((r) => setTimeout(r, seconds * 1000));
      } else {
        await play(page, seconds * 1000);
      }
    } finally {
      clearInterval(sampler);
    }

    const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as unknown as {
      profile: { head: SampleNode };
    };
    await cdp.detach();

    const sites = new Map<string, Site>();
    flatten(profile.head, sites);
    const ranked = [...sites.values()].sort((a, b) => b.selfBytes - a.selfBytes);
    const totalAllocatedBytes = ranked.reduce((n, s) => n + s.selfBytes, 0);

    const frameMs = (await page.evaluate(
      'window.__obFrames || []',
    )) as number[];
    // Drop the first few: the profiler attaching is itself a hitch.
    const samples = frameMs.slice(5).sort((a, b) => a - b);

    const hud = (await page.evaluate(HUD_TEXT_SOURCE)) as string;

    return {
      map,
      seconds,
      idle,
      pointerLock: locked,
      frames: samples.length,
      frameMs: {
        p50: percentile(samples, 50),
        p90: percentile(samples, 90),
        p95: percentile(samples, 95),
        p99: percentile(samples, 99),
        max: samples[samples.length - 1] ?? 0,
      },
      // A 60Hz frame is 16.7ms. Anything past 20 dropped one.
      longFrames: samples.filter((v) => v > 20).length,
      totalAllocatedBytes,
      bytesPerFrame: samples.length ? totalAllocatedBytes / samples.length : 0,
      sites: ranked.slice(0, 30),
      hud,
      peakSpeed: speeds.length ? Math.max(...speeds) : 0,
      movingSamples: speeds.filter((v) => v > 40).length,
      speedSamples: speeds.length,
      problems: problems.slice(0, 10),
    };
  },
  // Headful is not a debugging convenience here, it is the only way to get a
  // meaningful frame-time distribution: headless Chrome throttles rAF to about
  // 10fps with no display attached, which makes every percentile an artifact
  // and also inflates `cpu` -- the fixed-timestep accumulator runs about twelve
  // 8ms physics ticks per 100ms frame callback instead of two.
  {
    headful: flag('headful'),
    /*
     * Chrome throttles a page it thinks nobody is watching, and a puppeteer
     * window counts as nobody: without these the rAF callback fires about ten
     * times a second, headless AND headful, which makes every frame-time
     * percentile an artifact and inflates `cpu` as well -- the fixed-timestep
     * accumulator runs about twelve 8ms physics ticks per 100ms frame callback
     * instead of two, and all twelve are charged to that one frame.
     */
    extraArgs: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
    ],
  });

  console.log(
    `\n${report.map}  ${report.seconds}s  ${report.idle ? 'idle' : 'playing'}` +
      `  pointerLock=${report.pointerLock}  frames=${report.frames}`,
  );
  if (!report.idle && !report.pointerLock) {
    console.log(
      '  WARNING: pointer lock was not acquired, so no input reached the game.\n' +
        '  These numbers are an idle profile wearing a playing label.',
    );
  }
  console.log(`  hud: ${report.hud}`);
  console.log(
    `  moved: peak ${report.peakSpeed.toFixed(0)}ups, ` +
      `${report.movingSamples}/${report.speedSamples} samples above walking pace`,
  );
  if (!report.idle && report.movingSamples === 0) {
    console.log(
      '  WARNING: the player never moved. Physics and collision are idle in\n' +
        '  this profile, so their absence from the ranking below means nothing.',
    );
  }

  const f = report.frameMs;
  console.log(
    `\nframe ms   p50 ${f.p50.toFixed(2)}   p90 ${f.p90.toFixed(2)}   ` +
      `p95 ${f.p95.toFixed(2)}   p99 ${f.p99.toFixed(2)}   max ${f.max.toFixed(2)}`,
  );
  console.log(
    `           ${report.longFrames} frame(s) over 20ms ` +
      `(${((report.longFrames / Math.max(1, report.frames)) * 100).toFixed(1)}%)`,
  );

  console.log(
    `\nallocated  ${kb(report.totalAllocatedBytes)} total, ` +
      `${report.bytesPerFrame.toFixed(0)} bytes/frame\n`,
  );
  console.log('top allocation sites (self bytes)');
  console.log(
    '  NOTE: Float32Array is invisible to this profiler, so nothing from ' +
      'src/physics, src/collision or src/math can appear below, however much ' +
      "it allocates. See this file's header, finding 1.",
  );
  for (const s of report.sites) {
    const share = (s.selfBytes / Math.max(1, report.totalAllocatedBytes)) * 100;
    console.log(`  ${kb(s.selfBytes).padStart(9)}  ${share.toFixed(1).padStart(5)}%  ${s.label}`);
  }

  if (report.problems.length) {
    console.log('\nproblems');
    for (const p of report.problems) {
      console.log(`  ${p}`);
    }
  }

  if (jsonOut) {
    writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nwrote ${jsonOut}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
