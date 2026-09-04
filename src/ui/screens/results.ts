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
 *     live landing-event detector that does not exist. (AIRBORNE% and
 *     STRAFE GAIN%, listed here through Phase 5, are drawn now: `main.ts`
 *     counts airborne ticks and sums `strafe.ts`'s per-tick gain over the
 *     run, which is a reduction of numbers the HUD gauge already shows
 *     live -- not the new physics interpretation `obHits` still needs.)
 *   - "ghost beaten by" -- needs a live position-matched ghost delta,
 *     `hud.ts`'s own header note says the same thing is missing there.
 *   - "Watch replay" (no replay viewer exists) renders disabled, matching
 *     PAUSED's "All settings" precedent. "Race this ghost" used to sit
 *     beside it and is gone from the frames as well as from here -- racing
 *     is automatic, so the button never had anything to route to; Export
 *     ghost and Screenshot took its place in the row.
 *   - "Run clean" (Rb's cheat card) would need a param-stripping reload,
 *     which drops the mounted `.pk3` File handles `appFlow` depends on --
 *     a UX cliff, not a button. Disabled, same precedent.
 *
 * ## Where this deliberately departs from the frames
 *
 * Three places. The first two are because the frames are 1280x720 STILLS and
 * this is a resizable window with two tabs; the third follows from the first:
 *
 *   - **The tab strip is in the bar on both tabs.** `Ra` draws the bar with
 *     the map name and no tabs; `Rc` draws it with the tabs. Following `Ra`
 *     literally would leave Career unreachable from the screen you always
 *     land on, so the tabs stay and the map/physics/attempt meta `Ra` puts
 *     on the left moves to the right of the bar, beside the recorded stamp.
 *   - **The levelshot leads the bar, ahead of the tabs.** `Ra` puts it beside
 *     the map name, which the point above has already moved to the right end
 *     of the bar; following `Ra` there would orphan the thumbnail from the
 *     name it belongs to on This run and duplicate it on Career. `Rc`'s own
 *     placement -- thumbnail first, then the tabs -- is the one that works
 *     for both, so both use it.
 *   - **`Ra`'s two columns are a grid, not absolute 372px/436px offsets.**
 *     Same widths at the design's own width; below `--ob-res-narrow` they
 *     stack, which a fixed frame has no opinion about either way.
 *
 * The blurred `refs/backdrop.png` is the third, and is covered above.
 */

import { formatTime } from '../../render/hud.js';
import { FINISH_NODE, START_NODE, runSegments, sumOfBest } from '../../game/records.js';
import type { GhostRun } from '../../game/ghost.js';
import { saveGhostFile, exportResultsImage } from './results-export.js';
import type { RunRecord, MapRecord, SegmentBests, Split, PhysicsKey, CameraKey } from '../../game/records.js';

/**
 * A run delta to the millisecond, which is `formatTime`'s own resolution and
 * what every delta in the frames is printed at.
 *
 * NOT `hud.ts`'s `formatDelta`, deliberately: that one is 2dp because it is
 * read at a glance mid-run, off a number that is still moving. Here the run is
 * over and the whole screen is about where the time went, so a split that lost
 * six milliseconds should say so instead of rounding to "-0.01".
 */
function formatRunDelta(ms: number): string {
  const sign = ms >= 0 ? '+' : '−';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}`;
}

/** A segment-graph node as the player knows it: a checkpoint's name, or the
 *  gate. The finish reads "end" -- the frames' own word for it, and the one
 *  that keeps `cp3 -> end` the same width as the rows above it. */
function nodeLabel(node: string): string {
  return node === START_NODE ? 'start' : node === FINISH_NODE ? 'end' : node;
}

function segmentLabel(from: string, to: string): string {
  return `${nodeLabel(from)} → ${nodeLabel(to)}`;
}

/** The height line's own colour, kept out of the two the screen already uses
 *  for speed: amber is a reading and green is a score, and height is neither.
 *  The frame's violet. */
const HEIGHT_COLOR = '#a78bfa';

/** What a trace marker can be. One per thing the player DID, not per weapon:
 *  a weapon that never leaves the ground would still be a shot. */
export type RunEventKind = 'rocket' | 'grenade' | 'plasma' | 'jump';

export interface RunEvent {
  /** Position along the run, 0..1, as a fraction of the speed trace's span. */
  at: number;
  kind: RunEventKind;
}

/**
 * The glyph each event prints on the trace.
 *
 * Emoji rather than drawn icons because they carry their own colour and read
 * at 12px without a legend, which is the whole point -- a rocket jump should
 * be recognisable in the trace at a glance, not after consulting a key.
 */
const EVENT_GLYPH: Record<RunEventKind, string> = {
  rocket: '🚀',
  grenade: '💣',
  plasma: '❄️',
  jump: '🐰',
};

export type ResultsChoice = 'run-again' | 'exit';

/** Why this run was not recorded, when it was not. */
export type NotRecordedReason = 'cheats' | 'voided';

export interface ResultsData {
  mapName: string;
  physics: PhysicsKey;
  /** The view this run was actually played through. Part of a record's
   *  identity, not decoration -- `records.ts` keys the book on it, so the
   *  same course played chase and side holds two separate PBs, and the
   *  header badge is what tells a player which of the two they are looking
   *  at. */
  camera: CameraKey;
  attempt: number;
  /** Present and false for a completed, TIMED, non-cheat run. */
  notRecorded: NotRecordedReason | null;
  time: number;
  /** The checkpoints this run touched, in order. The finish is `time`. */
  splits: Split[];
  /**
   * How many checkpoints the COURSE has, which is not `splits.length` -- a
   * route that skips one still ran the same course, and the bar is
   * describing the map, not the attempt. Counted from the map's own
   * `target_checkpoint` entities at the call site.
   */
  checkpoints: number;
  /** This run's own downsampled trace -- NOT `career.best.speedSeries`,
   *  which is the record run's trace and would be the wrong run's data on
   *  anything but a PB. */
  speedSeries: number[];
  /** Shots and jumps, drawn onto the trace. This run's own, like
   *  `speedSeries`, and never read back from the record book. */
  events: RunEvent[];
  /**
   * Height above the spawn point, in Quake units, downsampled on the same
   * stride as `speedSeries` so index i of one is index i of the other. Zero
   * is where the run started, NOT the map's own zero: a course that begins
   * 900 units up would otherwise draw its whole trace pinned to the ceiling
   * and say nothing about the run. Empty for a run with no samples.
   */
  heightSeries: number[];
  avgSpeed: number;
  topSpeed: number;
  /** Fraction of the run's ticks spent off the ground, 0..1. Null only when
   *  the run recorded no ticks at all. */
  airborne: number | null;
  /** Fraction of the available strafe gain the run actually took, 0..1 --
   *  `strafe.ts`'s own `gain / bestGain`, summed over every tick where the
   *  window existed. Null when none ever did: a course walked on the ground,
   *  or never taken past wishspeed, has no strafing to score rather than
   *  zero percent of it. */
  strafeGain: number | null;
  improved: boolean;
  /** This map's levelshot as a data URL, for the bar's thumbnail -- already
   *  decoded by the time a run finishes (`main.ts` loads it for the loading
   *  screen). Null when the map ships none, which is most of them: the
   *  frame's striped placeholder stays. */
  levelshot: string | null;
  /** Short SHA-1 of the `.bsp` this run was played on, so a time can be told
   *  apart from the same time on a recompiled map of the same name. Null
   *  where `crypto.subtle` is absent -- it needs a secure context, and a
   *  plain-HTTP LAN open should lose the stamp, not the screen. */
  mapSha1: string | null;
  /** THIS run's own recording, for the export button -- not the stored PB,
   *  which on a slower attempt is a different run entirely and not the one
   *  this screen is about. Course select's tile menu is where the stored PB
   *  ghost is exported from. Null when the recorder had nothing to hand
   *  back. */
  ghost: GhostRun | null;
  /** The record as it stood BEFORE this run -- same "stash before write"
   *  pattern as the HUD's own `finishedAgainst`. */
  prevBest: RunRecord | null;
  /** The segment graph as it stood BEFORE this run -- a COPY, not the live
   *  `MapRecord` reference, which `runEnded` already mutated by the time
   *  this screen reads it. See `main.ts`'s own comment at the call site. */
  prevSegmentBests: SegmentBests;
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
/* The identity block: one baseline-aligned row, in the frame's own order --
   what ran, which file it was, when it was recorded. The 15px display weight
   belongs to the TABS at the other end of this bar; the map name rides the
   mono run-on with everything else that qualifies it, which is what the
   revised frame draws and what keeps the two ends of a 54px bar from reading
   as two competing titles. */
.ob-res-id { display:flex; align-items:baseline; gap:14px; }
.ob-res-id .meta, .ob-res-id .stamp { font:400 11px/1 var(--ob-font-mono);
  letter-spacing:.1em; color:var(--ob-dim); }
/* --ob-unavailable is normally reserved for a control you cannot reach, and
   the SHA is the one place it reads as "here if you need it, ignore it
   otherwise" instead -- the frame draws it at exactly that weight. */
.ob-res-id .sha { font:400 10px/1 var(--ob-font-mono); letter-spacing:.05em; color:var(--ob-unavailable); }
/* The levelshot beside the tabs. The striped ground is the frame's own
   placeholder and stays visible when a map ships no levelshot at all, which
   is most of them -- an empty box would read as a failed image. */
.ob-res-shot { width:64px; height:36px; flex:none; border-radius:3px;
  border:1px solid var(--ob-control); background-size:cover; background-position:center;
  background-image:repeating-linear-gradient(135deg,#1b1b23 0 6px,#20202a 6px 12px); }
.ob-res-bar-left { display:flex; align-items:center; gap:20px; }

.ob-res-body { flex:1; min-height:0; overflow:auto; padding:28px; }

/* Ra: the summary column at the design's own 372px, the trace column taking
   the rest. Stacks rather than squeezing once the trace would stop being
   readable -- a still frame has no opinion about narrow windows. */
.ob-res-cols { display:grid; grid-template-columns:372px minmax(0,1fr); gap:36px; align-items:start; }
@media (max-width: 1080px) { .ob-res-cols { grid-template-columns:minmax(0,1fr); gap:30px; } }
.ob-res-foot { flex:none; padding:20px 28px 26px; display:flex; gap:10px; align-items:center; }
/* The way out sits at the opposite end of the bar from the things that keep
   you here -- per the frame, which moved it there. */
.ob-res-btn.trailing { margin-left:auto; }
.ob-res-btn .hint { margin-left:8px; color:var(--ob-unavailable); }
.ob-res-btn { padding:12px 20px; border-radius:5px; font:600 15px/1 var(--ob-font-display);
  letter-spacing:.12em; text-transform:uppercase; cursor:pointer; }
.ob-res-btn.primary { border:1px solid var(--ob-accent); background:rgba(232,98,42,.18); color:var(--ob-text); }
.ob-res-btn.ghost { border:1px solid var(--ob-control); background:transparent; font-weight:400;
  color:var(--ob-text-secondary); }
.ob-res-btn:disabled { color:var(--ob-unavailable); cursor:default; border-color:var(--ob-seam); }

.ob-res-kicker { font:400 11px/1 var(--ob-font-mono); letter-spacing:.32em; }
/* Rb sets a slower run at 76px and Ra a personal best at 116px -- the
   size IS the headline, so it tracks the state rather than being one
   compromise between them. */
.ob-res-time { margin-top:12px; font:600 76px/.82 var(--ob-font-display); letter-spacing:-.04em;
  font-variant-numeric:tabular-nums; }
.ob-res-time.pb { margin-top:14px; font-size:116px; }
/* The kind-of-run badges, inline with the kicker. Two of them, always both:
   physics and camera together are what records.ts keys the record book on,
   so a time on this screen means nothing without the pair. Amber on a PB,
   neutral otherwise -- the header they sit in is already saying which, and
   the badges follow it rather than announcing a third thing.

   The label half is 8px, smaller than anything else on the screen and
   deliberately so: it is a unit, not a reading. The value is what is read. */
.ob-res-kicker-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.ob-res-badges { display:flex; gap:6px; }
.ob-res-badge { padding:3px 8px; border-radius:3px; border:1px solid var(--ob-control);
  display:flex; align-items:center; gap:6px; }
.ob-res-badge .k { font:400 8px/1 var(--ob-font-mono); letter-spacing:.08em;
  color:var(--ob-unavailable); }
.ob-res-badge .v { font:600 11px/1 var(--ob-font-mono); letter-spacing:.05em;
  color:var(--ob-text-secondary); }
.ob-res-badge.pb { border-color:#3a3324; background:rgba(255,209,102,.08); }
.ob-res-badge.pb .k { color:#7a6c3f; }
.ob-res-badge.pb .v { color:#ffd166; }

.ob-res-pills { margin-top:14px; display:flex; gap:8px; flex-wrap:wrap; }
.ob-res-pill { padding:5px 10px; border-radius:3px; font:400 12px/1 var(--ob-font-mono); }

.ob-res-grid { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto; column-gap:14px;
  font:400 12px/1 var(--ob-font-mono); font-variant-numeric:tabular-nums; }
.ob-res-grid > span { padding-top:9px; }
.ob-res-grid > .hd { letter-spacing:.14em; color:var(--ob-dim); padding-top:0; padding-bottom:8px;
  border-bottom:1px solid var(--ob-seam); }
/* The frame breathes a little more between the rule and the first row. */
.ob-res-grid > .first { padding-top:11px; }

.ob-res-sob { margin-top:16px; padding-top:14px; border-top:1px solid var(--ob-seam);
  display:flex; align-items:baseline; justify-content:space-between; }
.ob-res-sob .label { font:400 11px/1 var(--ob-font-mono); letter-spacing:.14em; color:var(--ob-dim); }
.ob-res-sob .value { font:600 28px/1 var(--ob-font-display); font-variant-numeric:tabular-nums; color:#62d0ff; }

.ob-res-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--ob-seam);
  border:1px solid var(--ob-seam); border-radius:4px; overflow:hidden; }
.ob-res-stats.wide { grid-template-columns:repeat(6,1fr); }
.ob-res-stats.three { grid-template-columns:repeat(3,1fr); }
.ob-res-stat { padding:14px 16px; background:var(--ob-panel); }
.ob-res-stat .k { font:400 9px/1 var(--ob-font-mono); letter-spacing:.16em; color:var(--ob-dim); }
.ob-res-stat .v { margin-top:8px; font:600 30px/1 var(--ob-font-display); font-variant-numeric:tabular-nums; }
.ob-res-stat .v.unavail { color:var(--ob-unavailable); font-size:22px; }
.ob-res-stat .v .u { font-size:16px; color:var(--ob-dim); }

/* The frame's two swatch-and-word pairs, 10px mono. .sw is the line the
   entry stands for, drawn at the same 2px the trace uses. */
.ob-res-tracekey { display:flex; gap:16px; font:400 10px/1 var(--ob-font-mono);
  letter-spacing:.08em; color:var(--ob-dim); }
.ob-res-tracekey span { display:flex; align-items:center; gap:6px; }
.ob-res-tracekey .sw { width:14px; height:2px; }

.ob-res-trace { margin-top:14px; position:relative; height:150px; }
.ob-res-tracebox { position:relative; width:100%; height:100%; }
.ob-res-trace svg { display:block; width:100%; height:100%; }
/* Sits ON the trace at the speed the event happened at, riding the top of its
   own dashed riser -- translated fully above its anchor so the glyph's foot
   meets the line rather than covering it. */
.ob-res-event { position:absolute; transform:translate(-50%,-100%);
  font-size:12px; line-height:1; pointer-events:none; user-select:none;
  padding-bottom:3px;
  /* The bomb and the rocket are mostly dark, and the trace they sit on is
     darker -- without a ground they read as smudges. A tight dark halo
     rather than a light one, so the glyph keeps its own colours. */
  text-shadow:0 0 3px var(--ob-background), 0 0 5px var(--ob-background); }
/* Checkpoint tick labels, hung under the trace in the gap the wrapper's own
   bottom padding leaves for them. */
.ob-res-trace-marks { position:absolute; left:0; right:0; bottom:-18px; height:14px; }
.ob-res-trace-marks span { position:absolute; transform:translateX(-50%);
  font:400 9px/1 var(--ob-font-mono); color:var(--ob-dim); }
.ob-res-secthd { display:flex; align-items:baseline; justify-content:space-between; gap:16px; }
.ob-res-secthd .t { font:400 11px/1 var(--ob-font-mono); letter-spacing:.2em; color:var(--ob-dim); }
.ob-res-secthd .c { font:400 11px/1 var(--ob-font-mono); letter-spacing:.1em;
  color:var(--ob-unavailable); white-space:nowrap; }
.ob-res-say { margin-top:12px; font:400 13px/1.4 var(--ob-font-display); letter-spacing:.03em;
  color:var(--ob-dim); }
.ob-res-say b { color:var(--ob-text); font-weight:600; }
.ob-res-empty { padding:24px; text-align:center; color:var(--ob-dim); font-size:13px; }

.ob-res-practice { max-width:600px; }
.ob-res-practice .card { padding:20px 22px; border-radius:5px; background:var(--ob-panel);
  border:1px solid rgba(255,209,102,.32); border-left:3px solid #ffd166; }
.ob-res-practice h2 { margin:12px 0 0; font:600 36px/1 var(--ob-font-display); letter-spacing:.02em;
  text-transform:uppercase; color:var(--ob-dim); }
.ob-res-practice p { margin:12px 0 0; font:400 13px/1.45 var(--ob-font-display); letter-spacing:.03em;
  color:var(--ob-text-secondary); }

.ob-res-practice .acts { margin-top:14px; display:flex; gap:8px; }
.ob-res-practice .acts button { padding:8px 14px; border:1px solid var(--ob-control);
  border-radius:4px; background:transparent; font:400 13px/1 var(--ob-font-display);
  letter-spacing:.1em; text-transform:uppercase; color:var(--ob-text-secondary); cursor:pointer; }
.ob-res-practice .acts button:disabled { color:var(--ob-unavailable); cursor:default;
  border-color:var(--ob-seam); }

/* Rc's bottom row. */
.ob-res-cards { margin-top:20px; display:flex; gap:16px; align-items:stretch; flex-wrap:wrap; }
.ob-res-card { padding:16px 18px; border:1px solid var(--ob-seam); border-radius:4px;
  background:var(--ob-panel); }
.ob-res-card.grow { flex:1; min-width:320px; }
.ob-res-card.fixed { width:300px; flex:none; }
.ob-res-card .k { font:400 9px/1 var(--ob-font-mono); letter-spacing:.16em; color:var(--ob-dim); }
.ob-res-cardtext { margin-top:11px; font:400 14px/1.45 var(--ob-font-display); letter-spacing:.03em;
  color:var(--ob-text-secondary); }
.ob-res-cardtext b { font-weight:600; }

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

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

/**
 * One `PHYS VQ3` / `CAM FPV` badge. `pb` tints it amber to match the header
 * it sits in; without it the badge is drawn in the neutral border the rest of
 * the screen's outlines use.
 */
function runBadge(key: string, value: string, pb: boolean): HTMLElement {
  const badge = el('span', pb ? 'ob-res-badge pb' : 'ob-res-badge');
  const k = el('span', 'k');
  k.textContent = key;
  const v = el('span', 'v');
  v.textContent = value.toUpperCase();
  badge.append(k, v);
  return badge;
}

/** A 0..1 fraction as the frame's whole-number percentage, or its em dash
 *  when the run had nothing to measure. The `%` itself is `statCell`'s
 *  `unit`, which sets it in smaller type. */
function pct(fraction: number | null): string {
  return fraction === null ? '—' : String(Math.round(fraction * 100));
}

function statCell(
  key: string,
  value: string,
  color?: string,
  unavail = false,
  /** A suffix in the frame's smaller, dimmer type -- `81` big, `%` small.
   *  Dropped on an unavailable cell, where the value is an em dash and a
   *  unit on it would be reporting a percentage of nothing. */
  unit?: string,
): HTMLElement {
  const cell = el('div', 'ob-res-stat');
  const k = el('div', 'k');
  k.textContent = key;
  const v = el('div', unavail ? 'v unavail' : 'v');
  v.textContent = value;
  // Not on an unavailable cell: the inline colour would beat `.v.unavail`'s
  // own, and the em dash standing in for a missing number would print in the
  // role colour of the number that is not there -- a green STRAFE GAIN dash,
  // an amber HIGHEST UPS dash. The dim treatment is the whole point of the
  // class.
  if (color && !unavail) {
    v.style.color = color;
  }
  if (unit && !unavail) {
    const u = el('span', 'u');
    u.textContent = unit;
    v.appendChild(u);
  }
  cell.append(k, v);
  return cell;
}

/**
 * A trace SVG for one speed series, 0..max(series,320)*1.15 vertical range -- the same
 * headroom rule `hud.ts`'s live trace uses, so a results trace and a HUD trace read the
 * same way.
 *
 * `marks` are checkpoint positions as a 0..1 fraction of the run, drawn as the
 * frame's vertical seams. They are what turns the trace from a speed graph into
 * an answer to "which segment was slow" -- the split table names the segment,
 * these say where in the trace to look for why.
 *
 * ## Why every stroke here is `non-scaling-stroke`
 *
 * The viewBox is 700x120 and `preserveAspectRatio="none"` stretches it to
 * whatever the column is -- roughly 1.9x across and 1.25x down. Stroke width
 * is scaled by that too, and NOT uniformly: a vertical line is fattened by
 * the horizontal factor and a horizontal line by the vertical one, so the
 * same 2.5 comes out at 4.6px one way and 3.1px the other. That is why the
 * seams looked heavier than the 320 cap while both were drawn identically.
 * `vector-effect="non-scaling-stroke"` takes the width out of user space, so
 * 2.5 is 2.5 whichever way the line runs.
 *
 * The same squash is why there is no peak dot any more. `Ra` draws one, but a
 * circle in a stretched viewBox is an ellipse, and an owner-directed read of
 * it was "a squished green dot, and I do not know what it indicates" -- which
 * is the honest verdict on an unlabelled marker. Removed rather than
 * un-squashed: the peak is already printed as TOP SPEED right beneath.
 */
function drawTrace(
  series: readonly number[],
  marks: readonly number[] = [],
  events: readonly RunEvent[] = [],
  heights: readonly number[] = [],
): HTMLElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 700 120');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.display = 'block';
  svg.style.width = '100%';
  svg.style.height = '100%';

  const top = Math.max(320, ...series, 1) * 1.15;
  const y = (v: number): number => 120 * (1 - v / top);
  const capY = y(320);

  /*
   * Height rides its own scale, centred on the box.
   *
   * It has to: speed is units per second and height is units, and there is no
   * shared axis the two could honestly sit on. So the height line gets the
   * frame's own treatment -- a flat rule at the vertical middle for "where
   * you started", and the run's largest departure from it in either direction
   * mapped to the edges. Reading it is relative by construction: how far
   * above or below the spawn, and when, not how many units.
   *
   * Symmetric around zero rather than fitted to the actual min and max, so
   * the middle rule always means the same thing. A run that only ever goes up
   * uses half the box, which is the honest picture of a run that only ever
   * goes up.
   */
  const HEIGHT_ZERO_Y = 60;
  const heightSpan = Math.max(1, ...heights.map((h) => Math.abs(h)));
  const hy = (v: number): number => HEIGHT_ZERO_Y - (v / heightSpan) * 52;

  // Under the polyline, so a trace crossing a seam stays legible.
  for (const frac of marks) {
    const x = frac * 700;
    const seam = document.createElementNS(NS, 'line');
    seam.setAttribute('x1', String(x));
    seam.setAttribute('x2', String(x));
    seam.setAttribute('y1', '0');
    seam.setAttribute('y2', '120');
    seam.setAttribute('stroke', '#2a2a34');
    seam.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(seam);
  }

  const cap = document.createElementNS(NS, 'line');
  cap.setAttribute('x1', '0');
  cap.setAttribute('x2', '700');
  cap.setAttribute('y1', String(capY));
  cap.setAttribute('y2', String(capY));
  cap.setAttribute('stroke', '#3a3a46');
  cap.setAttribute('stroke-dasharray', '5 7');
  cap.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(cap);

  if (heights.length > 1) {
    // The spawn-height rule, at the same weight as a checkpoint seam: it is a
    // reference, not a reading.
    const zero = document.createElementNS(NS, 'line');
    zero.setAttribute('x1', '0');
    zero.setAttribute('x2', '700');
    zero.setAttribute('y1', String(HEIGHT_ZERO_Y));
    zero.setAttribute('y2', String(HEIGHT_ZERO_Y));
    zero.setAttribute('stroke', '#2a2a34');
    zero.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(zero);

    // Under the speed line and a little transparent, per the frame: speed is
    // what the screen is about and height is the context for it.
    const hline = document.createElementNS(NS, 'polyline');
    hline.setAttribute(
      'points',
      heights.map((v, i) => `${(i / (heights.length - 1)) * 700},${hy(v)}`).join(' '),
    );
    hline.setAttribute('fill', 'none');
    hline.setAttribute('stroke', HEIGHT_COLOR);
    hline.setAttribute('stroke-width', '2');
    hline.setAttribute('stroke-linejoin', 'round');
    hline.setAttribute('stroke-linecap', 'round');
    hline.setAttribute('opacity', '0.85');
    hline.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(hline);
  }

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
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(line);
  }

  const wrap = el('div', 'ob-res-tracebox');
  wrap.appendChild(svg);

  // Events: a dashed riser from the floor up to the speed the run was doing
  // when it happened, with the glyph sitting on top of the riser.
  //
  // The riser is SVG (a vertical line survives `preserveAspectRatio="none"`
  // unharmed) and the glyph is an HTML overlay (a glyph would not -- the
  // viewBox is stretched horizontally to whatever width the column is, and
  // text inside it stretches with it). Its dash is finer and dimmer than the
  // 320 cap's `5 7`, so the two never read as the same kind of line.
  if (series.length > 1 && events.length) {
    const lastX = series.length - 1;
    // Where the glyph for the previous event ended up, so a rocket jump --
    // a jump and a shot one or two ticks apart, which is the signature move
    // here -- stacks its two glyphs instead of printing them on top of each
    // other. Purely a drawing concern: nothing is dropped or merged.
    let prevX = -Infinity;
    let stack = 0;
    for (const ev of events) {
      const frac = Math.min(1, Math.max(0, ev.at));
      const x = frac * 700;
      // The value on the DRAWN line, not the raw samples behind it, so the
      // riser always meets the polyline it is pointing at.
      const value = series[Math.round(frac * lastX)] ?? 0;
      const yv = y(value);

      const riser = document.createElementNS(NS, 'line');
      riser.setAttribute('x1', String(x));
      riser.setAttribute('x2', String(x));
      riser.setAttribute('y1', '120');
      riser.setAttribute('y2', String(yv));
      riser.setAttribute('stroke', '#4a4a54');
      riser.setAttribute('stroke-dasharray', '3 4');
      riser.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(riser);

      // `yv` is in the 0..120 viewBox and the overlay is the same box at
      // 100% height, so the percentage is just that number rescaled.
      const topPct = (yv / 120) * 100;
      // How many glyphs can stack above this point before they would leave
      // the trace. A plasma climb fires every 100ms and puts five or more
      // shots within one glyph's width, so this is the ordinary case rather
      // than a guard against a freak one: past the cap the column restarts
      // at the line instead of walking off the top of the chart and into
      // the header, which is exactly what it did before the clamp.
      const headroom = Math.max(0, Math.floor(topPct / GLYPH_STACK_PCT));
      stack = frac * 700 - prevX < GLYPH_WIDTH ? Math.min(stack + 1, headroom) : 0;
      prevX = frac * 700;

      const glyph = el('span', 'ob-res-event');
      glyph.textContent = EVENT_GLYPH[ev.kind];
      glyph.style.left = `${frac * 100}%`;
      glyph.style.top = `${Math.max(0, topPct - stack * GLYPH_STACK_PCT)}%`;
      wrap.appendChild(glyph);
    }
  }
  return wrap;
}

/** Horizontal room one glyph needs, in the trace's own 0..700 units. Two
 *  events closer than this would overlap, so the second stacks above. */
const GLYPH_WIDTH = 9;
/** How far up each stacked glyph goes, as a percentage of the trace's height
 *  -- a percentage rather than px so a stack scales with the box instead of
 *  overflowing it at one particular size. ~11% of 150px is 16px, just over a
 *  12px glyph. */
const GLYPH_STACK_PCT = 11;

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
  cap.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(cap);

  const line = (color: string, values: readonly number[]): void => {
    const points = runs.map((r, i) => `${x(r.atMs)},${y(values[i])}`).join(' ');
    const p = document.createElementNS(NS, 'polyline');
    p.setAttribute('points', points);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', color);
    p.setAttribute('stroke-width', '2.5');
    p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('stroke-linecap', 'round');
    // Same stretched viewBox, same fix -- see `drawTrace`'s own note.
    p.setAttribute('vector-effect', 'non-scaling-stroke');
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

/**
 * The three speed numbers both `Ra`'s career strip and `Rc`'s stat row show,
 * derived once so the two cannot disagree about what "average ups" means.
 *
 * `delta` is last-ten against ALL-TIME, and it is only meaningful once the
 * last ten are not simply all of them -- with nine runs on record the two
 * averages are the same number and the delta is a guaranteed `+0`. Callers
 * gate the sentence on `runs >= 10`; `last10Label` drops the delta on its own
 * for the same reason, so the cell stays honest even below that.
 */
interface CareerSpeeds {
  runs: number;
  highest: number;
  avgAll: number;
  last10: number;
  delta: number;
  last10Label: string;
}

function careerSpeeds(c: MapRecord): CareerSpeeds {
  const runs = c.recentRuns;
  if (!runs.length) {
    return { runs: 0, highest: 0, avgAll: 0, last10: 0, delta: 0, last10Label: '—' };
  }
  const highest = Math.max(...runs.map((r) => r.topSpeed));
  const avgAll = runs.reduce((a, r) => a + r.avgSpeed, 0) / runs.length;
  const tail = runs.slice(-10);
  const last10 = tail.reduce((a, r) => a + r.avgSpeed, 0) / tail.length;
  const partial = tail.length < runs.length;
  const delta = partial ? last10 - avgAll : 0;
  return {
    runs: runs.length,
    highest,
    avgAll,
    last10,
    delta,
    last10Label: partial
      ? `${Math.round(last10)} ${formatUpsDelta(delta)}`
      : String(Math.round(last10)),
  };
}

/**
 * The frames print dates day-first and month-abbreviated -- "19 AUG",
 * "SINCE 04 AUG". Assembled from the parts rather than handed to
 * `toLocaleDateString` with a format object, because the ORDER is what is
 * being specified and the locale would otherwise decide it (en-US answers
 * "Aug 19"). The month name still comes from the locale, so it localises
 * without the layout moving.
 */
function formatDayMonth(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase();
  return `${day} ${month}`;
}

/** `Ra`'s "19 AUG, 21:04" -- the moment the run landed. */
function formatStamp(d: Date): string {
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${formatDayMonth(d)}, ${time}`;
}

function formatSinceDate(iso: string): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '—';
  }
  return `SINCE ${formatDayMonth(d)}`;
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
  // The levelshot leads the bar, ahead of the tabs -- `Rc`'s own placement,
  // and the only one available here: `Ra` puts it beside a map name that
  // this bar keeps on the right (see the file header's departure note), so
  // following `Ra` literally would leave the thumbnail orphaned from the
  // name it belongs to on one tab and duplicated on the other.
  const shot = el('div', 'ob-res-shot');
  if (data.levelshot) {
    shot.style.backgroundImage = `url("${data.levelshot}")`;
  }
  const barLeft = el('div', 'ob-res-bar-left');
  barLeft.append(shot, tabs);
  // `Ra` splits this across both ends of the bar (map name left, recorded
  // stamp right); the tabs own the left here, so both halves sit on the
  // right -- see the file header. Two spans rather than one string so the
  // stamp keeps the frame's dimmer weight, and the SHA under them on its own
  // line, which is where `Rc` puts it.
  const idWrap = el('div', 'ob-res-id');
  const idLine = el('span', 'meta');
  const idSha = el('span', 'sha');
  const idStamp = el('span', 'stamp');
  idSha.textContent = data.mapSha1 ? `SHA1 ${data.mapSha1}` : '';
  idSha.hidden = !data.mapSha1;
  idWrap.append(idLine, idSha, idStamp);
  bar.append(barLeft, idWrap);

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
      const cps = data.checkpoints === 1 ? '1 CHECKPOINT' : `${data.checkpoints} CHECKPOINTS`;
      idLine.textContent = [
        data.mapName.toUpperCase(),
        data.physics.toUpperCase(),
        ...(data.checkpoints > 0 ? [cps] : []),
        `ATTEMPT ${data.attempt}`,
      ].join(' · ');
      // The frame's "· RUN RECORDED 19 AUG, 21:04" -- the separator leads the
      // span, because what it separates this from is the SHA before it. A run
      // that was not recorded says so instead of claiming a stamp it never
      // got.
      idStamp.textContent = data.notRecorded
        ? '· NOT RECORDED'
        : `· RUN RECORDED ${formatStamp(new Date())}`;
      idStamp.hidden = false;

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
            ? 'A cheat is active, so the clock never started and no ghost was saved. Run as long as you like; nothing here is recorded. Reload without cheats to time a run.'
            : 'This attempt paused earlier, which costs it the same way dying does — the clock stopped there and nothing about the rest of this run was recorded.';
        card.append(label, h2, p);
        // `Rb` puts these INSIDE the card, not in the footer: they answer the
        // card's own question ("recorded nothing -- now what?"), and the
        // footer's Run again/Courses stay where every other state has them.
        const acts = el('div', 'acts');
        if (data.notRecorded === 'cheats') {
          const clean = document.createElement('button');
          clean.type = 'button';
          clean.textContent = 'Run clean';
          clean.disabled = true;
          clean.title = 'Would need a page reload, which drops any mounted .pk3 files.';
          acts.appendChild(clean);
        }
        const keep = document.createElement('button');
        keep.type = 'button';
        keep.textContent = 'Keep practising';
        keep.addEventListener('click', () => finish('run-again'));
        acts.appendChild(keep);
        card.appendChild(acts);
        wrap.append(kicker, card);
        body.appendChild(wrap);
        return;
      }

      // `Ra`'s two columns: the summary reads top-to-bottom on the left, the
      // evidence for it sits on the right. See the file header for why this
      // is a grid and not the frame's absolute offsets.
      const cols = el('div', 'ob-res-cols');
      const left = el('div');
      const right = el('div');
      cols.append(left, right);
      body.appendChild(cols);

      const header = el('div');
      // The kicker and the two run badges share one row -- what kind of
      // result this is, and what kind of run produced it, read together.
      const kickerRow = el('div', 'ob-res-kicker-row');
      const kicker = el('div', 'ob-res-kicker');
      const badges = el('div', 'ob-res-badges');
      badges.append(
        runBadge('PHYS', data.physics, data.improved),
        runBadge('CAM', data.camera, data.improved),
      );
      kickerRow.append(kicker, badges);
      const time = el('div', 'ob-res-time');
      time.textContent = formatTime(data.time);
      const pills = el('div', 'ob-res-pills');

      if (data.improved) {
        time.classList.add('pb');
        kicker.textContent = 'PERSONAL BEST';
        kicker.style.color = '#ffd166';
        time.style.color = '#ffd166';
        if (data.prevBest) {
          const delta = el('span', 'ob-res-pill');
          delta.style.background = 'rgba(126,224,129,.16)';
          delta.style.color = '#7ee081';
          delta.style.fontWeight = '700';
          delta.textContent = formatRunDelta(data.time - data.prevBest.time);
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
          delta.textContent = formatRunDelta(data.time - data.prevBest.time);
          const kept = el('span', 'ob-res-pill');
          kept.style.border = '1px solid var(--ob-control)';
          kept.style.color = 'var(--ob-dim)';
          kept.textContent = `pb ${formatTime(data.prevBest.time)} kept`;
          pills.append(delta, kept);
        }
        // The first segment this run tied or beat its standing best for, if
        // any. `prevSegmentBests` is BEFORE this run's write, so this reads
        // "did this run improve on history", not "did it improve on itself"
        // (every segment of the run that just wrote it would trivially
        // qualify against the post-write numbers). A segment is identified
        // by the two checkpoints it runs between, so a run that skipped
        // `cp2` is judged on its `cp1 → cp3` against earlier `cp1 → cp3`s
        // only -- and a segment nobody has run before is new, not "a best".
        for (const seg of runSegments(data.splits, data.time)) {
          const prev = data.prevSegmentBests[seg.from]?.[seg.to];
          if (prev !== undefined && seg.ms <= prev) {
            const badge = el('span', 'ob-res-pill');
            badge.style.border = '1px solid var(--ob-control)';
            badge.style.color = '#7ee081';
            badge.textContent = `${segmentLabel(seg.from, seg.to)} was a best segment`;
            pills.append(badge);
            break;
          }
        }
      }
      header.append(kickerRow, time, pills);
      left.appendChild(header);

      // ---- splits ----
      if (data.splits.length) {
        const gridWrap = el('div');
        gridWrap.style.marginTop = '30px';
        const grid = el('div', 'ob-res-grid');
        // The empty second cell is the frame's own `1fr` spacer, which is what
        // pushes SPLIT and Δ PB to the right edge of the column.
        for (const h of ['SEGMENT', '', 'SPLIT', 'Δ PB']) {
          const hd = el('span', 'hd');
          hd.textContent = h;
          grid.appendChild(hd);
        }
        // One row per segment of THIS run's route, and Δ PB is the SEGMENT's
        // own delta -- this run's `cp1 → cp2` against the PB's `cp1 → cp2` --
        // not the cumulative gap at the row's end checkpoint.
        //
        // The frames settle which: `Ra`'s four deltas sum to exactly the
        // `−1.116` in its header pill, and its last row reads `−0.006` where
        // the cumulative reading would have to repeat the total. So the column
        // answers "was this segment faster", and the header already answers
        // "is the run faster" -- printing the second thing four times would
        // leave the split table saying nothing the clock does not.
        //
        // A segment is keyed by the two checkpoints it runs between, so a run
        // that skipped `cp2` is compared on `cp1 → cp3` against the PB's own
        // `cp1 → cp3` and dashes when the PB never ran that pair. Same rule
        // `prevSegmentBests` uses; see `records.ts`.
        const pbSegments = new Map<string, number>();
        if (data.prevBest) {
          for (const seg of runSegments(data.prevBest.splits, data.prevBest.time)) {
            pbSegments.set(`${seg.from}\u0000${seg.to}`, seg.ms);
          }
        }
        runSegments(data.splits, data.time).forEach((seg, i) => {
          const pbMs = pbSegments.get(`${seg.from}\u0000${seg.to}`);
          const name = el('span');
          name.style.color = 'var(--ob-text-secondary)';
          name.textContent = segmentLabel(seg.from, seg.to);
          const spacer = el('span');
          const val = el('span');
          val.style.textAlign = 'right';
          val.style.color = 'var(--ob-text)';
          val.textContent = formatTime(seg.ms);
          const delta = el('span');
          delta.style.textAlign = 'right';
          if (pbMs !== undefined) {
            const d = seg.ms - pbMs;
            delta.style.color = d < 0 ? '#7ee081' : '#ff6b6b';
            delta.textContent = formatRunDelta(d);
          } else {
            delta.style.color = 'var(--ob-unavailable)';
            delta.textContent = '—';
          }
          if (i === 0) {
            for (const cell of [name, spacer, val, delta]) {
              cell.classList.add('first');
            }
          }
          grid.append(name, spacer, val, delta);
        });
        gridWrap.appendChild(grid);

        const sobMs = data.career ? sumOfBest(data.career) : null;
        if (data.career && sobMs !== null) {
          const sumTotal = sobMs;
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
          // diverged from -- on this run's own first-ever completion, the
          // segment graph holds exactly these splits, so `available` would
          // always read a meaningless "+0.00" here.
          if (data.career.counters.completed > 1) {
            const avail = el('span');
            avail.style.font = '400 11px/1 var(--ob-font-mono)';
            avail.style.color = 'var(--ob-dim)';
            avail.textContent = `${formatRunDelta(sumTotal - best)} available`;
            value.appendChild(avail);
          }
          sob.append(label, value);
          gridWrap.appendChild(sob);
        }
        left.appendChild(gridWrap);
      }

      // ---- trace + speed stats ----
      const traceWrap = el('div');
      const traceHd = el('div', 'ob-res-secthd');
      const traceLabel = el('span', 't');
      traceLabel.textContent = 'SPEED OVER THE WHOLE RUN';
      // The frame's own legend, in place of the "dashed = 320 ground cap"
      // caption it replaced: with two lines in the box, saying WHICH is which
      // earns the space more than explaining the reference line does.
      const legend = el('div', 'ob-res-tracekey');
      for (const [color, text] of [
        ['#ffd166', 'speed'],
        [HEIGHT_COLOR, 'height'],
      ] as const) {
        const entry = document.createElement('span');
        const swatch = document.createElement('span');
        swatch.className = 'sw';
        swatch.style.background = color;
        const label = document.createElement('span');
        label.textContent = text;
        entry.append(swatch, label);
        legend.appendChild(entry);
      }
      traceHd.append(traceLabel, legend);
      // Checkpoints as a fraction of the run, for the trace's seams and the
      // tick labels under it. `at` is elapsed-at-touch and `time` the finish,
      // so this is exactly where in the trace that split happened.
      const marks = data.time > 0
        ? data.splits
            .filter((sp) => sp.at > 0 && sp.at < data.time)
            .map((sp) => ({ cp: sp.cp, frac: sp.at / data.time }))
        : [];
      const trace = el('div', 'ob-res-trace');
      trace.appendChild(
        drawTrace(data.speedSeries, marks.map((m) => m.frac), data.events, data.heightSeries),
      );
      if (marks.length) {
        const ticks = el('div', 'ob-res-trace-marks');
        for (const m of marks) {
          const t = document.createElement('span');
          t.style.left = `${m.frac * 100}%`;
          t.textContent = nodeLabel(m.cp);
          ticks.appendChild(t);
        }
        trace.appendChild(ticks);
      }
      traceWrap.append(traceHd, trace);
      right.appendChild(traceWrap);

      // The frame colours these by ROLE, not by value: a peak is amber and an
      // average is neutral whatever the numbers are. `speedColor` stays for
      // the HUD, where the colour is genuinely reporting live speed.
      const stats = el('div', 'ob-res-stats');
      stats.style.marginTop = marks.length ? '44px' : '30px';
      stats.appendChild(statCell('TOP SPEED', String(Math.round(data.topSpeed)), '#ffd166'));
      stats.appendChild(statCell('AVERAGE', String(Math.round(data.avgSpeed))));
      // Coloured by role like the two beside them: airborne is neutral (it
      // describes the route, not a score), strafe gain green (it is one).
      stats.appendChild(
        statCell('AIRBORNE', pct(data.airborne), undefined, data.airborne === null, '%'),
      );
      stats.appendChild(
        statCell('STRAFE GAIN', pct(data.strafeGain), '#7ee081', data.strafeGain === null, '%'),
      );
      right.appendChild(stats);

      // ---- mini career strip ----
      if (data.career) {
        const c = data.career;
        const strip = el('div');
        strip.style.marginTop = '22px';
        const stripHd = el('div', 'ob-res-secthd');
        const stripLabel = el('span', 't');
        stripLabel.textContent = 'CAREER ON THIS MAP';
        const stripSince = el('span', 'c');
        stripSince.textContent = formatSinceDate(c.firstSeen);
        stripHd.append(stripLabel, stripSince);
        // Six cells over three columns, the frame's own order and grouping:
        // the volume row on top, the speed row under it.
        const stripStats = el('div', 'ob-res-stats three');
        stripStats.style.marginTop = '14px';
        const pct = c.counters.started ? Math.round((c.counters.completed / c.counters.started) * 100) : 0;
        const career = careerSpeeds(c);
        stripStats.appendChild(statCell('RUNS STARTED', String(c.counters.started)));
        stripStats.appendChild(statCell('COMPLETED', `${c.counters.completed} · ${pct}%`, '#7ee081'));
        stripStats.appendChild(statCell('TIME ON MAP', formatHM(c.timeOnMapMs)));
        stripStats.appendChild(
          statCell('HIGHEST UPS', career.runs ? String(Math.round(career.highest)) : '—', '#ffd166', !career.runs),
        );
        stripStats.appendChild(
          statCell('AVERAGE UPS', career.runs ? String(Math.round(career.avgAll)) : '—', undefined, !career.runs),
        );
        stripStats.appendChild(
          statCell('AVG UPS · LAST 10', career.last10Label, '#7ee081', !career.last10),
        );
        strip.append(stripHd, stripStats);
        // The frame's closing sentence. Gated the same way the Career tab's
        // own narrative is: below ten runs the delta is noise, not a trend.
        if (career.runs >= 10) {
          const say = el('div', 'ob-res-say');
          const sign = career.delta >= 0 ? 'over' : 'under';
          const amount = document.createElement('b');
          amount.style.color = career.delta >= 0 ? '#7ee081' : '#ff6b6b';
          amount.textContent = `${formatUpsDelta(career.delta)} ups`;
          const tabName = document.createElement('b');
          tabName.textContent = 'Career';
          say.append(
            document.createTextNode('Your last ten runs average '),
            amount,
            document.createTextNode(` ${sign} your all-time average — see the full curve in `),
            tabName,
            document.createTextNode('.'),
          );
          strip.appendChild(say);
        }
        right.appendChild(strip);
      }
    };

    const renderCareer = (): void => {
      body.innerHTML = '';
      // `Rc` puts SINCE in the bar rather than under the stat row.
      // `Rc`'s own line, since-date folded in rather than split off: there is
      // no recorded stamp on the career tab to keep it apart from.
      idLine.textContent = [
        data.mapName.toUpperCase(),
        data.physics.toUpperCase(),
        ...(data.career ? [formatSinceDate(data.career.firstSeen)] : []),
      ].join(' · ');
      idStamp.textContent = '';
      idStamp.hidden = true;

      const c = data.career;
      if (!c) {
        const empty = el('div', 'ob-res-empty');
        empty.textContent = 'Nothing recorded on this map yet.';
        body.appendChild(empty);
        return;
      }

      const grid = el('div', 'ob-res-stats wide');
      const pct = c.counters.started ? Math.round((c.counters.completed / c.counters.started) * 100) : 0;
      const career = careerSpeeds(c);
      grid.appendChild(statCell('RUNS STARTED', String(c.counters.started)));
      grid.appendChild(statCell('COMPLETED', `${c.counters.completed} · ${pct}%`, '#7ee081'));
      grid.appendChild(
        statCell('HIGHEST UPS', career.runs ? String(Math.round(career.highest)) : '—', '#ffd166', !career.runs),
      );
      grid.appendChild(
        statCell('AVERAGE UPS', career.runs ? String(Math.round(career.avgAll)) : '—', undefined, !career.runs),
      );
      grid.appendChild(statCell('AVG UPS · LAST 10', career.last10Label, '#7ee081', !career.runs));
      grid.appendChild(statCell('TIME ON MAP', formatHM(c.timeOnMapMs)));
      body.appendChild(grid);

      // ---- speed-per-hour curve ----
      const curveWrap = el('div');
      curveWrap.style.marginTop = '24px';
      const curveHd = el('div', 'ob-res-secthd');
      const curveLabel = el('span', 't');
      curveLabel.textContent = 'SPEED PER HOUR PLAYED';
      // `Rc`'s legend -- without it the two lines are just two colours.
      const legendBox = el('div');
      legendBox.style.display = 'flex';
      legendBox.style.gap = '18px';
      for (const [color, text, dashed] of [
        ['#ffd166', 'peak ups', false],
        ['#7ee081', 'average ups', false],
        ['#3a3a46', '320 ground cap', true],
      ] as const) {
        const item = el('span');
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '6px';
        const swatch = el('span');
        swatch.style.width = '14px';
        if (dashed) {
          swatch.style.height = '0';
          swatch.style.borderTop = `1px dashed ${color}`;
        } else {
          swatch.style.height = '2px';
          swatch.style.background = color;
        }
        const label = el('span');
        label.style.font = '400 10px/1 var(--ob-font-mono)';
        label.style.letterSpacing = '.08em';
        label.style.color = dashed ? 'var(--ob-unavailable)' : 'var(--ob-dim)';
        label.textContent = text;
        item.append(swatch, label);
        legendBox.appendChild(item);
      }
      curveHd.append(curveLabel, legendBox);
      curveWrap.appendChild(curveHd);

      if (c.recentRuns.length >= 2) {
        const curve = el('div');
        curve.style.marginTop = '16px';
        curve.style.height = '264px';
        // `drawCareerCurve` hangs its hour axis at `bottom:-18px`, outside its
        // own box. Without the clearance it lands on top of whatever follows,
        // which is exactly what it did to the COMPLETION card.
        curve.style.marginBottom = '26px';
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

      // ---- Rc's bottom row: what the curve says, and completion ----
      // One flex row of two cards, the narrative taking the slack and
      // completion fixed at the frame's 300px.
      const bottom = el('div', 'ob-res-cards');

      // The narrative rides with the curve: no curve, nothing to say about it.
      if (c.recentRuns.length >= 2) {
        const sayCard = el('div', 'ob-res-card grow');
        const sayLabel = el('div', 'k');
        sayLabel.textContent = 'WHAT THE CURVE SAYS';
        const sayBody = el('div', 'ob-res-cardtext');
        if (career.runs >= 10) {
          const sign = career.delta >= 0 ? 'above' : 'below';
          const amount = document.createElement('b');
          amount.style.color = career.delta >= 0 ? '#7ee081' : '#ff6b6b';
          amount.textContent = `${Math.round(Math.abs(career.delta))} ups`;
          sayBody.append(
            document.createTextNode('Your last 10 runs average '),
            amount,
            document.createTextNode(
              ` ${sign} your all-time average. Holding a high average for a whole run beats touching a peak once — it is the number that moves finish times.`,
            ),
          );
        } else {
          // Below ten the delta is noise. Say what IS known rather than
          // dressing a two-run sample up as a trend.
          sayBody.textContent =
            `Only ${career.runs} completed runs so far — enough to draw the curve, not enough to call a trend. The average line is the one to watch: holding it high for a whole run beats touching a peak once.`;
        }
        sayCard.append(sayLabel, sayBody);
        bottom.appendChild(sayCard);
      }

      const total = c.counters.completed + c.counters.died + c.counters.restarted;
      if (total > 0) {
        const compWrap = el('div', 'ob-res-card fixed');
        const compLabel = el('div', 'k');
        compLabel.textContent = 'COMPLETION';
        const bar = el('div', 'ob-res-completion');
        bar.style.marginTop = '12px';
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
        bottom.appendChild(compWrap);
      }

      if (bottom.childElementCount) {
        body.appendChild(bottom);
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
    runAgain.className = 'ob-res-btn primary ob-cta-pulse';
    runAgain.textContent = 'R · Run again';
    runAgain.addEventListener('click', () => finish('run-again'));

    const watchReplay = document.createElement('button');
    watchReplay.type = 'button';
    watchReplay.className = 'ob-res-btn ghost';
    watchReplay.textContent = 'Watch replay';
    watchReplay.disabled = true;
    watchReplay.title = 'Not built yet.';

    /**
     * Both of the buttons below report back on themselves rather than
     * silently succeeding: a clipboard write and a save dialog that was
     * cancelled look identical from the outside, and a button that does
     * nothing visible reads as a broken one. The label goes back to normal
     * after a moment.
     */
    const flash = (btn: HTMLButtonElement, text: string, original: string): void => {
      btn.textContent = text;
      window.setTimeout(() => {
        if (btn.isConnected) {
          btn.innerHTML = original;
        }
      }, 1600);
    };

    const exportGhost = document.createElement('button');
    exportGhost.type = 'button';
    exportGhost.className = 'ob-res-btn ghost';
    exportGhost.textContent = 'Export ghost';
    exportGhost.disabled = data.ghost === null;
    exportGhost.title = data.ghost
      ? 'Save this run’s ghost recording to a file.'
      : 'This run was not recorded, so there is no ghost to export.';
    exportGhost.addEventListener('click', () => {
      const ghost = data.ghost;
      if (!ghost) {
        return;
      }
      const label = exportGhost.innerHTML;
      void saveGhostFile(ghost).then((saved) => {
        flash(exportGhost, saved ? 'Ghost saved' : 'Not saved', label);
      });
    });

    // The frame's own label, hint included: plain click copies, shift saves.
    const SHOT_LABEL = 'Screenshot<span class="hint">· shift to save</span>';
    const screenshot = document.createElement('button');
    screenshot.type = 'button';
    screenshot.className = 'ob-res-btn ghost';
    screenshot.innerHTML = SHOT_LABEL;
    screenshot.title = 'Copy this screen as an image. Hold Shift to save it to a file instead.';
    screenshot.addEventListener('click', (e) => {
      // Started INSIDE the click, and the promise handed straight to the
      // clipboard -- see `exportResultsImage`, which explains why awaiting
      // the render first would lose the write.
      void exportResultsImage(root, { save: e.shiftKey, name: data.mapName }).then((outcome) => {
        flash(
          screenshot,
          outcome === 'copied' ? 'Copied' : outcome === 'saved' ? 'Saved' : 'Not saved',
          SHOT_LABEL,
        );
      });
    });

    const exit = document.createElement('button');
    exit.type = 'button';
    exit.className = 'ob-res-btn ghost trailing';
    exit.textContent = 'All courses · Esc';
    exit.addEventListener('click', () => finish('exit'));

    foot.append(runAgain, watchReplay, exportGhost, screenshot, exit);

    // "Run clean" is NOT added here -- Rb puts it inside the practice card,
    // where renderThisRun builds it, and a second copy in the footer was the
    // visible bug this replaced.

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
