/**
 * Run results (`Ra`/`Rb`/`Rc`).
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Reached from FINISHED (R5: after 2s, or immediately on Enter) rather than
 * built into the HUD -- like `title.ts`, this is its own full-bleed screen,
 * not the rail/shell layout, per `design/HANDOFF.md`. "This run" (`Ra`'s
 * layout, with `Rb`'s alternate headers for a slower run or a cheat run) and
 * "Career" (`Rc`) are the same screen's two tabs, not two screens -- `Rc`'s
 * own header shows both tab labels, one active.
 *
 * `design/refs/backdrop.png` is NOT used here. `title.ts` already decided
 * this project's full-bleed screens get the flat `--ob-background` instead
 * of a blurred photo behind them -- there, because no map is loaded yet to
 * render one; here, for consistency with that choice rather than a second,
 * different rule.
 *
 * ## What this deliberately does not draw
 *
 * Per `.agent/plans/UI.md`'s Phase 4 gaps, carried forward rather than
 * invented here:
 *   - The OB marker on the speed trace, and `obHits` generally -- needs a
 *     live landing-event detector that does not exist.
 *   - AIRBORNE% and STRAFE GAIN% -- need a clean/lossy strafe classifier and
 *     a running airborne-time fraction, neither built.
 *   - "ghost beaten by" -- needs a live position-matched ghost delta,
 *     `hud.ts`'s own header note says the same thing is missing there.
 *   - "Race this ghost" (ghost racing is already automatic, there is no
 *     manual picker to route to) and "Watch replay" (no replay viewer
 *     exists) render disabled, matching PAUSED's "All settings" precedent.
 *   - "Run clean" (Rb's cheat card) would need a param-stripping reload,
 *     which drops the mounted `.pk3` File handles `appFlow` depends on --
 *     a UX cliff, not a button. Disabled, same precedent.
 */

import { formatTime, formatDelta } from '../../render/hud.js';
import type { RunRecord, MapRecord } from '../../game/records.js';

export type ResultsChoice = 'run-again' | 'exit';

/** Why this run was not recorded, when it was not. */
export type NotRecordedReason = 'cheats' | 'voided';

export interface ResultsData {
  mapName: string;
  physics: 'vq3' | 'cpm';
  attempt: number;
  /** Present and false for a completed, TIMED, non-cheat run. */
  notRecorded: NotRecordedReason | null;
  time: number;
  splits: number[];
  /** This run's own downsampled trace -- NOT `career.best.speedSeries`,
   *  which is the record run's trace and would be the wrong run's data on
   *  anything but a PB. */
  speedSeries: number[];
  avgSpeed: number;
  topSpeed: number;
  improved: boolean;
  /** The record as it stood BEFORE this run -- same "stash before write"
   *  pattern as the HUD's own `finishedAgainst`. */
  prevBest: RunRecord | null;
  /** Sum-of-best as it stood BEFORE this run -- a COPY, not the live
   *  `MapRecord` reference, which `runEnded` already mutated by the time
   *  this screen reads it. See `main.ts`'s own comment at the call site. */
  prevSumOfBest: number[];
  /** Read AFTER `runEnded` -- null only when `notRecorded` is set, since an
   *  unrecorded run never touches the book. */
  career: MapRecord | null;
}

const STYLE = `
.ob-results { position:fixed; inset:0; z-index:6; background:var(--ob-background);
  color:var(--ob-text); font-family:var(--ob-font-display); display:flex; flex-direction:column;
  overflow:hidden; }
.ob-res-bar { height:54px; flex:none; display:flex; align-items:center; justify-content:space-between;
  padding:0 28px; border-bottom:1px solid var(--ob-seam); }
.ob-res-tabs { display:flex; align-items:baseline; gap:20px; }
.ob-res-tab { font:600 15px/1 var(--ob-font-display); letter-spacing:.16em; text-transform:uppercase;
  color:var(--ob-dim); cursor:pointer; padding-bottom:4px; background:none; border:none; }
.ob-res-tab.active { color:var(--ob-text); border-bottom:2px solid var(--ob-accent); }
.ob-res-id { font:400 11px/1 var(--ob-font-mono); letter-spacing:.1em; color:var(--ob-dim); }

.ob-res-body { flex:1; min-height:0; overflow:auto; padding:24px 28px; }
.ob-res-foot { flex:none; padding:16px 28px; border-top:1px solid var(--ob-seam);
  display:flex; gap:10px; }
.ob-res-btn { padding:12px 20px; border-radius:5px; font:600 15px/1 var(--ob-font-display);
  letter-spacing:.12em; text-transform:uppercase; cursor:pointer; }
.ob-res-btn.primary { border:1px solid var(--ob-accent); background:rgba(232,98,42,.18); color:var(--ob-text); }
.ob-res-btn.ghost { border:1px solid var(--ob-control); background:transparent; font-weight:400;
  color:var(--ob-text-secondary); }
.ob-res-btn:disabled { color:var(--ob-unavailable); cursor:default; border-color:var(--ob-seam); }

.ob-res-kicker { font:400 11px/1 var(--ob-font-mono); letter-spacing:.32em; }
.ob-res-time { margin-top:12px; font:600 96px/.84 var(--ob-font-display); letter-spacing:-.03em;
  font-variant-numeric:tabular-nums; }
.ob-res-pills { margin-top:14px; display:flex; gap:8px; flex-wrap:wrap; }
.ob-res-pill { padding:5px 10px; border-radius:3px; font:400 12px/1 var(--ob-font-mono); }

.ob-res-grid { display:grid; grid-template-columns:24px 1fr auto auto; column-gap:14px;
  font:400 12px/1 var(--ob-font-mono); font-variant-numeric:tabular-nums; }
.ob-res-grid .hd { letter-spacing:.14em; color:var(--ob-dim); padding-bottom:8px;
  border-bottom:1px solid var(--ob-seam); }
.ob-res-grid .row > span { padding-top:9px; }

.ob-res-sob { margin-top:16px; padding-top:14px; border-top:1px solid var(--ob-seam);
  display:flex; align-items:baseline; justify-content:space-between; }
.ob-res-sob .label { font:400 11px/1 var(--ob-font-mono); letter-spacing:.14em; color:var(--ob-dim); }
.ob-res-sob .value { font:600 28px/1 var(--ob-font-display); font-variant-numeric:tabular-nums; color:#62d0ff; }

.ob-res-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--ob-seam);
  border:1px solid var(--ob-seam); border-radius:4px; overflow:hidden; }
.ob-res-stats.wide { grid-template-columns:repeat(6,1fr); }
.ob-res-stat { padding:14px 16px; background:var(--ob-panel); }
.ob-res-stat .k { font:400 9px/1 var(--ob-font-mono); letter-spacing:.16em; color:var(--ob-dim); }
.ob-res-stat .v { margin-top:8px; font:600 30px/1 var(--ob-font-display); font-variant-numeric:tabular-nums; }
.ob-res-stat .v.unavail { color:var(--ob-unavailable); font-size:22px; }

.ob-res-trace { margin-top:14px; position:relative; height:150px; }
.ob-res-trace svg { display:block; width:100%; height:100%; }
.ob-res-empty { padding:24px; text-align:center; color:var(--ob-dim); font-size:13px; }

.ob-res-practice { max-width:560px; }
.ob-res-practice .card { padding:20px 22px; border-radius:5px; background:var(--ob-panel);
  border:1px solid rgba(255,209,102,.32); border-left:3px solid #ffd166; }
.ob-res-practice h2 { margin:12px 0 0; font:600 36px/1 var(--ob-font-display); letter-spacing:.02em;
  text-transform:uppercase; color:var(--ob-dim); }
.ob-res-practice p { margin:12px 0 0; font:400 13px/1.45 var(--ob-font-display); letter-spacing:.03em;
  color:var(--ob-text-secondary); max-width:60ch; }

.ob-res-completion { display:flex; gap:2px; height:8px; border-radius:1px; overflow:hidden; }
`;

let styleInstalled = false;
function installStyle(): void {
  if (styleInstalled) {
    return;
  }
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  styleInstalled = true;
}

function speedColor(ups: number): string {
  return ups < 320 ? '#e8e8ec' : ups < 500 ? '#7ee081' : ups < 800 ? '#ffd166' : ups < 1200 ? '#ff9f45' : '#ff6b6b';
}

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

function statCell(key: string, value: string, color?: string, unavail = false): HTMLElement {
  const cell = el('div', 'ob-res-stat');
  const k = el('div', 'k');
  k.textContent = key;
  const v = el('div', unavail ? 'v unavail' : 'v');
  v.textContent = value;
  if (color) {
    v.style.color = color;
  }
  cell.append(k, v);
  return cell;
}

/** A trace SVG for one speed series, 0..max(series,320)*1.15 vertical range -- the same
 *  headroom rule `hud.ts`'s live trace uses, so a results trace and a HUD trace read the
 *  same way. */
function drawTrace(series: readonly number[]): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 700 120');
  svg.setAttribute('preserveAspectRatio', 'none');

  const top = Math.max(320, ...series, 1) * 1.15;
  const y = (v: number): number => 120 * (1 - v / top);
  const capY = y(320);

  const cap = document.createElementNS(NS, 'line');
  cap.setAttribute('x1', '0');
  cap.setAttribute('x2', '700');
  cap.setAttribute('y1', String(capY));
  cap.setAttribute('y2', String(capY));
  cap.setAttribute('stroke', '#3a3a46');
  cap.setAttribute('stroke-dasharray', '5 7');
  svg.appendChild(cap);

  if (series.length > 1) {
    const points = series
      .map((v, i) => `${(i / (series.length - 1)) * 700},${y(v)}`)
      .join(' ');
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', points);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#ffd166');
    line.setAttribute('stroke-width', '2.5');
    line.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(line);
  }
  return svg;
}

/**
 * Peak/average vs cumulative time-on-map, with hour ticks and the two
 * current values labelled -- callers gate `runs.length >= 2` themselves and
 * show a placeholder instead below that. The y-axis floors at the lower of
 * `320` (the ground cap, always drawn as a reference) and the data's own
 * minimum: a career whose average has always been well above 320 gets the
 * headroom that variation actually needs instead of wasting most of the
 * chart on an empty 0-320 band nothing ever visits.
 */
function drawCareerCurve(runs: readonly { avgSpeed: number; topSpeed: number; atMs: number }[]): HTMLElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 1000 240');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.display = 'block';
  svg.style.width = '100%';
  svg.style.height = '100%';

  const top = Math.max(320, ...runs.map((r) => r.topSpeed), 1) * 1.08;
  const bottom = Math.min(320, ...runs.map((r) => r.avgSpeed)) * 0.9;
  const maxMs = Math.max(...runs.map((r) => r.atMs), 1);
  const x = (ms: number): number => (ms / maxMs) * 1000;
  const y = (v: number): number => 240 * (1 - (v - bottom) / (top - bottom));

  const capY = y(320);
  const cap = document.createElementNS(NS, 'line');
  cap.setAttribute('x1', '0');
  cap.setAttribute('x2', '1000');
  cap.setAttribute('y1', String(capY));
  cap.setAttribute('y2', String(capY));
  cap.setAttribute('stroke', '#3a3a46');
  cap.setAttribute('stroke-dasharray', '5 7');
  svg.appendChild(cap);

  const line = (color: string, values: readonly number[]): void => {
    const points = runs.map((r, i) => `${x(r.atMs)},${y(values[i])}`).join(' ');
    const p = document.createElementNS(NS, 'polyline');
    p.setAttribute('points', points);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', color);
    p.setAttribute('stroke-width', '2.5');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
  };
  line(
    '#ffd166',
    runs.map((r) => r.topSpeed),
  );
  line(
    '#7ee081',
    runs.map((r) => r.avgSpeed),
  );

  const wrap = el('div');
  wrap.style.position = 'relative';
  wrap.style.height = '100%';
  wrap.appendChild(svg);

  const label = (text: string, color: string, topPct: number, side: 'left' | 'right'): void => {
    const s = document.createElement('span');
    s.style.position = 'absolute';
    s.style[side] = '0';
    s.style.top = `${topPct}%`;
    s.style.transform = 'translateY(-100%)';
    s.style.font = '400 10px/1 var(--ob-font-mono)';
    s.style.color = color;
    s.textContent = text;
    wrap.appendChild(s);
  };
  const last = runs[runs.length - 1];
  label(String(Math.round(last.topSpeed)), '#ffd166', (y(last.topSpeed) / 240) * 100, 'right');
  label(String(Math.round(last.avgSpeed)), '#7ee081', (y(last.avgSpeed) / 240) * 100, 'right');

  const axis = el('div');
  axis.style.position = 'absolute';
  axis.style.left = '0';
  axis.style.right = '0';
  axis.style.bottom = '-18px';
  axis.style.height = '14px';
  axis.style.font = '400 10px/1 var(--ob-font-mono)';
  axis.style.color = 'var(--ob-dim)';
  const totalHours = maxMs / 3600000;
  const hourStep = totalHours > 6 ? 2 : 1;
  for (let h = 0; h * hourStep < totalHours; h++) {
    const hm = h * hourStep;
    const tick = document.createElement('span');
    tick.style.position = 'absolute';
    tick.style.left = `${(hm / totalHours) * 100}%`;
    tick.style.transform = hm === 0 ? 'none' : 'translateX(-50%)';
    tick.textContent = `${hm}h`;
    axis.appendChild(tick);
  }
  const endTick = document.createElement('span');
  endTick.style.position = 'absolute';
  endTick.style.right = '0';
  endTick.textContent = formatHM(maxMs);
  axis.appendChild(endTick);
  wrap.appendChild(axis);

  return wrap;
}

function formatHM(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatSinceDate(iso: string): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '—';
  }
  return `SINCE ${d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }).toUpperCase()}`;
}

export function showResultsScreen(parent: HTMLElement, data: ResultsData): Promise<ResultsChoice> {
  installStyle();

  const root = el('div', 'ob-results');
  parent.appendChild(root);

  let tab: 'run' | 'career' = 'run';

  const bar = el('div', 'ob-res-bar');
  const tabs = el('div', 'ob-res-tabs');
  const runTab = document.createElement('button');
  runTab.type = 'button';
  runTab.className = 'ob-res-tab';
  runTab.textContent = 'This run';
  const careerTab = document.createElement('button');
  careerTab.type = 'button';
  careerTab.className = 'ob-res-tab';
  careerTab.textContent = 'Career';
  tabs.append(runTab, careerTab);
  const idLine = el('div', 'ob-res-id');
  bar.append(tabs, idLine);

  const body = el('div', 'ob-res-body');
  const foot = el('div', 'ob-res-foot');
  root.append(bar, body, foot);

  const controller = new AbortController();

  return new Promise((resolve) => {
    const finish = (choice: ResultsChoice): void => {
      controller.abort();
      root.remove();
      resolve(choice);
    };

    const renderThisRun = (): void => {
      body.innerHTML = '';
      idLine.textContent =
        `${data.mapName.toUpperCase()} · ${data.physics.toUpperCase()} · ATTEMPT ${data.attempt}`;

      if (data.notRecorded) {
        const wrap = el('div', 'ob-res-practice');
        const kicker = el('div', 'ob-res-kicker');
        kicker.style.color = '#ffd166';
        kicker.textContent = data.notRecorded === 'cheats' ? 'CHEATS ACTIVE — NOTHING IS TIMED' : 'ATTEMPT DISCARDED — NOTHING IS TIMED';
        const card = el('div', 'card');
        const label = el('div', 'ob-res-kicker');
        label.style.color = '#ffd166';
        label.textContent = 'TIMER OFF';
        const h2 = el('h2');
        h2.textContent = 'Practice mode';
        const p = el('p');
        p.textContent =
          data.notRecorded === 'cheats'
            ? 'A cheat is active, so the clock never started and no ghost was saved. Run as long as you like; nothing here is recorded.'
            : 'This attempt paused earlier, which costs it the same way dying does — the clock stopped there and nothing about the rest of this run was recorded.';
        card.append(label, h2, p);
        wrap.append(kicker, card);
        body.appendChild(wrap);
        return;
      }

      const header = el('div');
      const kicker = el('div', 'ob-res-kicker');
      const time = el('div', 'ob-res-time');
      time.textContent = formatTime(data.time);
      const pills = el('div', 'ob-res-pills');

      if (data.improved) {
        kicker.textContent = 'PERSONAL BEST';
        kicker.style.color = '#ffd166';
        time.style.color = '#ffd166';
        if (data.prevBest) {
          const delta = el('span', 'ob-res-pill');
          delta.style.background = 'rgba(126,224,129,.16)';
          delta.style.color = '#7ee081';
          delta.style.fontWeight = '700';
          delta.textContent = formatDelta(data.time - data.prevBest.time);
          const old = el('span', 'ob-res-pill');
          old.style.border = '1px solid var(--ob-control)';
          old.style.color = 'var(--ob-dim)';
          old.textContent = `old ${formatTime(data.prevBest.time)}`;
          pills.append(delta, old);
        }
      } else {
        kicker.textContent = 'FINISHED';
        kicker.style.color = 'var(--ob-dim)';
        if (data.prevBest) {
          const delta = el('span', 'ob-res-pill');
          delta.style.background = 'rgba(255,107,107,.14)';
          delta.style.color = '#ff6b6b';
          delta.style.fontWeight = '700';
          delta.textContent = formatDelta(data.time - data.prevBest.time);
          const kept = el('span', 'ob-res-pill');
          kept.style.border = '1px solid var(--ob-control)';
          kept.style.color = 'var(--ob-dim)';
          kept.textContent = `pb ${formatTime(data.prevBest.time)} kept`;
          pills.append(delta, kept);
        }
        // The first segment this run tied or beat the standing sum-of-best
        // for, if any. `prevSumOfBest` is BEFORE this run's write, so this
        // reads "did this run improve on history", not "did it improve on
        // itself" (every segment of the run that just wrote it would
        // trivially qualify against the post-write numbers).
        //
        // Only meaningful when this run's own shape matches the shape
        // `prevSumOfBest` was built from -- `records.runEnded` now leaves
        // sum-of-best alone (does not rebuild it) whenever a run's splits
        // don't line up positionally with stored history, specifically so
        // this comparison is never done against data from a different route
        // through the checkpoints (a skip, or a re-touch). Comparing
        // position `i` across two different shapes is exactly the bug that
        // made a worse run's OWN segment read as "a best segment".
        if (data.splits.length === data.prevSumOfBest.length) {
          let prevCum = 0;
          for (let i = 0; i < data.splits.length; i++) {
            const seg = data.splits[i] - prevCum;
            prevCum = data.splits[i];
            if (data.prevSumOfBest[i] !== undefined && seg <= data.prevSumOfBest[i]) {
              const badge = el('span', 'ob-res-pill');
              badge.style.border = '1px solid var(--ob-control)';
              badge.style.color = '#7ee081';
              badge.textContent = `cp${i + 1} was a best segment`;
              pills.append(badge);
              break;
            }
          }
        }
      }
      header.append(kicker, time, pills);
      body.appendChild(header);

      // ---- splits ----
      if (data.splits.length) {
        const gridWrap = el('div');
        gridWrap.style.marginTop = '30px';
        gridWrap.style.maxWidth = '420px';
        const grid = el('div', 'ob-res-grid');
        for (const h of ['', 'SEGMENT', 'SPLIT', 'Δ PB']) {
          const hd = el('span', 'hd');
          hd.textContent = h;
          grid.appendChild(hd);
        }
        // A positional Δ PB only means anything when the PB run touched the
        // same checkpoints in the same order as this one -- otherwise row
        // `i` on one side and row `i` on the other are different legs of the
        // course entirely (this run's finish leg compared against the PB's
        // cp3-to-cp4 leg, say), which is exactly what made a slower run's
        // last segment show a wildly wrong delta instead of a dash. Same
        // shape-check `records.runEnded` now uses to decide whether a run's
        // splits are even eligible to update sum-of-best.
        const pbShapeMatches = data.prevBest?.splits.length === data.splits.length;
        let prevCum = 0;
        for (let i = 0; i < data.splits.length; i++) {
          const cum = data.splits[i];
          const seg = cum - prevCum;
          const num = el('span');
          num.style.color = 'var(--ob-dim)';
          num.textContent = String(i + 1);
          const name = el('span');
          name.style.color = 'var(--ob-text-secondary)';
          // `data.splits` always ends with the finish leg now (`Course`
          // pushes it alongside `target_stopTimer`, not just checkpoints),
          // so the last row is never "→ cp(N+1)" -- there is no cp(N+1).
          const isLast = i === data.splits.length - 1;
          name.textContent = isLast
            ? i === 0
              ? 'start → finish'
              : `cp${i} → finish`
            : i === 0
              ? 'start → cp1'
              : `cp${i} → cp${i + 1}`;
          const val = el('span');
          val.style.textAlign = 'right';
          val.style.color = 'var(--ob-text)';
          val.textContent = formatTime(seg);
          const delta = el('span');
          delta.style.textAlign = 'right';
          const prev = pbShapeMatches ? data.prevBest?.splits[i] : undefined;
          if (prev !== undefined) {
            const d = cum - prev;
            delta.style.color = d < 0 ? '#7ee081' : '#ff6b6b';
            delta.textContent = formatDelta(d);
          } else {
            delta.style.color = 'var(--ob-unavailable)';
            delta.textContent = '—';
          }
          grid.append(num, name, val, delta);
          prevCum = cum;
        }
        gridWrap.appendChild(grid);

        if (data.career) {
          const sumTotal = data.career.sumOfBest.reduce((a, b) => a + b, 0);
          const best = data.career.best?.time ?? data.time;
          const sob = el('div', 'ob-res-sob');
          const label = el('span', 'label');
          label.textContent = 'SUM OF BEST SEGMENTS';
          const value = el('span');
          value.style.display = 'flex';
          value.style.gap = '9px';
          value.style.alignItems = 'baseline';
          const big = el('span', 'value');
          big.textContent = formatTime(sumTotal);
          value.appendChild(big);
          // Only means something once there is a second data point to have
          // diverged from -- on this run's own first-ever completion,
          // sum-of-best is seeded from these exact splits, so `available`
          // would always read a meaningless "+0.00" here.
          if (data.career.counters.completed > 1) {
            const avail = el('span');
            avail.style.font = '400 11px/1 var(--ob-font-mono)';
            avail.style.color = 'var(--ob-dim)';
            avail.textContent = `${formatDelta(sumTotal - best)} available`;
            value.appendChild(avail);
          }
          sob.append(label, value);
          gridWrap.appendChild(sob);
        }
        body.appendChild(gridWrap);
      }

      // ---- trace + speed stats ----
      const traceWrap = el('div');
      traceWrap.style.marginTop = '30px';
      traceWrap.style.maxWidth = '700px';
      const traceLabel = el('div');
      traceLabel.style.font = '400 11px/1 var(--ob-font-mono)';
      traceLabel.style.letterSpacing = '.2em';
      traceLabel.style.color = 'var(--ob-dim)';
      traceLabel.textContent = 'SPEED OVER THE WHOLE RUN';
      const trace = el('div', 'ob-res-trace');
      trace.appendChild(drawTrace(data.speedSeries));
      traceWrap.append(traceLabel, trace);
      body.appendChild(traceWrap);

      const stats = el('div', 'ob-res-stats');
      stats.style.marginTop = '20px';
      stats.style.maxWidth = '700px';
      stats.appendChild(statCell('TOP SPEED', String(Math.round(data.topSpeed)), speedColor(data.topSpeed)));
      stats.appendChild(statCell('AVERAGE', String(Math.round(data.avgSpeed)), speedColor(data.avgSpeed)));
      stats.appendChild(statCell('AIRBORNE', '—', undefined, true));
      stats.appendChild(statCell('STRAFE GAIN', '—', undefined, true));
      body.appendChild(stats);

      // ---- mini career strip ----
      if (data.career) {
        const c = data.career;
        const strip = el('div');
        strip.style.marginTop = '22px';
        strip.style.maxWidth = '700px';
        const stripLabel = el('div');
        stripLabel.style.font = '400 11px/1 var(--ob-font-mono)';
        stripLabel.style.letterSpacing = '.2em';
        stripLabel.style.color = 'var(--ob-dim)';
        stripLabel.textContent = 'CAREER ON THIS MAP';
        const stripStats = el('div', 'ob-res-stats');
        stripStats.style.marginTop = '14px';
        const pct = c.counters.started ? Math.round((c.counters.completed / c.counters.started) * 100) : 0;
        stripStats.appendChild(statCell('RUNS STARTED', String(c.counters.started)));
        stripStats.appendChild(statCell('COMPLETED', `${c.counters.completed} · ${pct}%`, '#7ee081'));
        stripStats.appendChild(statCell('TIME ON MAP', formatHM(c.timeOnMapMs)));
        const highest = c.recentRuns.length ? Math.max(...c.recentRuns.map((r) => r.topSpeed)) : 0;
        stripStats.appendChild(statCell('HIGHEST UPS', String(Math.round(highest)), '#ffd166'));
        strip.append(stripLabel, stripStats);
        body.appendChild(strip);
      }
    };

    const renderCareer = (): void => {
      body.innerHTML = '';
      idLine.textContent = `${data.mapName.toUpperCase()} · ${data.physics.toUpperCase()}`;

      const c = data.career;
      if (!c) {
        const empty = el('div', 'ob-res-empty');
        empty.textContent = 'Nothing recorded on this map yet.';
        body.appendChild(empty);
        return;
      }

      const grid = el('div', 'ob-res-stats wide');
      const pct = c.counters.started ? Math.round((c.counters.completed / c.counters.started) * 100) : 0;
      grid.appendChild(statCell('RUNS STARTED', String(c.counters.started)));
      grid.appendChild(statCell('COMPLETED', `${c.counters.completed} · ${pct}%`, '#7ee081'));
      const highest = c.recentRuns.length ? Math.max(...c.recentRuns.map((r) => r.topSpeed)) : 0;
      grid.appendChild(statCell('HIGHEST UPS', String(Math.round(highest)), '#ffd166'));
      const avgAll = c.recentRuns.length
        ? c.recentRuns.reduce((a, r) => a + r.avgSpeed, 0) / c.recentRuns.length
        : 0;
      grid.appendChild(statCell('AVERAGE UPS', String(Math.round(avgAll))));
      const last10 = c.recentRuns.slice(-10);
      const last10Avg = last10.length ? last10.reduce((a, r) => a + r.avgSpeed, 0) / last10.length : 0;
      const delta = last10.length && c.recentRuns.length ? last10Avg - avgAll : 0;
      grid.appendChild(
        statCell(
          'AVG UPS · LAST 10',
          last10.length ? `${Math.round(last10Avg)} ${last10.length >= c.recentRuns.length ? '' : formatUpsDelta(delta)}`.trim() : '—',
          '#7ee081',
          !last10.length,
        ),
      );
      grid.appendChild(statCell('TIME ON MAP', formatHM(c.timeOnMapMs)));
      body.appendChild(grid);

      const sinceLine = el('div');
      sinceLine.style.marginTop = '8px';
      sinceLine.style.textAlign = 'right';
      sinceLine.style.font = '400 10px/1 var(--ob-font-mono)';
      sinceLine.style.letterSpacing = '.1em';
      sinceLine.style.color = 'var(--ob-unavailable)';
      sinceLine.textContent = formatSinceDate(c.firstSeen);
      body.appendChild(sinceLine);

      // ---- speed-per-hour curve ----
      const curveWrap = el('div');
      curveWrap.style.marginTop = '24px';
      const curveLabel = el('div');
      curveLabel.style.font = '400 11px/1 var(--ob-font-mono)';
      curveLabel.style.letterSpacing = '.2em';
      curveLabel.style.color = 'var(--ob-dim)';
      curveLabel.textContent = 'SPEED PER HOUR PLAYED';
      curveWrap.appendChild(curveLabel);

      if (c.recentRuns.length >= 2) {
        const curve = el('div');
        curve.style.marginTop = '14px';
        curve.style.height = '220px';
        curve.appendChild(drawCareerCurve(c.recentRuns));
        curveWrap.appendChild(curve);
      } else {
        const placeholder = el('div', 'ob-res-empty');
        placeholder.textContent =
          c.recentRuns.length === 1
            ? 'One completed run so far — the curve needs at least two to show a trend.'
            : 'No completed runs yet.';
        curveWrap.appendChild(placeholder);
      }
      body.appendChild(curveWrap);

      // ---- completion bar ----
      const total = c.counters.completed + c.counters.died + c.counters.restarted;
      if (total > 0) {
        const compWrap = el('div');
        compWrap.style.marginTop = '20px';
        compWrap.style.maxWidth = '300px';
        const compLabel = el('div');
        compLabel.style.font = '400 9px/1 var(--ob-font-mono)';
        compLabel.style.letterSpacing = '.16em';
        compLabel.style.color = 'var(--ob-dim)';
        compLabel.textContent = 'COMPLETION';
        const bar = el('div', 'ob-res-completion');
        bar.style.marginTop = '10px';
        const seg = (n: number, color: string): void => {
          if (n <= 0) {
            return;
          }
          const s = document.createElement('div');
          s.style.flex = String(n);
          s.style.background = color;
          bar.appendChild(s);
        };
        seg(c.counters.completed, '#7ee081');
        seg(c.counters.died, '#ff6b6b');
        seg(c.counters.restarted, '#2a2a34');
        const legend = el('div');
        legend.style.marginTop = '10px';
        legend.style.display = 'flex';
        legend.style.flexDirection = 'column';
        legend.style.gap = '6px';
        legend.style.font = '400 11px/1 var(--ob-font-mono)';
        legend.style.color = 'var(--ob-dim)';
        for (const [label, n, color] of [
          ['finished', c.counters.completed, '#7ee081'],
          ['died', c.counters.died, '#ff6b6b'],
          ['restarted', c.counters.restarted, 'var(--ob-dim)'],
        ] as const) {
          const row = el('div');
          row.style.display = 'flex';
          row.style.justifyContent = 'space-between';
          const l = document.createElement('span');
          l.style.color = color;
          l.textContent = label;
          const v = document.createElement('span');
          v.style.color = 'var(--ob-text)';
          v.textContent = String(n);
          row.append(l, v);
          legend.appendChild(row);
        }
        compWrap.append(compLabel, bar, legend);
        body.appendChild(compWrap);
      }

      // ---- narrative, only with enough sample to say anything real ----
      if (c.recentRuns.length >= 10) {
        const note = el('div');
        note.style.marginTop = '18px';
        note.style.maxWidth = '640px';
        note.style.font = '400 13px/1.45 var(--ob-font-display)';
        note.style.color = 'var(--ob-text-secondary)';
        const sign = delta >= 0 ? 'above' : 'below';
        note.textContent = `Your last 10 runs average ${Math.round(Math.abs(delta))} ups ${sign} your all-time average.`;
        body.appendChild(note);
      }
    };

    const setTab = (next: 'run' | 'career'): void => {
      tab = next;
      runTab.classList.toggle('active', tab === 'run');
      careerTab.classList.toggle('active', tab === 'career');
      if (tab === 'run') {
        renderThisRun();
      } else {
        renderCareer();
      }
    };
    runTab.addEventListener('click', () => setTab('run'));
    careerTab.addEventListener('click', () => setTab('career'));
    setTab('run');

    const runAgain = document.createElement('button');
    runAgain.type = 'button';
    runAgain.className = 'ob-res-btn primary';
    runAgain.textContent = 'R · Run again';
    runAgain.addEventListener('click', () => finish('run-again'));

    const raceGhost = document.createElement('button');
    raceGhost.type = 'button';
    raceGhost.className = 'ob-res-btn ghost';
    raceGhost.textContent = 'Race this ghost';
    raceGhost.disabled = true;
    raceGhost.title = 'Ghost racing is already automatic -- there is no manual picker yet.';

    const watchReplay = document.createElement('button');
    watchReplay.type = 'button';
    watchReplay.className = 'ob-res-btn ghost';
    watchReplay.textContent = 'Watch replay';
    watchReplay.disabled = true;
    watchReplay.title = 'Not built yet.';

    const exit = document.createElement('button');
    exit.type = 'button';
    exit.className = 'ob-res-btn ghost';
    exit.textContent = 'Esc · Courses';
    exit.addEventListener('click', () => finish('exit'));

    foot.append(runAgain, raceGhost, watchReplay, exit);

    if (data.notRecorded === 'cheats') {
      const runClean = document.createElement('button');
      runClean.type = 'button';
      runClean.className = 'ob-res-btn ghost';
      runClean.textContent = 'Run clean';
      runClean.disabled = true;
      runClean.title = 'Would need a page reload, which drops any mounted .pk3 files.';
      foot.insertBefore(runClean, exit);
    }

    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'KeyR') {
          finish('run-again');
        } else if (e.code === 'Escape') {
          finish('exit');
        }
      },
      { signal: controller.signal },
    );
  });
}

function formatUpsDelta(d: number): string {
  const sign = d >= 0 ? '+' : '−';
  return `${sign}${Math.round(Math.abs(d))}`;
}
