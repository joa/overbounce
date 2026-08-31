/**
 * Read a Chrome DevTools trace and say where the frame actually goes.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run trace -- refs/v8/Trace-20260831T135913.json
 *   npm run trace -- <file> --functions 60      # longer function ranking
 *   npm run trace -- <file> --worst 20          # more of the worst frames
 *
 * Capture the trace in Chrome's Performance panel with the **JS samples** and
 * **memory** boxes ticked, while actually playing. Then point this at the saved
 * `.json`.
 *
 * This is the instrument `npm run profile` could not be. That tool ranks
 * allocation, and V8's sampling heap profiler is blind to `Float32Array` — so
 * it cannot see anything `src/physics/` does (see
 * `.agent/docs/perf-gate-findings.md`, finding 8). A DevTools trace carries the
 * CPU sampling profile instead, which attributes *time* rather than *bytes* and
 * has no such blind spot. It also carries the GC events, which is the only way
 * to answer "are the spikes GC?" rather than inferring it.
 *
 * Three things it reports, in the order they usually matter:
 *
 *   self time by area     where the CPU goes, bucketed by source directory, with
 *                         idle excluded from the percentages. This is the
 *                         ranking to plan optimization work against.
 *   GC cost               main-thread blocking GC only. Background marking and
 *                         parallel scavenging run off-thread and do not stall a
 *                         frame, so counting them overstates the cost severalfold.
 *   the worst frames      each long rAF callback and how much blocking GC was
 *                         inside it. A long frame with no GC in it is not a GC
 *                         problem, however tempting the story.
 *
 * The file is typically 100-200MB, so it is streamed line by line rather than
 * parsed whole: DevTools writes one event per line, which makes that safe and
 * keeps the peak heap in the tens of megabytes.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: npm run trace -- <trace.json> [--functions N] [--worst N]');
  process.exit(1);
}
const topFunctions = Number(arg('functions', '30'));
const topWorst = Number(arg('worst', '12'));

/**
 * Main-thread, *blocking* GC.
 *
 * Deliberately excludes `V8.GC_MC_BACKGROUND_*` and
 * `V8.GC_SCAVENGER_BACKGROUND_*`: those run on helper threads and cost the frame
 * nothing. Including them roughly triples the apparent GC cost and is the
 * easiest way to talk yourself into a GC problem you do not have.
 */
const BLOCKING_GC = new Set([
  'MinorGC',
  'MajorGC',
  'V8.GCScavenger',
  'V8.GCFinalizeMC',
  'V8.GCIncrementalMarking',
  'V8.GCIncrementalMarkingStart',
  'V8.GCIncrementalMarkingFinalize',
]);

interface CallFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
}
interface ProfileNode {
  id: number;
  callFrame?: CallFrame;
}
interface TraceEvent {
  name?: string;
  cat?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  pid?: number;
  tid?: number;
  id?: string;
  args?: {
    data?: {
      cpuProfile?: { nodes?: ProfileNode[]; samples?: number[] };
      timeDeltas?: number[];
    };
  };
}

interface Span {
  ts: number;
  dur: number;
}

const raf: Span[] = [];
const gcSpans: (Span & { name: string })[] = [];
const gcByName = new Map<string, { n: number; us: number; max: number }>();
const nodes = new Map<number, ProfileNode>();
const samples: number[] = [];
const deltas: number[] = [];
let tsMin = Infinity;
let tsMax = -Infinity;

const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
for await (const rawLine of rl) {
  const line = rawLine.trim().replace(/,$/, '');
  if (line.length < 2 || line[0] !== '{' || line[line.length - 1] !== '}') {
    continue;
  }
  let e: TraceEvent;
  try {
    e = JSON.parse(line) as TraceEvent;
  } catch {
    continue;
  }

  if (typeof e.ts === 'number' && e.cat !== '__metadata') {
    if (e.ts < tsMin) tsMin = e.ts;
    if (e.ts > tsMax) tsMax = e.ts;
  }

  if (e.name === 'FireAnimationFrame' && typeof e.dur === 'number' && typeof e.ts === 'number') {
    raf.push({ ts: e.ts, dur: e.dur });
  } else if (
    e.name !== undefined &&
    BLOCKING_GC.has(e.name) &&
    typeof e.dur === 'number' &&
    typeof e.ts === 'number'
  ) {
    gcSpans.push({ ts: e.ts, dur: e.dur, name: e.name });
    const r = gcByName.get(e.name) ?? { n: 0, us: 0, max: 0 };
    r.n++;
    r.us += e.dur;
    r.max = Math.max(r.max, e.dur);
    gcByName.set(e.name, r);
  } else if (e.name === 'ProfileChunk') {
    const cp = e.args?.data?.cpuProfile;
    if (cp) {
      for (const n of cp.nodes ?? []) {
        nodes.set(n.id, n);
      }
      if (cp.samples) samples.push(...cp.samples);
      const td = e.args?.data?.timeDeltas;
      if (td) deltas.push(...td);
    }
  }
}

const spanMs = (tsMax - tsMin) / 1000;
const ms = (us: number): string => (us / 1000).toFixed(0);

/* ------------------------------------------------------------------- frames */

raf.sort((a, b) => a.ts - b.ts);
const durs = raf.map((r) => r.dur / 1000).sort((a, b) => a - b);
const gaps: number[] = [];
for (let i = 1; i < raf.length; i++) {
  gaps.push((raf[i].ts - raf[i - 1].ts) / 1000);
}
gaps.sort((a, b) => a - b);
const pct = (xs: readonly number[], p: number): number =>
  xs[Math.min(xs.length - 1, Math.max(0, Math.round((p / 100) * xs.length) - 1))] ?? 0;
const line = (label: string, xs: readonly number[]): string =>
  `  ${label.padEnd(20)} p50 ${pct(xs, 50).toFixed(2).padStart(7)}  ` +
  `p90 ${pct(xs, 90).toFixed(2).padStart(7)}  p95 ${pct(xs, 95).toFixed(2).padStart(7)}  ` +
  `p99 ${pct(xs, 99).toFixed(2).padStart(7)}  max ${pct(xs, 100).toFixed(2).padStart(8)}`;

console.log(`\ntrace span ${(spanMs / 1000).toFixed(1)}s, ${raf.length} animation frames\n`);
console.log(line('callback ms', durs));
console.log(line('frame interval ms', gaps));
console.log(
  `  intervals over 20ms  ${gaps.filter((g) => g > 20).length} of ${gaps.length}` +
    `   over 33ms  ${gaps.filter((g) => g > 33).length}`,
);

/* ------------------------------------------------------------ cpu self time */

if (samples.length > 0) {
  const selfUs = new Map<number, number>();
  let busyUs = 0;
  let idleUs = 0;
  for (let i = 0; i < samples.length; i++) {
    const d = deltas[i] ?? 0;
    // Negative or absurd deltas appear at chunk boundaries; they are not time
    // anyone spent.
    if (d <= 0 || d > 100_000) {
      continue;
    }
    selfUs.set(samples[i], (selfUs.get(samples[i]) ?? 0) + d);
  }

  const byArea = new Map<string, number>();
  const byFunction = new Map<string, number>();
  for (const [id, us] of selfUs) {
    const f = nodes.get(id)?.callFrame ?? {};
    const name = f.functionName || '(anonymous)';
    const url = (f.url ?? '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');

    if (name === '(idle)') {
      idleUs += us;
      continue;
    }
    busyUs += us;

    const where = url ? `:${(f.lineNumber ?? 0) + 1}` : '';
    byFunction.set(`${name} — ${url}${where}`, (byFunction.get(`${name} — ${url}${where}`) ?? 0) + us);

    let area: string;
    if (!url) {
      area = name === '(program)' || name === '(garbage collector)' ? `(vm) ${name}` : '(vm) WebGPU/other';
    } else if (url.includes('node_modules')) {
      area = 'three.js';
    } else if (url.startsWith('src/')) {
      const parts = url.split('/');
      area = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : url;
    } else {
      area = url;
    }
    byArea.set(area, (byArea.get(area) ?? 0) + us);
  }

  console.log(
    `\ncpu: ${(busyUs / 1e6).toFixed(1)}s busy, ${(idleUs / 1e6).toFixed(1)}s idle. ` +
      `Percentages below are of BUSY time — idle is excluded, because a share of\n` +
      `     wall clock says more about the frame rate cap than about the code.\n`,
  );
  console.log('self time by area:');
  for (const [k, us] of [...byArea.entries()].sort((a, b) => b[1] - a[1])) {
    if (us / busyUs < 0.001) continue;
    console.log(`  ${ms(us).padStart(8)}ms  ${((us / busyUs) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }

  console.log(`\nself time by function (top ${topFunctions}):`);
  for (const [k, us] of [...byFunction.entries()].sort((a, b) => b[1] - a[1]).slice(0, topFunctions)) {
    console.log(`  ${ms(us).padStart(8)}ms  ${((us / busyUs) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
}

/* ----------------------------------------------------------------------- gc */

const gcUs = [...gcByName.values()].reduce((n, r) => n + r.us, 0);
const callbackUs = raf.reduce((n, r) => n + r.dur, 0);

console.log(`\nmain-thread blocking GC (background/parallel GC excluded — see the header):`);
for (const [name, r] of [...gcByName.entries()].sort((a, b) => b[1].us - a[1].us)) {
  console.log(
    `  ${name.padEnd(30)} n=${String(r.n).padStart(5)}  ${ms(r.us).padStart(6)}ms  ` +
      `avg ${(r.us / r.n / 1000).toFixed(2)}ms  max ${(r.max / 1000).toFixed(2)}ms`,
  );
}
console.log(
  `  ${'TOTAL'.padEnd(30)}          ${ms(gcUs).padStart(6)}ms  ` +
    `= ${((gcUs / 1000 / spanMs) * 100).toFixed(2)}% of wall, ` +
    `${((gcUs / callbackUs) * 100).toFixed(2)}% of time inside the frame callback`,
);

/* -------------------------------------------------------------- worst frames */

console.log(`\nworst ${topWorst} frames, and how much blocking GC was inside each:`);
const worst = [...raf].sort((a, b) => b.dur - a.dur).slice(0, topWorst);
for (const f of worst) {
  const inside = gcSpans.filter((g) => g.ts >= f.ts && g.ts + g.dur <= f.ts + f.dur);
  const insideUs = inside.reduce((n, g) => n + g.dur, 0);
  const kinds = [...new Set(inside.map((g) => g.name))].join(', ');
  console.log(
    `  ${(f.dur / 1000).toFixed(1).padStart(8)}ms   ` +
      (inside.length
        ? `gc ${(insideUs / 1000).toFixed(1)}ms (${((insideUs / f.dur) * 100).toFixed(0)}%)  ${kinds}`
        : 'gc none'),
  );
}
const noGc = worst.filter(
  (f) => !gcSpans.some((g) => g.ts >= f.ts && g.ts + g.dur <= f.ts + f.dur),
).length;
console.log(
  `\n  ${noGc} of the worst ${worst.length} frames contain no blocking GC at all.` +
    (noGc > worst.length / 3
      ? '\n  A long frame with no GC in it is not a GC problem, however tempting the story.'
      : ''),
);
