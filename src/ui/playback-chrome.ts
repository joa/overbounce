/**
 * The playback screen's chrome: transport, timeline, pause menu, export.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Frames `Pb`, `Pc`, `Pd`, `Pe` and `Pf` of `design/Overbounce Playback.dc.html`.
 * Measurements come from those frames' inline styles, not from
 * `design/HANDOFF.md`'s prose -- the same rule `shell.ts` records, and it
 * matters more here because this screen has four bespoke controls (the
 * ruler, the track rows, the easing picker, the scrubber) that no other
 * screen shares.
 *
 * ## This is DOM over the canvas, and it mounts on `document.body`
 *
 * Not `#overlay`, which `main.ts` sets `pointer-events: none` on so gameplay
 * clicks reach the canvas for pointer lock. Every control here is
 * interactive, so it follows the rule `pak-ui.ts` and `shell.ts` already
 * state: anything you click mounts on the body.
 *
 * ## The default experience is `Pb`, and that is a design constraint
 *
 * The timeline is OPT-IN (`T`). A player who opens a demo sees the run in its
 * proper camera with a play button and a scrubber, and nothing else -- per
 * the owner's brief ("the default experience is to just see it in the proper
 * camera mode"). Everything below `showTimeline()` is the other mode, and it
 * is deliberately the one you have to ask for.
 *
 * ## What this file does NOT decide
 *
 * It edits a `Timeline` and reports transport intent. It never advances the
 * clock, never touches a camera object and never renders: `playback-session.ts`
 * owns all three and calls `update()` once a frame with what actually
 * happened. That split is what lets the timeline model stay headless and
 * tested (`test/playback/timeline.test.ts`) while this file stays untested
 * DOM -- the same division `hud.ts` has with the simulation.
 */

import './tokens.css';
import type {
  CameraSegment,
  Timeline,
  TrackId,
  PlaybackCamera,
} from '../playback/timeline.js';
import {
  setCameraAt,
  setKeyframe,
  setValueAt,
  removeKeyframe,
  moveKeyframe,
  evaluateTrack,
  sortTimeline,
  findTrack,
  UNCONSUMED_TRACKS,
} from '../playback/timeline.js';
import type { Ease, EaseDirection, EaseFamily } from '../playback/easing.js';
import {
  DEFAULT_EASE,
  PICKER_DIRECTIONS,
  PICKER_FAMILIES,
  withDirection,
  withFamily,
} from '../playback/easing.js';
import type { ClipMeta, ExportConfig } from '../playback/clip.js';
import { defaultExportConfig } from '../playback/clip.js';

/**
 * The tracks `Pc` draws, in its order.
 *
 * `CAMERA POS` is one row in the frame and three tracks in the model (x/y/z)
 * -- a cinematographer keyframes "the camera is here", not three numbers --
 * so the row writes all three at once and shows a diamond where any of them
 * has a key. `dof` is drawn even though `UNCONSUMED_TRACKS` says nothing
 * reads it yet; the frame lists it, and a row that silently vanished would
 * read as a bug rather than as an unbuilt pass.
 */
/**
 * How a row's number is PRINTED and how far a fader drag travels.
 *
 * `min`/`max` are a DISPLAY range, not a clamp the model imposes: they decide
 * where the fader line sits in its 20px lane and how many units a pixel of
 * drag is worth. Both halves have to come from somewhere defensible, and the
 * one defensible source in this repo is `src/ui/photo-mode.ts`, whose LOOK
 * and CAMERA panels already put sliders on exactly these four numbers. Using
 * its ranges means the same value reads the same in both screens, and it
 * means nothing here was invented to make a mockup's number appear.
 *
 * The units, and what was actually found in the code they come from:
 *
 * | row | unit | range | source |
 * | --- | --- | --- | --- |
 * | FOV | degrees | 50..140 | photo mode's `fovSlider` |
 * | VIGNETTE | 0..1, printed as a percent | 0..1 | `post.ts`, "corner darkening, 0..1" |
 * | DOF | 0..1, printed as a percent | 0..1 | nothing consumes it -- see UNCONSUMED_TRACKS |
 * | CHROMATIC AB. | dimensionless strength | 0..1 | photo mode's aberration slider |
 *
 * **The frame's `4px` for chromatic aberration is aspirational and is not
 * reproduced here.** `aberration` is a multiplier on a hardcoded 0.022 of the
 * distance from the centre of the frame, so its displacement in PIXELS
 * depends on how wide the frame is: `post.ts` measures the default 0.1 at 1.4
 * pixels on a 1280-wide picture, which makes the frame's 4px a strength of
 * about 0.28 there and about 0.14 at 2560. A readout that changed when the
 * window was resized, without the shot having changed at all, would be a
 * worse readout than the raw strength. So the raw strength is what is
 * printed, and the mockup's unit is recorded here as the thing it is.
 */
interface ValueScale {
  /** `deg` prints 92 degrees, `percent` prints 35 percent, `scalar` prints 0.10. */
  unit: 'deg' | 'percent' | 'scalar';
  min: number;
  max: number;
  /**
   * True when a value of 0 means the stage is not built at all, so the cell
   * prints `off` rather than a number.
   *
   * `post.ts` says it in as many words for two of these -- "0 = off" for
   * aberration, "0 removes the stage" for vignette -- and it is literally
   * true: `createPostChain` does not construct the pass at 0. FOV has no such
   * reading; a field of view of zero is not a disabled field of view, so FOV
   * never prints `off`.
   */
  zeroIsOff: boolean;
}

interface TrackRow {
  label: string;
  /** Every track this row writes. The first is the one its diamonds read. */
  ids: readonly TrackId[];
  /** What a fresh keyframe on this row is worth when nothing supplies one. */
  fallback: number;
  /**
   * The 64px value cell's fixed contents, for a row that has no number.
   *
   * CAMERA POS is the only one: a camera pose is six tracks and cannot be
   * printed as a scalar, let alone typed into a 64px cell, so the frame gives
   * it the word `drag` instead of a readout and this row keeps it.
   */
  staticValue?: string;
  valueTitle: string;
  /** Present exactly when the row has a live number -- see `ValueScale`. */
  scale?: ValueScale;
  /**
   * Hatch this row over every span the camera is not FREE in.
   *
   * `Pc` marks CAMERA POS this way and says why in its own tooltip: a
   * keyframed pose has nothing to drive while the shot is on a camera that
   * follows the player, so keying one there would be an edit with no visible
   * effect until some later, unrelated cut happened to reach it.
   */
  hatchOutsideFree?: boolean;
}

/** What a value cell says when its track has nothing to say -- see `zeroIsOff`. */
const VALUE_OFF = 'off';

/** The tooltip on every cell that IS a live readout. */
const VALUE_TITLE = 'Value at the playhead — click to type one';

const TRACK_ROWS: readonly TrackRow[] = [
  /*
   * The whole POSE, not just the position: x/y/z AND yaw/pitch/roll.
   *
   * They were split, with the lane owning three and a separate button
   * writing six, and the split had no meaning to anyone looking at it -- one
   * of them made the camera travel and the other made it travel while also
   * turning, and both drew the same diamond. Worse, removing "the row" left
   * the three angle tracks keyed, invisible and unreachable. A
   * cinematographer keyframes "the camera is HERE, looking THERE"; that is
   * one thing, so it is one row.
   */
  {
    label: 'CAMERA POS',
    ids: ['camX', 'camY', 'camZ', 'camYaw', 'camPitch', 'camRoll'],
    fallback: 0,
    staticValue: 'drag',
    valueTitle: 'Disabled outside FREE',
    hatchOutsideFree: true,
  },
  {
    label: 'FOV',
    ids: ['fov'],
    fallback: 100,
    valueTitle: VALUE_TITLE,
    scale: { unit: 'deg', min: 50, max: 140, zeroIsOff: false },
  },
  {
    label: 'VIGNETTE',
    ids: ['vignette'],
    fallback: 0,
    valueTitle: VALUE_TITLE,
    scale: { unit: 'percent', min: 0, max: 1, zeroIsOff: true },
  },
  {
    label: 'DOF',
    ids: ['dof'],
    fallback: 0,
    valueTitle: VALUE_TITLE,
    scale: { unit: 'percent', min: 0, max: 1, zeroIsOff: true },
  },
  {
    label: 'CHROMATIC AB.',
    ids: ['aberration'],
    fallback: 0.1,
    valueTitle: VALUE_TITLE,
    scale: { unit: 'scalar', min: 0, max: 1, zeroIsOff: true },
  },
];

/** The 64px cell's text for a value the track actually has. */
function formatValue(scale: ValueScale, value: number): string {
  switch (scale.unit) {
    case 'deg':
      return `${Math.round(value)}°`;
    case 'percent':
      return `${Math.round(value * 100)}%`;
    default:
      return value.toFixed(2);
  }
}

/**
 * The same number without its unit, for the field a click opens.
 *
 * A user editing `35%` types `35`, not `0.35`: the cell said percent, so the
 * field has to mean percent or the two disagree about what the number is.
 * `parseValue` is the exact inverse.
 */
function toInputText(scale: ValueScale, value: number): string {
  switch (scale.unit) {
    case 'deg':
      return String(Math.round(value));
    case 'percent':
      return String(Math.round(value * 100));
    default:
      return value.toFixed(2);
  }
}

/**
 * A typed string back to a track value, or null when it is not a number.
 *
 * Null rather than NaN, and the callers REVERT on it. A NaN written into a
 * track is not a bad value that shows up as a bad value: it propagates
 * through `evaluateTrack`'s interpolation, so one fat-fingered entry turns a
 * whole span of the shot into nothing, with the readout printing NaN in a
 * 64px cell as the only clue.
 *
 * The unit suffix is stripped rather than rejected, because a cell that
 * printed `92°` invites typing `95°` back into it.
 */
function parseValue(scale: ValueScale, text: string): number | null {
  const cleaned = text.trim().replace(/[°%]|px/gi, '').trim();
  if (cleaned === '') {
    return null;
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    return null;
  }
  return scale.unit === 'percent' ? n / 100 : n;
}

/** `Pe`'s four resolutions. `2160P` and `4K` differ in width, not height. */
const RESOLUTIONS: readonly { id: string; label: string; width: number; height: number; note: string }[] = [
  { id: '720p', label: '720P', width: 1280, height: 720, note: 'HD — 1280×720' },
  { id: '1080p', label: '1080P', width: 1920, height: 1080, note: 'Full HD — 1920×1080' },
  { id: '2160p', label: '2160P', width: 3840, height: 2160, note: 'UHD — 3840×2160' },
  { id: '4k', label: '4K', width: 4096, height: 2160, note: 'DCI 4K — 4096×2160' },
];

const FRAMERATES: readonly number[] = [30, 60, 120];

/**
 * `0:23.6`, the frame's own format: minutes, seconds, one decimal.
 *
 * Deliberately NOT `hud.ts`'s `formatTime`, which prints three decimals
 * because a run time is a record. A scrub position is a place in a video and
 * a tenth is what a viewer can act on; three would jitter every frame.
 */
export function formatClock(ms: number): string {
  // Rounded to tenths BEFORE the minutes are split off, not after. Splitting
  // first and rounding the remainder prints `0:60.0` for anything from
  // 59.95s up, because the seconds round into a minute the minutes field has
  // already been computed without.
  const tenths = Math.round(Math.max(0, ms) / 100);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** `43.8s`, for the export range summary. */
function formatSpan(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

const STYLE = `
.ob-pb { position:fixed; inset:0; z-index:6; display:flex; flex-direction:column;
  font-family:var(--ob-font-display); color:var(--ob-text); pointer-events:none; }
.ob-pb * { box-sizing:border-box; }
/* An explicit display in a stylesheet OUTRANKS the UA sheet's
   [hidden] { display: none }, so .ob-pb-panel's and .ob-pb-float's own
   display:flex silently defeated el.hidden = true -- the timeline panel
   rendered on top of the default view from the first frame. Caught in the
   browser, not by a type or a test, and worth stating rather than just
   fixing: every element below that is toggled sets a display of its own. */
.ob-pb [hidden] { display:none !important; }
.ob-pb button { font-family:inherit; cursor:pointer; }

/* The viewport half is a hole punched through to the canvas -- only the bars
   themselves take pointer events, so a drag over the picture (free-cam look)
   is not swallowed by an invisible full-screen div. */
.ob-pb-view { flex:1; min-height:0; position:relative; }

.ob-pb-top { position:absolute; left:0; right:0; top:0; padding:18px 26px;
  display:flex; align-items:center; justify-content:space-between; gap:16px;
  pointer-events:auto;
  background:linear-gradient(to bottom, rgba(11,11,14,.55), rgba(11,11,14,0)); }
.ob-pb-ident { display:flex; align-items:center; gap:12px; min-width:0; }
.ob-pb-name { font:600 15px/1 var(--ob-font-display); letter-spacing:.03em;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ob-pb-badge { flex:none; padding:3px 8px; border-radius:3px;
  border:1px solid rgba(255,255,255,.25); font:400 10px/1 var(--ob-font-mono);
  letter-spacing:.08em; color:var(--ob-text-secondary); white-space:nowrap; }
.ob-pb-badge.cam { border-color:rgba(255,209,102,.4); background:rgba(255,209,102,.1); color:#ffd166; }
.ob-pb-badge.free { border-color:rgba(255,143,77,.5); background:rgba(232,98,42,.14); color:#ff8f4d; }
.ob-pb-top-actions { display:flex; align-items:center; gap:10px; flex:none; }
.ob-pb-chip { padding:9px 16px; border-radius:5px; background:rgba(255,255,255,.1);
  border:1px solid rgba(255,255,255,.2); font:600 11px/1 var(--ob-font-display);
  letter-spacing:.1em; text-transform:uppercase; color:var(--ob-text); }
.ob-pb-chip:hover { background:rgba(255,255,255,.18); }
.ob-pb-chip.accent { padding:9px 18px; background:rgba(232,98,42,.18);
  border-color:var(--ob-accent); font-size:12px; color:#ffb27a; }
.ob-pb-chip.accent:hover { background:rgba(232,98,42,.3); }
.ob-pb-x { width:30px; height:30px; border-radius:5px; border:1px solid rgba(255,255,255,.2);
  background:transparent; display:flex; align-items:center; justify-content:center;
  font:400 13px/1 var(--ob-font-mono); color:var(--ob-text-secondary); }
.ob-pb-x:hover { color:var(--ob-text); border-color:var(--ob-dim); }

/* Undo and redo, to the LEFT of "Hide timeline" where the frame puts them.
   One control with two halves rather than two buttons: the shared seam and
   the 2px gap are the frame's own, and they are what says the pair is a
   history rather than two unrelated actions. */
.ob-pb-history { display:flex; gap:2px; margin-right:6px; flex:none; }
.ob-pb-history button { width:30px; height:30px; border:1px solid rgba(255,255,255,.2);
  background:transparent; display:flex; align-items:center; justify-content:center; padding:0; }
.ob-pb-history button:first-child { border-radius:5px 0 0 5px; }
.ob-pb-history button:last-child { border-radius:0 5px 5px 0; border-left:none; }
.ob-pb-history button:hover:not(:disabled) { background:rgba(255,255,255,.12); }
.ob-pb-history button svg { stroke:var(--ob-text-secondary); }
/* The same dimming the easing picker uses for a control with nothing to act
   on, for the same reason: an empty history is a state worth showing rather
   than a button worth hiding, or the toolbar would reflow on the first edit. */
.ob-pb-history button:disabled { opacity:.4; cursor:default; }

/* --- Pb: the chrome-light transport ------------------------------------- */
.ob-pb-float { position:absolute; left:50%; bottom:36px; transform:translateX(-50%);
  width:560px; max-width:calc(100% - 52px); display:flex; flex-direction:column;
  align-items:center; gap:10px; pointer-events:auto; }
.ob-pb-row { display:flex; align-items:center; gap:14px; width:100%; }
.ob-pb-play { flex:none; width:38px; height:38px; border-radius:50%;
  background:rgba(255,255,255,.14); border:1px solid rgba(255,255,255,.3);
  display:flex; align-items:center; justify-content:center; gap:4px; padding:0; }
.ob-pb-play:hover { background:rgba(255,255,255,.24); }
.ob-pb-play span { width:4px; height:14px; border-radius:1px; background:#fff; }
/* One element, two shapes: two bars for pause, a triangle for play. Toggling
   a class beats swapping markup -- the button keeps its focus and its hover. */
.ob-pb-play.paused span:first-child { width:0; height:0; border-radius:0; background:transparent;
  border-left:11px solid #fff; border-top:7px solid transparent; border-bottom:7px solid transparent;
  margin-left:3px; }
.ob-pb-play.paused span:last-child { display:none; }
.ob-pb-time { flex:none; font:400 12px/1 var(--ob-font-mono); letter-spacing:.04em;
  color:var(--ob-text-secondary); font-variant-numeric:tabular-nums; white-space:nowrap; }
.ob-pb-hint { font:400 10px/1 var(--ob-font-mono); letter-spacing:.1em; color:rgba(255,255,255,.4); }

/* The scrubber. A bare div rather than <input type=range> because the track
   carries a progress fill the native control cannot paint, and because the
   ruler below needs the same drag maths anyway. */
.ob-pb-scrub { flex:1; height:4px; border-radius:2px; background:rgba(255,255,255,.18);
  position:relative; cursor:pointer; }
.ob-pb-scrub .fill { position:absolute; left:0; top:0; bottom:0; border-radius:2px;
  background:var(--ob-accent); }
.ob-pb-scrub .knob { position:absolute; top:50%; transform:translate(-50%,-50%);
  width:11px; height:11px; border-radius:50%; background:#fff;
  box-shadow:0 0 0 3px rgba(232,98,42,.4); }
/* A 4px-tall bar is a 4px-tall hit target. This grows it to a comfortable one
   without moving anything on screen. */
.ob-pb-scrub::after { content:''; position:absolute; left:0; right:0; top:-9px; bottom:-9px; }

/* --- Pc: the timeline panel --------------------------------------------- */
.ob-pb-panel { flex:none; background:var(--ob-rail); border-top:1px solid var(--ob-seam);
  display:flex; flex-direction:column; pointer-events:auto; }
.ob-pb-bar { display:flex; align-items:center; gap:16px; padding:12px 24px;
  border-bottom:1px solid #1c1c24; flex-wrap:wrap; }
.ob-pb-bar .ob-pb-play { width:32px; height:32px; background:var(--ob-accent); border:0; }
.ob-pb-bar .ob-pb-play:hover { background:#ff7c45; }
.ob-pb-label { font:400 10px/1 var(--ob-font-mono); letter-spacing:.14em;
  color:#5a5a66; flex:none; }
.ob-pb-sep { flex:none; width:1px; height:20px; background:var(--ob-seam); }
.ob-pb-spacer { flex:1; }

/* The easing picker: direction on the left, family on the right, one rule
   between them. Direction alone is meaningless -- see "easing.ts" -- so the
   two groups are one control, not two. */
.ob-pb-ease { display:flex; gap:3px; flex:none; }
.ob-pb-ease button { width:44px; height:34px; border-radius:4px;
  border:1px solid var(--ob-control); background:transparent; display:flex;
  flex-direction:column; align-items:center; justify-content:center; gap:3px; padding:0; }
.ob-pb-ease button span { font:400 8px/1 var(--ob-font-mono); letter-spacing:.04em; color:var(--ob-dim); }
.ob-pb-ease button svg path { stroke:var(--ob-dim); }
.ob-pb-ease button.active { border-color:var(--ob-accent); background:rgba(232,98,42,.15); }
.ob-pb-ease button.active span { color:#ffd166; font-weight:600; }
.ob-pb-ease button.active svg path { stroke:#ffd166; }
.ob-pb-ease button:disabled { opacity:.4; cursor:default; }
.ob-pb-ease .rule { width:1px; height:26px; background:var(--ob-seam); margin:0 3px; align-self:center; }

/*
 * The ruler: in/out band and playhead, in the SAME grid as the track rows.
 *
 * Label, track, value -- 130px, 1fr, 64px -- so that clip time 0 sits at the
 * first reachable pixel of every lane below it and the duration sits over the
 * value column. A ruler in its own padding box was a ruler whose 0 was not
 * the lanes' 0, which is a ruler that lies about where a keyframe is.
 *
 * Both this and the track list scroll horizontally, and they are kept on one
 * scroll position in script -- two independently scrolled columns of the same
 * grid would drift apart the moment either was touched.
 */
.ob-pb-scroll { overflow-x:auto; overflow-y:hidden; position:relative; }
.ob-pb-ruler-wrap { padding:10px 24px 6px 0; }
.ob-pb-ruler-grid { display:grid; grid-template-columns:130px 1fr 64px; align-items:stretch;
  gap:14px; min-width:700px; padding-left:24px; }
.ob-pb-ruler-zero, .ob-pb-ruler-end { display:flex; align-items:center;
  font:400 10px/1 var(--ob-font-mono); letter-spacing:.1em; color:#5a5a66; }
.ob-pb-ruler-end { justify-content:flex-end; }
.ob-pb-ruler { height:22px; position:relative; border-bottom:1px solid #1c1c24; cursor:pointer; }
/*
 * The ruler's own click target, enlarged past its 22px.
 *
 * The z-index of 0 is load-bearing and is not decoration. A generated
 * ::after paints AFTER every child, so at z-index auto this pseudo-element
 * sat on top of the in/out grips and swallowed every pointerdown aimed at
 * them -- the markers could not be grabbed at all, and elementFromPoint over
 * a grip returned the ruler. The grips carry a higher z-index to sit above
 * it.
 */
.ob-pb-ruler::after { content:''; position:absolute; left:0; right:0; top:-6px; bottom:-6px;
  z-index:0; }
.ob-pb-range { position:absolute; top:0; bottom:0; background:rgba(255,209,102,.08);
  border-top:2px solid #ffd166; pointer-events:none; }
.ob-pb-marker { position:absolute; top:0; bottom:0; width:0; z-index:3; }
.ob-pb-marker .grip { position:absolute; left:-6px; top:-3px; width:12px; height:16px;
  border-radius:2px; background:#ffd166; cursor:ew-resize; }
.ob-pb-marker .stem { position:absolute; left:-1px; top:-3px; width:2px; height:210px;
  background:rgba(255,209,102,.55); pointer-events:none; }
.ob-pb-head { position:absolute; top:-4px; width:2px; height:220px; margin-left:-1px;
  background:rgba(255,255,255,.5); pointer-events:none; }
/* Offset to where the TRACK column starts, so the range summary reads against
   the thing it describes. 144px is the frame's own number. */
.ob-pb-ruler-legend { margin-top:6px; padding-left:144px; display:flex;
  justify-content:space-between;
  font:400 10px/1 var(--ob-font-mono); letter-spacing:.04em; color:var(--ob-dim); }
.ob-pb-ruler-legend b { color:#ffd166; font-weight:400; }

.ob-pb-tracks { padding:2px 24px 16px 24px; display:flex; flex-direction:column; gap:1px; }
/* The same three columns and the same min-width as the ruler above. Without
   the min-width the rows would merely SHRINK while the ruler scrolled, which
   is the one arrangement in which "they scroll together" is true and useless. */
.ob-pb-track { display:grid; grid-template-columns:130px 1fr 64px; align-items:center; gap:14px;
  min-width:700px; padding:8px 0; border-top:1px solid #1c1c24; }
.ob-pb-track-name { font:400 11px/1 var(--ob-font-mono); letter-spacing:.06em;
  color:var(--ob-dim); background:transparent; border:0; text-align:left; padding:0; }
.ob-pb-track-name:hover { color:var(--ob-text-secondary); }
/* CAMERA MODE's label is a label, not a button: every other row's name
   toggles the track off, and that row has no track to toggle. Without this it
   would light on hover and promise a gesture that is not there. */
.ob-pb-track-name.fixed:hover { color:var(--ob-dim); }
.ob-pb-track-name.off { color:var(--ob-unavailable); text-decoration:line-through; }
/* user-select is load-bearing: a drag that starts on a lane and leaves it --
   which is every fader drag, since the lane is 20px tall -- paints a text
   selection across the whole panel without it. The obvious alternative, a
   preventDefault on the press, also suppresses the focus change and so leaves
   an open value field on another row unblurred and uncommitted. */
.ob-pb-lane { height:20px; position:relative; border-radius:2px; background:var(--ob-panel);
  cursor:copy; user-select:none; -webkit-user-select:none; }
/* A value row's lane is a fader as well as a keyframe strip, so it takes the
   frame's own ns-resize. The cursor is the whole of what tells a hand that
   the vertical axis means something here -- there is nothing drawn on the
   lane that says so. */
.ob-pb-lane.fader { cursor:ns-resize; }
/*
 * The value drawn as a LEVEL: a hairline across the lane at the height the
 * value sits at within its display range. The frame draws one per value row
 * at a different height each (34% for FOV, 60% for vignette, 20% for
 * aberration), which is what gives it away as a read-out rather than
 * decoration -- three rows, three heights, three values.
 *
 * pointer-events off, because the lane owns every gesture on it: a hairline
 * that swallowed the press over its own one-pixel row would make the fader
 * dead exactly where the value already is.
 */
.ob-pb-level { position:absolute; left:0; right:0; height:1px;
  background:rgba(255,209,102,.25); pointer-events:none; }
.ob-pb-key { position:absolute; top:50%; width:8px; height:8px; margin-left:-4px;
  cursor:ew-resize;
  transform:translateY(-50%) rotate(45deg); background:var(--ob-accent); border:0; padding:0; }
.ob-pb-key.sel { background:#ffd166; box-shadow:0 0 0 2px rgba(255,209,102,.35); }
/*
 * The third column: 64px of live value per row.
 *
 * CAMERA MODE and CAMERA POS keep the words the frame gives them -- neither
 * is a scalar. Every other row prints its value AT THE PLAYHEAD, in the
 * frame's own units, and is a text field: click it and type.
 */
.ob-pb-track-value { text-align:right; font:400 10px/1 var(--ob-font-mono); color:#5a5a66;
  overflow:hidden; white-space:nowrap; }
.ob-pb-track-value.live { font-weight:600; font-size:11px; color:#ffd166; cursor:text;
  border-bottom:1px dashed rgba(255,209,102,.35); }
/*
 * A track with nothing to say: no keys, switched off, or a value of 0 on a
 * stage that is not built at 0 (see ValueScale.zeroIsOff).
 *
 * It keeps the dashed underline and stays clickable, which is the one place
 * this departs from the frame -- the frame draws DOF as plain dim text. A
 * vignette resting at 0 is the most likely moment for someone to want to type
 * 35 into it, so removing the affordance exactly there would make the
 * readout's own zero the one value it could not be brought back from.
 */
.ob-pb-track-value.off { font-weight:600; font-size:11px; color:var(--ob-unavailable);
  cursor:text; border-bottom:1px dashed rgba(74,74,84,.5); }
.ob-pb-track-value input { width:100%; padding:0; border:0; background:transparent;
  text-align:right; font:600 11px/1 var(--ob-font-mono); color:#ffd166; outline:none; }

/*
 * CAMERA MODE is a SEGMENT bar, not a keyframe lane.
 *
 * A camera mode is not a number that interpolates: it holds from the cut that
 * set it until the next one. So the row draws the spans themselves, tinted
 * and labelled, with a boundary line where the shot actually changes -- which
 * is why setCameraAt merges two abutting segments of the same mode rather
 * than leaving a line across a moment where nothing happens.
 */
.ob-pb-modes { height:20px; position:relative; border-radius:2px; background:var(--ob-panel); }
.ob-pb-mode { position:absolute; top:0; bottom:0; display:flex; align-items:center;
  padding-left:6px; font:600 9px/1 var(--ob-font-mono); letter-spacing:.06em;
  overflow:hidden; white-space:nowrap; }
.ob-pb-mode.cut { border-right:1px solid #1c1c24; }
.ob-pb-mode.fpv { background:rgba(126,208,255,.14); color:#7ec8e0; }
.ob-pb-mode.free { background:rgba(255,209,102,.14); color:#ffd166; }
.ob-pb-mode.chase { background:rgba(126,224,129,.1); color:#7ee081; }
/* SIDE is the one mode the Pc frame does not draw a segment for, so it takes
   the accent -- the remaining colour in the frame's own set. */
.ob-pb-mode.side { background:rgba(232,98,42,.16); color:#ff8f4d; }
.ob-pb-cut { position:absolute; top:-4px; width:2px; height:28px; margin-left:-1px;
  background:var(--ob-text); }
/* Hatching means "not yours to edit here": CAMERA POS carries it over every
   span the camera is not FREE in, because a keyframed pose has nothing to
   drive while the shot is on a camera that follows the player. */
.ob-pb-hatch { position:absolute; top:0; bottom:0; pointer-events:none;
  background:repeating-linear-gradient(135deg,#15151b 0 6px,#1a1a21 6px 12px); }

/* --- Pd/Pe/Pf: modals --------------------------------------------------- */
.ob-pb-scrim { position:fixed; inset:0; z-index:7; background:rgba(11,11,14,.55);
  display:flex; align-items:center; justify-content:center; pointer-events:auto; }
.ob-pb-modal { background:var(--ob-background); border:1px solid var(--ob-control);
  border-radius:8px; box-shadow:0 24px 60px rgba(0,0,0,.6); padding:28px 26px;
  display:flex; flex-direction:column; gap:18px; font-family:var(--ob-font-display);
  color:var(--ob-text); }
.ob-pb-modal.wide { width:480px; padding:26px 26px 24px; gap:20px; }
.ob-pb-modal.pause { width:400px; }
.ob-pb-modal.progress { width:440px; align-items:center; text-align:center; }
.ob-pb-modal h2 { margin:0; font:600 20px/1 var(--ob-font-display); letter-spacing:.02em; }
.ob-pb-kicker { font:400 10px/1 var(--ob-font-mono); letter-spacing:.24em; color:var(--ob-dim); }
.ob-pb-modal-title { margin-top:8px; font:600 22px/1 var(--ob-font-display); letter-spacing:.02em;
  word-break:break-all; }
.ob-pb-menu { display:flex; flex-direction:column; gap:10px; }
.ob-pb-menu button { padding:14px 18px; border:1px solid var(--ob-control); border-radius:5px;
  background:transparent; font:400 15px/1 var(--ob-font-display); letter-spacing:.06em;
  text-transform:uppercase; color:var(--ob-text-secondary); text-align:left; }
.ob-pb-menu button:hover { border-color:var(--ob-dim); color:var(--ob-text); }
.ob-pb-menu button.primary { border-color:var(--ob-accent); background:rgba(232,98,42,.18);
  font-weight:600; color:var(--ob-text); }
.ob-pb-menu button.primary:hover { background:rgba(232,98,42,.28); }
.ob-pb-menu button.quiet { color:var(--ob-dim); }

.ob-pb-field { display:flex; flex-direction:column; }
.ob-pb-field > .k { font:400 10px/1 var(--ob-font-mono); letter-spacing:.16em;
  color:var(--ob-dim); margin-bottom:8px; }
.ob-pb-field .note { margin-top:6px; font:400 11px/1.4 var(--ob-font-display); color:#5a5a66; }
.ob-pb-seg { display:flex; border:1px solid var(--ob-control); border-radius:4px; overflow:hidden; }
.ob-pb-seg button { flex:1; text-align:center; padding:9px 0; border:0; background:transparent;
  color:var(--ob-dim); font:400 12px/1 var(--ob-font-mono); letter-spacing:.06em; }
.ob-pb-seg button.active { background:var(--ob-text); color:var(--ob-background); font-weight:600; }
/* The camera picker in the timeline bar is the same control at Pc's size. */
.ob-pb-seg.tight { flex:none; border-radius:4px; }
.ob-pb-seg.tight button { flex:none; padding:6px 12px; font-size:11px; }
.ob-pb-headrow { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:8px; }
.ob-pb-headrow .v { font:600 12px/1 var(--ob-font-mono); color:#ffd166; }
.ob-pb-range-box { display:flex; align-items:baseline; justify-content:space-between; gap:12px;
  padding:9px 12px; border:1px solid var(--ob-control); border-radius:4px; background:var(--ob-rail);
  font:400 11px/1 var(--ob-font-mono); color:var(--ob-dim); }
.ob-pb-range-box .v { font-weight:600; font-size:12px; color:#ffd166; }
.ob-pb-modal input[type=range] { width:100%; height:4px; appearance:none; background:var(--ob-seam);
  border-radius:2px; outline:none; }
.ob-pb-modal input[type=range]::-webkit-slider-thumb { appearance:none; width:12px; height:12px;
  border-radius:50%; background:#fff; box-shadow:0 0 0 3px rgba(232,98,42,.4); cursor:pointer; }
.ob-pb-modal input[type=range]::-moz-range-thumb { width:12px; height:12px; border:0;
  border-radius:50%; background:#fff; box-shadow:0 0 0 3px rgba(232,98,42,.4); cursor:pointer; }
.ob-pb-minmax { margin-top:6px; display:flex; justify-content:space-between;
  font:400 10px/1 var(--ob-font-mono); color:var(--ob-unavailable); }
.ob-pb-commit { display:flex; align-items:center; justify-content:space-between; gap:16px;
  padding-top:4px; border-top:1px solid #1c1c24; }
.ob-pb-est { font:400 11px/1.4 var(--ob-font-mono); color:#5a5a66; }
.ob-pb-est b { color:var(--ob-text-secondary); font-weight:400; }
.ob-pb-go { padding:13px 22px; border:1px solid var(--ob-accent); border-radius:5px;
  background:rgba(232,98,42,.18); font:600 14px/1 var(--ob-font-display); letter-spacing:.08em;
  text-transform:uppercase; color:var(--ob-text); }
.ob-pb-go:hover { background:rgba(232,98,42,.3); }
.ob-pb-spinner { width:44px; height:44px; border-radius:50%; border:3px solid rgba(255,255,255,.12);
  border-top-color:var(--ob-accent); animation:ob-pb-spin 900ms linear infinite; }
@keyframes ob-pb-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ob-pb-spinner { animation:none; } }
.ob-pb-progress { width:100%; }
.ob-pb-progress .track { height:6px; border-radius:3px; background:var(--ob-seam);
  position:relative; overflow:hidden; }
.ob-pb-progress .fill { position:absolute; left:0; top:0; bottom:0; border-radius:3px;
  background:var(--ob-accent); transition:width 120ms linear; }
.ob-pb-progress .legend { margin-top:8px; display:flex; justify-content:space-between;
  font:400 11px/1 var(--ob-font-mono); color:var(--ob-dim); }
.ob-pb-cancel { padding:10px 18px; border:1px solid var(--ob-control); border-radius:5px;
  background:transparent; font:400 12px/1 var(--ob-font-display); letter-spacing:.06em;
  text-transform:uppercase; color:var(--ob-dim); }
.ob-pb-cancel:hover { color:var(--ob-text-secondary); border-color:var(--ob-dim); }
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

/**
 * The curve glyphs from `Pc`, transcribed from the frame's own SVG paths.
 *
 * Drawn rather than computed from `applyEase` on purpose: these are 14x14
 * icons whose job is to be recognisable at a glance, and a faithful plot of
 * `bounceOut` at that size is a grey smudge. The frame already decided what
 * each one should look like.
 */
const EASE_GLYPH: Record<string, string> = {
  linear: 'M1 13L13 1',
  in: 'M1 13C1 6 6 1 13 1',
  out: 'M1 13C8 13 1 1 13 1',
  ease: 'M1 13C5 13 4 1 13 1',
  quad: 'M1 13C4 13 3 4 13 1',
  cubic: 'M1 13C6 13 2 7 7 7C11 7 8 1 13 1',
  bounce: 'M1 13C4 13 3 3 6 3C8 3 6 9 8 9C10 9 9 1 13 1',
};

function easeButton(key: string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('viewBox', '0 0 14 14');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', EASE_GLYPH[key] ?? EASE_GLYPH.linear);
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('fill', 'none');
  svg.appendChild(path);
  const text = document.createElement('span');
  text.textContent = label;
  btn.append(svg, text);
  return btn;
}

/** Which keyframe the easing picker is editing. */
interface Selection {
  track: TrackId;
  time: number;
}

export interface PlaybackChromeHooks {
  /** Transport. The session owns the clock; this only asks. */
  setPlaying(playing: boolean): void;
  seek(timeMs: number): void;
  /** A manual camera pick from the timeline bar. */
  setCamera(camera: PlaybackCamera): void;
  /** The free camera's pose right now, for a CAMERA POS keyframe. */
  cameraPose(): { x: number; y: number; z: number; yaw: number; pitch: number; roll: number };
  restart(): void;
  openSettings(): void;
  backToTitle(): void;
  /** The ✕, and Escape's "leave" answer: back to the library. */
  exit(): void;
  startExport(config: ExportConfig): void;
  cancelExport(): void;
}

export interface PlaybackChrome {
  /** The timeline being edited. Mutated in place by this file's controls. */
  readonly timeline: Timeline;
  readonly timelineOpen: boolean;
  readonly pauseOpen: boolean;
  /** True while any modal owns the keyboard -- pause, export or progress. */
  modalOpen(): boolean;
  /**
   * Close the topmost dismissable modal, and say whether there was one.
   *
   * Escape's answer depends on what is on screen, so the decision lives here
   * rather than in the session's key handler: only this file knows which
   * dialogs exist and which of them Escape may close. A render in progress
   * (`Pf`) is deliberately NOT dismissable -- stopping it is Cancel, which
   * has to abort the encoder rather than just hide the dialog.
   */
  dismissModal(): boolean;
  /**
   * Keyframe the free camera at the playhead: position, angles and fov.
   *
   * Exposed because the session owns the `K` key. It does NOT own the rule
   * about when a camera key is allowed: this refuses outside a FREE span, the
   * same way a double-press on the CAMERA POS lane does, so the hatch rule is
   * stated once. See the implementation for why refusing beats cutting.
   */
  keyCamera(timeMs: number): void;
  /**
   * Snapshot the timeline for undo, for an edit made OUTSIDE this file.
   *
   * There is exactly one: `playback-session.ts` writes a camera segment when
   * the viewer takes hold of the camera by hand (`beginFlying`). A cut is a
   * cut however it was made, and one that could not be undone would be the
   * only edit on this screen that could not.
   */
  pushUndo(): void;
  toggleTimeline(): void;
  openPause(): void;
  closePause(): void;
  /** Once a frame: repaint the transport against what actually happened. */
  update(timeMs: number, playing: boolean, camera: PlaybackCamera): void;
  /**
   * `Pf`. `total` of 0 closes it.
   *
   * `label` is the settings line under the title ("1080P · 60 FPS · 16 Mbps")
   * and is only read when the dialog is first opened -- the settings cannot
   * change mid-render, so repeating it every frame would be noise.
   */
  setExportProgress(done: number, total: number, etaMs: number, label?: string): void;
  exportFinished(message: string): void;
  dispose(): void;
}

export interface PlaybackChromeOptions {
  meta: ClipMeta;
  duration: number;
  timeline: Timeline;
  hooks: PlaybackChromeHooks;
}

export function createPlaybackChrome(
  parent: HTMLElement,
  options: PlaybackChromeOptions,
): PlaybackChrome {
  installStyle();
  const { meta, duration, timeline, hooks } = options;

  const root = document.createElement('div');
  root.className = 'ob-pb';
  root.innerHTML = `
    <div class="ob-pb-view">
      <div class="ob-pb-top">
        <div class="ob-pb-ident">
          <div class="ob-pb-name" data-name></div>
          <span class="ob-pb-badge" data-map></span>
          <span class="ob-pb-badge" data-phys></span>
          <span class="ob-pb-badge cam" data-cam></span>
        </div>
        <div class="ob-pb-top-actions">
          <div class="ob-pb-history" data-history hidden>
            <button type="button" data-undo title="Undo (Ctrl+Z)" aria-label="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-1"/></svg></button>
            <button type="button" data-redo title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h1"/></svg></button>
          </div>
          <button type="button" class="ob-pb-chip" data-toggle>Show timeline</button>
          <button type="button" class="ob-pb-chip accent" data-export hidden>Export video</button>
          <button type="button" class="ob-pb-x" data-close aria-label="Close playback">✕</button>
        </div>
      </div>
      <div class="ob-pb-float" data-float>
        <div class="ob-pb-row">
          <button type="button" class="ob-pb-play" data-play aria-label="Play or pause"><span></span><span></span></button>
          <div class="ob-pb-scrub" data-scrub><div class="fill"></div><div class="knob"></div></div>
          <div class="ob-pb-time" data-time></div>
        </div>
        <div class="ob-pb-hint">SPACE PLAY/PAUSE · T TIMELINE · K KEYFRAME · ESC MENU · MOVE KEYS + E/Q FREE CAM</div>
      </div>
    </div>
    <div class="ob-pb-panel" data-panel hidden>
      <div class="ob-pb-bar">
        <button type="button" class="ob-pb-play" data-play2 aria-label="Play or pause"><span></span><span></span></button>
        <div class="ob-pb-time" data-time2></div>
        <div class="ob-pb-sep"></div>
        <div class="ob-pb-label">CAMERA</div>
        <div class="ob-pb-seg tight" data-cams></div>
        <div class="ob-pb-spacer"></div>
        <div class="ob-pb-label">EASING</div>
        <div class="ob-pb-ease" data-ease></div>
      </div>
      <div class="ob-pb-scroll ob-pb-ruler-wrap" data-ruler-scroll>
        <div class="ob-pb-ruler-grid">
          <div class="ob-pb-ruler-zero">00:00.0</div>
          <div class="ob-pb-ruler" data-ruler>
            <div class="ob-pb-range" data-range></div>
            <div class="ob-pb-marker" data-in><div class="grip"></div><div class="stem"></div></div>
            <div class="ob-pb-marker" data-out><div class="grip"></div><div class="stem"></div></div>
            <div class="ob-pb-head" data-head></div>
          </div>
          <div class="ob-pb-ruler-end" data-duration></div>
        </div>
        <div class="ob-pb-ruler-legend">
          <span>IN <b data-in-label></b></span>
          <span data-range-label></span>
          <span>OUT <b data-out-label></b></span>
        </div>
      </div>
      <div class="ob-pb-tracks ob-pb-scroll" data-tracks></div>
    </div>`;
  parent.appendChild(root);

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const elName = q('[data-name]');
  const elMap = q('[data-map]');
  const elPhys = q('[data-phys]');
  const elCam = q('[data-cam]');
  const elToggle = q<HTMLButtonElement>('[data-toggle]');
  const elHistory = q('[data-history]');
  const elUndo = q<HTMLButtonElement>('[data-undo]');
  const elRedo = q<HTMLButtonElement>('[data-redo]');
  const elExport = q<HTMLButtonElement>('[data-export]');
  const elClose = q<HTMLButtonElement>('[data-close]');
  const elFloat = q('[data-float]');
  const elPlay = q<HTMLButtonElement>('[data-play]');
  const elPlay2 = q<HTMLButtonElement>('[data-play2]');
  const elScrub = q('[data-scrub]');
  const elScrubFill = q('.ob-pb-scrub .fill');
  const elScrubKnob = q('.ob-pb-scrub .knob');
  const elTime = q('[data-time]');
  const elTime2 = q('[data-time2]');
  const elPanel = q('[data-panel]');
  const elCams = q('[data-cams]');
  const elEase = q('[data-ease]');
  const elRulerScroll = q('[data-ruler-scroll]');
  const elRuler = q('[data-ruler]');
  const elDuration = q('[data-duration]');
  const elRange = q('[data-range]');
  const elIn = q('[data-in]');
  const elOut = q('[data-out]');
  const elHead = q('[data-head]');
  const elInLabel = q('[data-in-label]');
  const elOutLabel = q('[data-out-label]');
  const elRangeLabel = q('[data-range-label]');
  const elTracks = q('[data-tracks]');

  elName.textContent = meta.name;
  elMap.textContent = meta.map || '—';
  elPhys.textContent = meta.physics.toUpperCase();
  elDuration.textContent = formatClock(duration);

  /*
   * One scroll position for two scrollers.
   *
   * The ruler and the track list are separate `overflow-x` boxes because they
   * are separate stacking contexts with their own padding, but they are two
   * halves of ONE grid: a ruler scrolled away from the lanes it measures is
   * worse than a ruler that does not scroll at all. Mirrored rather than
   * driven from a single container because the assignment is cheap and the
   * alternative -- one scroller wrapping both -- would take the ruler out of
   * the panel's flow and let it scroll vertically with the rows.
   *
   * The equality test is what stops the echo: assigning an equal scrollLeft
   * fires no scroll event, so the two never bounce a rounding error back and
   * forth at each other.
   */
  const mirrorScroll = (from: HTMLElement, to: HTMLElement): void => {
    from.addEventListener('scroll', () => {
      if (to.scrollLeft !== from.scrollLeft) {
        to.scrollLeft = from.scrollLeft;
      }
    });
  };
  mirrorScroll(elRulerScroll, elTracks);
  mirrorScroll(elTracks, elRulerScroll);

  let timelineOpen = false;
  let selection: Selection | null = null;
  let ease: Ease = { ...DEFAULT_EASE };
  /**
   * The row whose value cell is currently a text field, if any.
   *
   * Read by `renderValues`, which runs every frame: without it the next
   * repaint would overwrite the field the user is typing into with the value
   * they are in the middle of replacing.
   */
  let editing: TrackRow | null = null;
  /**
   * -1, not 0, so the FIRST `update` always paints.
   *
   * The readout is only rewritten when the time changes, which is right --
   * it runs every rendered frame. But a clip opens at 0, so a sentinel of 0
   * means the transport shows an EMPTY time until something advances it:
   * open a clip, press Escape immediately, and there is no clock at all.
   */
  let lastTime = -1;
  let lastCamera: PlaybackCamera = meta.defaultCamera;
  /** The camera segments as they were last drawn -- see `update`. */
  let lastSegments = '';
  /**
   * The playhead, unconditionally. `lastTime` is a repaint sentinel and
   * starts at -1; this is the time the "+ Camera key" and "+ Cue" buttons
   * place at, and a key at -1 would be a key the ruler cannot draw.
   */
  let playhead = 0;
  /**
   * Ask the session to seek, and move the playhead HERE rather than waiting
   * for the answer to come back through `update`.
   *
   * `update` runs once a rendered frame, so between a click on the ruler and
   * the next frame this file's idea of the playhead is the OLD time -- and
   * "+ Camera key" placed its keyframe there, at wherever the playhead used
   * to be. One frame of staleness is invisible until the frame is slow, and
   * then it silently keys the wrong moment.
   */
  const seekTo = (t: number): void => {
    playhead = Math.min(duration, Math.max(0, t));
    hooks.seek(playhead);
  };
  /** Positions on the ruler and the scrubber are a fraction of the duration. */
  const frac = (ms: number): number => (duration > 0 ? Math.min(1, Math.max(0, ms / duration)) : 0);
  const pct = (ms: number): string => `${(frac(ms) * 100).toFixed(4)}%`;

  // ---- undo / redo --------------------------------------------------------

  /*
   * A SNAPSHOT stack, deliberately, and the proportion is the point.
   *
   * `Timeline` is plain data -- arrays of numbers, strings and two-field
   * objects -- so `structuredClone` of the whole thing is the complete state
   * of every edit this file can make, and restoring one is the complete undo
   * of any of them. The alternative, a command object per operation with its
   * own inverse, would be six classes that each have to be kept in step with
   * the edit they mirror, for a model that fits in a few hundred bytes. The
   * day a timeline is big enough for that to matter is the day this is worth
   * revisiting, and a ten-minute clip keyframed heavily is still kilobytes.
   *
   * 50 entries. A shot is composed in dozens of edits, not thousands, and 50
   * clones of a few kilobytes is nothing to hold; the cap exists so a session
   * left open all afternoon cannot grow without bound, not because 50 is a
   * number anyone will reach.
   */
  const UNDO_DEPTH = 50;
  const undoStack: Timeline[] = [];
  const redoStack: Timeline[] = [];
  /**
   * The state before a GESTURE, held until the gesture proves to be one.
   *
   * A drag must cost exactly one undo entry, not one per `pointermove` --
   * fifty entries for one nudge of a keyframe is a history nobody can walk
   * back through. But a press that never travels is a click, and a click that
   * changed nothing must cost no entry at all. So the press ARMS (clones,
   * cheaply, and holds it here) and the first move that clears `DRAG_SLOP`
   * COMMITS. A press that is released without moving drops it.
   */
  let armedUndo: Timeline | null = null;

  const snapshot = (): Timeline => structuredClone(timeline);

  const remember = (state: Timeline): void => {
    undoStack.push(state);
    if (undoStack.length > UNDO_DEPTH) {
      undoStack.shift();
    }
    // A new edit makes the redo branch unreachable. Keeping it would offer to
    // reapply a change on top of a timeline it was never computed against.
    redoStack.length = 0;
    renderHistory();
  };

  /** Before a one-shot edit: the whole of it happens in one call. */
  function pushUndo(): void {
    remember(snapshot());
  }

  /** The press of a gesture that may or may not turn into a drag. */
  const armUndo = (): void => {
    armedUndo = snapshot();
  };

  /** The first move of a drag: the armed snapshot becomes the one entry. */
  const commitArmedUndo = (): void => {
    if (armedUndo) {
      remember(armedUndo);
      armedUndo = null;
    }
  };

  /**
   * Restore IN PLACE, never by replacing the object.
   *
   * `playback-session.ts` holds the same `Timeline` by reference and reads it
   * every frame, and so does this file's own `timeline` property. Assigning a
   * fresh object here would undo the edit in this file's copy and leave the
   * session driving the old one -- an undo that appeared to work on the lanes
   * and changed nothing about the picture.
   */
  const restoreTimeline = (from: Timeline): void => {
    timeline.cameras.splice(0, timeline.cameras.length, ...from.cameras);
    timeline.tracks.splice(0, timeline.tracks.length, ...from.tracks);
    timeline.cues.splice(0, timeline.cues.length, ...from.cues);
    timeline.inPoint = from.inPoint;
    timeline.outPoint = from.outPoint;
  };

  /**
   * Repaint everything, and re-validate the selection.
   *
   * An undo can take away the very keyframe the easing picker is pointed at
   * -- undoing "place a keyframe" is exactly that -- and a `Selection`
   * naming a key that no longer exists would leave the picker lit, writing
   * every click into nothing.
   */
  const afterHistoryMove = (): void => {
    if (selection) {
      const track = findTrack(timeline, selection.track);
      const key = track?.keys.find((k) => k.time === selection?.time);
      if (key) {
        ease = key.ease;
      } else {
        selection = null;
        ease = { ...DEFAULT_EASE };
      }
    }
    renderModes();
    renderTracks();
    renderRuler();
    renderEase();
    renderValues();
    renderHistory();
  };

  const undo = (): void => {
    const previous = undoStack.pop();
    if (!previous) {
      return;
    }
    redoStack.push(snapshot());
    restoreTimeline(previous);
    afterHistoryMove();
  };

  const redo = (): void => {
    const next = redoStack.pop();
    if (!next) {
      return;
    }
    undoStack.push(snapshot());
    restoreTimeline(next);
    afterHistoryMove();
  };

  function renderHistory(): void {
    elUndo.disabled = undoStack.length === 0;
    elRedo.disabled = redoStack.length === 0;
  }

  elUndo.addEventListener('click', undo);
  elRedo.addEventListener('click', redo);

  // ---- transport ----------------------------------------------------------

  elPlay.addEventListener('click', () => hooks.setPlaying(!playing));
  elPlay2.addEventListener('click', () => hooks.setPlaying(!playing));
  elClose.addEventListener('click', () => hooks.exit());
  let playing = false;

  /**
   * Drag on a horizontal strip -> a clip time.
   *
   * Pointer CAPTURE, not a window-level mousemove: a scrub that leaves the
   * 4px-tall bar (which is every scrub) has to keep tracking, and capture is
   * what makes the element keep receiving moves without a global listener to
   * tear down. The same helper drives the scrubber, the ruler and both
   * in/out grips, which is the whole reason the scrubber is not an
   * `<input type=range>`.
   */
  /**
   * A double press, recognised on `pointerdown` rather than through
   * `dblclick`.
   *
   * Everything on this row already owns `pointerdown` and interferes with
   * it: the scrubber and the markers `preventDefault` so a drag does not
   * start a text selection, and the markers `stopPropagation` so the ruler
   * underneath cannot steal the pointer capture. `dblclick` is a synthesised
   * event riding on the `click` chain those handlers are disturbing, so
   * building the gesture on the event this component actually controls
   * removes a dependency rather than working around a specific browser
   * behaviour. It also means a lane's "press to select" and "double-press to
   * add or remove" are decided by the same event, in order, instead of
   * racing two.
   *
   * 400ms is the platform's own double-click window; 6px of slop keeps a hand
   * that drifts between the two presses from being read as one press twice.
   */
  const onDoublePress = (
    el: HTMLElement,
    handler: (e: PointerEvent) => void,
  ): { forget(): void } => {
    let lastAt = 0;
    let lastX = 0;
    el.addEventListener('pointerdown', (e) => {
      const now = performance.now();
      if (now - lastAt < 400 && Math.abs(e.clientX - lastX) < 6) {
        lastAt = 0;
        handler(e);
        return;
      }
      lastAt = now;
      lastX = e.clientX;
    });
    return {
      /**
       * Drop the press being remembered, so the next one starts a new pair.
       *
       * A press that turned into a DRAG was not half of a double-click, and
       * without this a user who nudged a keyframe twice in quick succession
       * would have deleted it on the second nudge.
       */
      forget(): void {
        lastAt = 0;
      },
    };
  };

  const draggable = (
    el: HTMLElement,
    /**
     * The pointer moved while held. Gets the raw event as well as the time,
     * because "has this press travelled far enough to be a drag" is a
     * question in PIXELS -- see `DRAG_SLOP`.
     */
    onMove: (timeMs: number, e: PointerEvent) => void,
    /**
     * What the pointer's X is measured AGAINST, when that is not `el` itself.
     *
     * The in/out markers are `width: 0` elements -- they are a position on
     * the ruler, and their grip is an absolutely-positioned child hanging off
     * that position. So measuring against `el` gave a zero-width rect and
     * every drag resolved to time 0: the markers could be grabbed and would
     * not move. They have to be measured against the RULER, which is the
     * thing whose width means something.
     */
    measure: HTMLElement = el,
    /**
     * The first press, when it means something different from a drag.
     *
     * The in/out grips use it to MEASURE rather than to move: a 12px grip
     * standing for a single time is pressed up to six pixels off the value it
     * grabbed, and remembering that offset is what makes the handle travel
     * with the pointer instead of jumping under it on contact. Moving on the
     * press would defeat that by definition.
     */
    onDown?: (timeMs: number, e: PointerEvent) => void,
  ): void => {
    const at = (e: PointerEvent): number => {
      const rect = measure.getBoundingClientRect();
      if (rect.width <= 0) {
        return 0;
      }
      return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * duration;
    };
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      el.setPointerCapture(e.pointerId);
      const t = at(e);
      if (onDown) {
        onDown(t, e);
      } else {
        onMove(t, e);
      }
      e.preventDefault();
      /*
       * This press belongs to THIS element, and no ancestor gets to start a
       * drag of its own with it.
       *
       * Load-bearing, and the reason the in/out markers could not be moved:
       * they are children of the ruler, and the ruler is `draggable` too. A
       * press on a grip ran the marker's handler and then the ruler's, and
       * the second `setPointerCapture` of a dispatch is the one that sticks
       * -- so capture landed on the RULER. Every following move and the
       * release were then delivered to the ruler, which scrubbed; the marker
       * kept `dragging === true` forever, having never seen its own
       * `pointerup`. Two nested draggables cannot share a press, so the
       * inner one takes it.
       */
      e.stopPropagation();
    });
    el.addEventListener('pointermove', (e) => {
      if (dragging) {
        onMove(at(e), e);
      }
    });
    const stop = (e: PointerEvent): void => {
      if (dragging) {
        dragging = false;
        el.releasePointerCapture(e.pointerId);
      }
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  };

  draggable(elScrub, (t) => seekTo(t));

  // ---- the timeline panel -------------------------------------------------

  const CAMERAS: readonly { id: PlaybackCamera; label: string }[] = [
    { id: 'free', label: 'FREE' },
    { id: 'fpv', label: 'FPV' },
    { id: 'chase', label: 'CHASE' },
    { id: 'side', label: 'SIDE' },
  ];
  const camButtons = new Map<PlaybackCamera, HTMLButtonElement>();
  for (const cam of CAMERAS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = cam.label;
    btn.title = `Cut to ${cam.label} at the playhead`;
    /*
     * A pill CUTS: it writes a camera segment at the playhead as well as
     * setting the live camera.
     *
     * It used to only do the second, which made "the camera should be
     * switchable in the timeline" mean a global switch applying to the whole
     * clip -- an export could not go from chase to free at four seconds, and
     * `timeline.cameras` was a model the UI never wrote to. The live camera
     * is still set because the session's own picture follows it whenever the
     * timeline has no segments at all, and because entering free cam is what
     * seeds the flown camera's pose from wherever the shot already was.
     */
    btn.addEventListener('click', () => {
      cutCameraAt(playhead, cam.id);
      hooks.setCamera(cam.id);
    });
    camButtons.set(cam.id, btn);
    elCams.appendChild(btn);
  }

  /**
   * Cut to `camera` at `time`, keeping everything before it looking the way
   * it already does.
   *
   * The head segment is the whole of the second half. With an empty list the
   * shot is whatever camera is live, from 0 to the end; write one segment at
   * four seconds and everything BEFORE it silently falls back to the clip's
   * own default instead -- so picking CHASE at 0:04 would also, invisibly,
   * change the first four seconds from free cam to FPV. Seeding the head with
   * the camera that was in effect makes the cut a cut rather than two.
   *
   * Same shape as `seedInitialKeys`: a first edit has to write the state that
   * was already implied, or it reads as having changed something it did not
   * touch.
   */
  function cutCameraAt(time: number, camera: PlaybackCamera): void {
    pushUndo();
    if (timeline.cameras.length === 0 && time > 0) {
      setCameraAt(timeline, 0, lastCamera);
    }
    setCameraAt(timeline, time, camera);
    renderModes();
    renderTracks();
  }

  /**
   * The easing picker writes to the SELECTED keyframe, and is inert with
   * nothing selected.
   *
   * Disabled rather than hidden: the control is part of the bar's layout in
   * `Pc`, and a bar that reflows when you click a diamond is worse than one
   * with four dim buttons in it. `#4a4a54`-adjacent dimming is exactly what
   * HANDOFF.md reserves for "unavailable", which this is.
   */
  const dirButtons = new Map<EaseDirection, HTMLButtonElement>();
  const famButtons = new Map<EaseFamily, HTMLButtonElement>();
  const applyEaseToSelection = (next: Ease): void => {
    ease = next;
    if (selection) {
      const track = findTrack(timeline, selection.track);
      const key = track?.keys.find((k) => k.time === selection?.time);
      if (key) {
        // An easing change is an edit to the shot like any other -- it is the
        // difference between a camera that arrives and one that glides in --
        // so it goes on the undo stack with the rest.
        pushUndo();
        key.ease = next;
      }
    }
    renderEase();
  };
  for (const dir of PICKER_DIRECTIONS) {
    const btn = easeButton(dir, dir.toUpperCase());
    btn.addEventListener('click', () => applyEaseToSelection(withDirection(ease, dir)));
    dirButtons.set(dir, btn);
    elEase.appendChild(btn);
  }
  const rule = document.createElement('div');
  rule.className = 'rule';
  elEase.appendChild(rule);
  for (const fam of PICKER_FAMILIES) {
    const btn = easeButton(fam, fam.toUpperCase());
    btn.addEventListener('click', () => applyEaseToSelection(withFamily(ease, fam)));
    famButtons.set(fam, btn);
    elEase.appendChild(btn);
  }

  function renderEase(): void {
    const live = selection !== null;
    for (const [dir, btn] of dirButtons) {
      btn.classList.toggle('active', live && ease.direction === dir);
      btn.disabled = !live;
    }
    for (const [fam, btn] of famButtons) {
      // A linear key has no family, so the family half greys out with it --
      // picking CUBIC while LINEAR is selected would show a state the curve
      // does not actually have.
      btn.classList.toggle('active', live && ease.direction !== 'linear' && ease.family === fam);
      btn.disabled = !live || ease.direction === 'linear';
    }
  }

  // The in/out markers, dragged independently of the playhead. Clamped past
  // each other so an inverted range cannot be expressed -- `frameTimes`
  // returns nothing for one, which would be an export that silently produced
  // no video.
  const MIN_RANGE = 100;
  /*
   * The grip is 12px wide and the marker it stands for is a single time, so
   * a press lands up to six pixels off the value it grabbed. Remembering
   * that offset and carrying it through the drag is what makes the handle
   * move WITH the pointer instead of jumping under it on contact -- and it
   * is why the press itself is `onDown` (which does nothing but measure)
   * rather than a move.
   */
  let grabOffset = 0;
  /*
   * The grips get the same one-entry-per-gesture treatment as the lanes, and
   * it costs nothing extra here: `draggable`'s `onDown` already exists to
   * MEASURE without moving, so the press arms and the first real `onMove`
   * commits. A grip pressed and released without travelling writes no entry,
   * which is right -- it changed nothing.
   */
  draggable(
    elIn,
    (t) => {
      commitArmedUndo();
      timeline.inPoint = Math.max(0, Math.min(t + grabOffset, timeline.outPoint - MIN_RANGE));
      renderRuler();
    },
    elRuler,
    (t) => {
      grabOffset = timeline.inPoint - t;
      armUndo();
    },
  );
  draggable(
    elOut,
    (t) => {
      commitArmedUndo();
      timeline.outPoint = Math.min(
        duration,
        Math.max(t + grabOffset, timeline.inPoint + MIN_RANGE),
      );
      renderRuler();
    },
    elRuler,
    (t) => {
      grabOffset = timeline.outPoint - t;
      armUndo();
    },
  );
  /**
   * How close, IN PIXELS, a press has to be to a keyframe to mean it.
   *
   * Pixels rather than milliseconds, which is the trap a time-based
   * tolerance walks into: 120ms is most of the ruler on a four-second clip
   * and a third of a pixel on a ten-minute one, so the target would be
   * either enormous or unhittable depending on the recording. What the hand
   * is aiming at is a diamond on screen, so the tolerance belongs in the
   * unit the diamond is drawn in.
   */
  const KEY_GRAB_PX = 9;

  /**
   * How far a press has to travel before it is a DRAG rather than a click.
   *
   * Shared by the ruler and every lane, because it answers the same question
   * in both: a hand that shifts a pixel while clicking a diamond must not
   * silently retime the shot, and below this a press still means what a
   * press means -- seek, on the ruler; select, on a lane.
   */
  const DRAG_SLOP = 3;

  /**
   * Retime one visible diamond, which may stand for several tracks, and
   * report where it landed.
   *
   * `from` stays the ORIGINAL time for every id. They all still have a key
   * there, and asking the later ones to move a key at the time the first one
   * just landed on finds nothing -- silently leaving all but one behind.
   * That has now failed that exact way three times (the CAMERA POS row that
   * owned three ids while the button wrote six; the first lane drag; and it
   * would have been this). **Whenever one mark stands for several tracks,
   * every operation on it has to name all of them, from the same starting
   * point.**
   *
   * The first id's clamped result becomes the target for the rest, so a key
   * that stopped short of a neighbour stops the whole group there rather
   * than splitting it.
   */
  const retimeKey = (ids: readonly TrackId[], from: number, to: number): number | null => {
    let landed: number | null = null;
    for (const id of ids) {
      const at = moveKeyframe(timeline, id, from, landed ?? to, duration);
      if (landed === null && at !== null) {
        landed = at;
      }
    }
    if (landed !== null && selection && selection.time === from && ids.includes(selection.track)) {
      selection = { track: selection.track, time: landed };
    }
    return landed;
  };

  /*
   * The ruler scrubs, and does nothing else.
   *
   * It used to carry a diamond per keyframe -- a summary of every track,
   * drawn once where the shape of the shot reads without scanning five rows
   * -- with press-to-seek, drag-to-retime and double-press-to-remove-across-
   * all-tracks hung off hit-testing them. They are gone: with per-property
   * keyframes on the lanes directly below, a second row of marks standing
   * for an unnamed mixture of tracks was redundant with the lanes and
   * confusing next to them, and one of the two rows had to be the one a
   * keyframe lives in.
   *
   * What the ruler keeps is what only it can say: where the export range is,
   * where the playhead is, and a press or a drag anywhere on it to move the
   * playhead there.
   */
  draggable(elRuler, (t) => seekTo(t));

  /*
   * CAMERA MODE: the first row, and the only one that is not a keyframe lane.
   *
   * A mode does not interpolate -- it HOLDS from the cut that set it until
   * the next cut -- so the row draws spans rather than diamonds: one tinted,
   * labelled bar per segment with a boundary line where the shot changes.
   * Read-only for now; the CAMERA pills in the bar above are what write a
   * segment, and flying the free camera writes one too.
   */
  const modeRow = document.createElement('div');
  modeRow.className = 'ob-pb-track';
  const modeName = document.createElement('span');
  modeName.className = 'ob-pb-track-name fixed';
  modeName.textContent = 'CAMERA MODE';
  const elModes = document.createElement('div');
  elModes.className = 'ob-pb-modes';
  elModes.title =
    'Which camera is active over time. The CAMERA buttons above cut to one at the playhead';
  const modeValue = document.createElement('div');
  modeValue.className = 'ob-pb-track-value';
  modeValue.textContent = 'mode';
  modeValue.title = 'FPV / FREE / CHASE / SIDE';
  modeRow.append(modeName, elModes, modeValue);
  elTracks.appendChild(modeRow);

  /**
   * The segments to DRAW, which is not quite `timeline.cameras`.
   *
   * An empty list means "no cuts", and the session resolves that to whatever
   * camera is live rather than to the clip's default -- `timeline.cameras.
   * length > 0 ? state.camera : camera` in `playback-session.ts`. So an empty
   * list is one segment spanning the whole clip, and the row agrees with the
   * picture instead of announcing a mode the viewer is not looking at.
   *
   * A first segment that starts after zero gets a head segment of the clip's
   * own default, which is what `evaluateCamera` falls back to there.
   */
  const modeSegments = (): CameraSegment[] => {
    if (timeline.cameras.length === 0) {
      return [{ time: 0, camera: lastCamera }];
    }
    const head = timeline.cameras[0];
    return head.time > 0
      ? [{ time: 0, camera: meta.defaultCamera }, ...timeline.cameras]
      : [...timeline.cameras];
  };

  /** The camera at `time`, by exactly the rule the session draws with. */
  const modeAt = (time: number): PlaybackCamera => {
    const segments = modeSegments();
    let current = segments[0].camera;
    for (const segment of segments) {
      if (segment.time > time) {
        break;
      }
      current = segment.camera;
    }
    return current;
  };

  function renderModes(): void {
    elModes.innerHTML = '';
    const segments = modeSegments();
    segments.forEach((segment, i) => {
      const next: CameraSegment | undefined = segments[i + 1];
      const band = document.createElement('div');
      // The mode's own class carries its tint -- see the `.ob-pb-mode` rules.
      band.className = `ob-pb-mode ${segment.camera}${next ? ' cut' : ''}`;
      band.style.left = pct(segment.time);
      band.style.right = next ? `${(100 - frac(next.time) * 100).toFixed(4)}%` : '0';
      band.textContent = segment.camera.toUpperCase();
      elModes.appendChild(band);
      if (i > 0) {
        const cut = document.createElement('div');
        cut.className = 'ob-pb-cut';
        cut.style.left = pct(segment.time);
        elModes.appendChild(cut);
      }
    });
  }

  /**
   * The spans a CAMERA POS lane is hatched over: everywhere the camera is not
   * FREE.
   *
   * Derived from the same segment list the row above draws, so the hatching
   * and the bar can never disagree about where a mode starts.
   */
  const hatchSpans = (): { from: number; to: number }[] => {
    const segments = modeSegments();
    const spans: { from: number; to: number }[] = [];
    segments.forEach((segment, i) => {
      if (segment.camera !== 'free') {
        const next: CameraSegment | undefined = segments[i + 1];
        spans.push({ from: segment.time, to: next ? next.time : duration });
      }
    });
    return spans;
  };

  const laneFor = new Map<TrackRow, HTMLElement>();
  const valueCellFor = new Map<TrackRow, HTMLElement>();
  /**
   * The fader hairline per lane, re-made on every `renderTracks`.
   *
   * It cannot be a permanent child: `renderTracks` empties each lane with
   * `innerHTML = ''`, so anything created once is gone the first time a
   * keyframe is added. Created there and MOVED here, by `renderValues`, which
   * runs every frame -- the line follows the playhead, so it has to be
   * cheaper than a full lane repaint.
   */
  const levelFor = new Map<TrackRow, HTMLElement>();
  for (const row of TRACK_ROWS) {
    const el = document.createElement('div');
    el.className = 'ob-pb-track';

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'ob-pb-track-name';
    name.textContent = row.label;
    name.title = UNCONSUMED_TRACKS.includes(row.ids[0])
      ? `${row.label} — keyframeable, but no render pass reads it yet`
      : `Click to enable or disable ${row.label}`;
    name.addEventListener('click', () => {
      const track = findTrack(timeline, row.ids[0]);
      if (track) {
        pushUndo();
        for (const id of row.ids) {
          const t = findTrack(timeline, id);
          if (t) {
            t.enabled = !track.enabled;
          }
        }
        renderTracks();
        renderValues();
      }
    });

    const lane = document.createElement('div');
    lane.className = row.scale ? 'ob-pb-lane fader' : 'ob-pb-lane';
    lane.title = row.hatchOutsideFree
      ? 'Only editable while CAMERA MODE is FREE at the playhead'
      : row.scale
        ? 'Drag up or down to set the value at the playhead · double-click to place a keyframe · drag one to retime it'
        : 'Double-click to place a keyframe · drag one to retime it · double-click one to remove it';
    /*
     * Double-press is the ONE gesture that creates and destroys, on the lane
     * as on the ruler: on a keyframe it removes, on bare lane it adds one
     * there.
     *
     * A single click used to add, which quietly made double-click useless:
     * a double-click IS two single clicks, so double-clicking bare lane
     * added a key, added it again over the top, and then removed it --
     * ending exactly where it started, with nothing on screen to say why.
     * That is the "I cannot just double-click on the camera position" report,
     * and it is why one gesture now owns both directions.
     *
     * The detector is on the LANE and not on the diamonds. The first click
     * selects the key, selecting re-renders the lane, and re-rendering
     * REPLACES every diamond in it -- so a detector living on a diamond sees
     * a first press and is then thrown away before the second arrives. The
     * lane survives its own repaint (`innerHTML = ''` empties it), so the
     * gesture is recognised somewhere stable and the key is found by
     * hit-testing, in pixels, exactly as the ruler does it.
     */
    const laneDouble = onDoublePress(lane, (e) => {
      const rect = lane.getBoundingClientRect();
      if (rect.width <= 0) {
        return;
      }
      const hit = keyUnderLane(lane, row, e.clientX);
      if (hit === null) {
        // Bare lane: a keyframe here, at the camera's CURRENT pose. Fly the
        // camera, then place the key -- see `flying` in playback-session.ts
        // for why a seek hands the camera back to the track.
        const time = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * duration;
        /*
         * ...unless the hatching says this stretch is not free cam.
         *
         * Only the ADD is refused. A key already sitting in a span that was
         * later cut to chase still has to be removable and retimeable, or
         * the only way to reach it would be to cut back to free cam first --
         * which is an edit to the shot, made in order to undo an edit to the
         * shot.
         */
        if (row.hatchOutsideFree && modeAt(time) !== 'free') {
          return;
        }
        addKey(row, time);
        renderRuler();
        return;
      }
      pushUndo();
      for (const id of row.ids) {
        removeKeyframe(timeline, id, hit);
      }
      if (selection?.track === row.ids[0] && selection.time === hit) {
        selection = null;
      }
      renderTracks();
      renderEase();
      renderRuler();
      renderValues();
    });

    /*
     * Drag a diamond along its lane to RETIME the keyframe.
     *
     * Tracked on the lane rather than on the diamond, for the same reason
     * the double-press is: each move re-renders the lane and replaces every
     * diamond in it, so a listener living on one would be thrown away
     * mid-gesture. The lane holds the pointer capture and the key is
     * followed by TIME, which is stable across those repaints in a way an
     * element reference is not.
     *
     * A press only becomes a drag after `DRAG_SLOP` pixels. Below that it is
     * a click -- which selects the key for the easing picker -- so a hand
     * that shifts a pixel while clicking does not silently retime the shot.
     */
    let dragging: { time: number; startX: number; moved: boolean } | null = null;
    /*
     * ...and drag BARE lane up or down to set the row's value at the playhead.
     *
     * ## Which gesture a press means is decided once, at the press
     *
     * Two drags share one lane and they cannot both arm, or the first move
     * would have to pick one after a `setPointerCapture` has already been
     * taken for both -- which is trap 16's failure with the two owners inside
     * one element instead of nested. The discriminator is WHAT IS UNDER THE
     * POINTER, not which way it later travels:
     *
     *   a press ON a diamond  -> retime, horizontal, exactly as before
     *   a press on BARE lane  -> set the value, vertical
     *
     * That is the same rule the ruler already uses for scrub-versus-retime
     * (phase L: "chosen once at the press and held for the whole drag"), and
     * it has to be: the pointer leaves the diamond immediately -- that is
     * what dragging it means -- so anything re-tested per move would flip
     * gesture one frame in.
     *
     * Deciding on direction instead was the tempting alternative and it is
     * unusable: a hand cannot promise the first three pixels of a drag are
     * vertical, so half of every retime would land as a value change on a
     * keyframe the user was trying to move.
     *
     * ## And a press that does not travel creates nothing
     *
     * Trap 13. The lane's double-press already adds a keyframe on bare lane,
     * and a double click IS two single clicks -- so if the value drag wrote
     * on the press, double-clicking bare lane would set a value, set it
     * again, and then add a key, with two of those three being edits nobody
     * asked for. It writes only after `DRAG_SLOP` pixels of VERTICAL travel,
     * which a double-click does not have.
     */
    let fading: {
      startY: number;
      startValue: number;
      /**
       * The playhead as it was at the PRESS, held for the whole gesture.
       *
       * Re-reading it per move would spray a keyframe across every
       * millisecond the clip advanced through while the hand was moving, if
       * the drag happened during playback.
       */
      time: number;
      moved: boolean;
    } | null = null;

    lane.addEventListener('pointerdown', (e) => {
      const hit = keyUnderLane(lane, row, e.clientX);
      if (hit !== null) {
        dragging = { time: hit, startX: e.clientX, moved: false };
        armUndo();
        lane.setPointerCapture(e.pointerId);
        return;
      }
      if (!row.scale) {
        return;
      }
      fading = {
        startY: e.clientY,
        startValue: valueAt(row) ?? row.fallback,
        time: playhead,
        moved: false,
      };
      armUndo();
      lane.setPointerCapture(e.pointerId);
      /*
       * No `preventDefault` here, and that is a decision rather than an
       * omission.
       *
       * It was here, to stop a vertical drag from painting a text selection
       * across the panel -- and a `preventDefault` on `pointerdown` also
       * suppresses the FOCUS change, so a value cell left open on another row
       * never blurred and never committed: the field sat there through the
       * whole drag and wrote its old number over the new one on the next
       * click. `user-select: none` on the lane solves the selection without
       * touching focus, which is what it is for.
       */
      /*
       * This press belongs to the lane. Nothing above it is draggable TODAY
       * -- the panel's ancestors are layout -- so this changes no behaviour,
       * and it is here because trap 16 is the bug that gets re-introduced by
       * adding an ancestor gesture later: capture cannot be shared, so the
       * inner owner has to claim the press before the outer one can see it.
       */
      e.stopPropagation();
    });

    lane.addEventListener('pointermove', (e) => {
      if (dragging) {
        if (!dragging.moved && Math.abs(e.clientX - dragging.startX) < DRAG_SLOP) {
          return;
        }
        if (!dragging.moved) {
          dragging.moved = true;
          // This press is a drag, not half of a double-click. Without this, two
          // quick nudges of the same keyframe would delete it on the second.
          laneDouble.forget();
          // One undo entry for the whole gesture -- see `armedUndo`.
          commitArmedUndo();
        }
        const rect = lane.getBoundingClientRect();
        if (rect.width <= 0) {
          return;
        }
        const wanted =
          Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * duration;
        // Every track the row owns moves TOGETHER -- a camera keyframe is one
        // pose, so its six tracks cannot end up at six different times. See
        // `retimeKey` for why they all start from `dragging.time`.
        const landed = retimeKey(row.ids, dragging.time, wanted);
        if (landed !== null) {
          dragging.time = landed;
        }
        renderTracks();
        renderRuler();
        renderValues();
        return;
      }
      const scale = row.scale;
      if (!fading || !scale) {
        return;
      }
      if (!fading.moved && Math.abs(e.clientY - fading.startY) < DRAG_SLOP) {
        return;
      }
      if (!fading.moved) {
        fading.moved = true;
        laneDouble.forget();
        commitArmedUndo();
      }
      /*
       * RELATIVE to where the press started, not absolute within the lane.
       *
       * The lane is 20 pixels tall. Mapping its height onto the value range
       * would make the control a twenty-step fader that also JUMPS to
       * whatever the press happened to land on -- the value would change
       * before the hand had moved at all, which is the same contact jump the
       * in/out grips carry a `grabOffset` to avoid.
       */
      const next =
        fading.startValue + ((fading.startY - e.clientY) / FADER_TRAVEL_PX) * (scale.max - scale.min);
      setRowValue(row, next, fading.time);
    });

    const endDrag = (e: PointerEvent): void => {
      if (!dragging && !fading) {
        return;
      }
      lane.releasePointerCapture(e.pointerId);
      dragging = null;
      fading = null;
      // A press that never travelled was a click, and a click costs no undo.
      armedUndo = null;
    };
    lane.addEventListener('pointerup', endDrag);
    lane.addEventListener('pointercancel', endDrag);

    /*
     * The 64px value cell: the row's value AT THE PLAYHEAD, and a text field.
     *
     * `renderValues` owns its contents from here on. CAMERA MODE and CAMERA
     * POS keep the fixed words the frame gives them -- neither is a scalar --
     * and every other row prints a number that is kept current every frame.
     */
    const value = document.createElement('div');
    value.className = 'ob-pb-track-value';
    value.textContent = row.staticValue ?? '';
    value.title = row.valueTitle;
    if (row.scale) {
      value.addEventListener('click', () => beginValueEdit(row, value));
    }

    el.append(name, lane, value);
    laneFor.set(row, lane);
    valueCellFor.set(row, value);
    elTracks.appendChild(el);
  }

  /**
   * How many pixels of vertical drag cover a track's whole display range.
   *
   * Not the lane's own height, which is 20px -- see the drag handler. 160 is
   * a comfortable forearm movement and gives FOV (50..140) a little over half
   * a degree per pixel, which is fine enough to land on a round number and
   * coarse enough to cross the range without letting go.
   */
  const FADER_TRAVEL_PX = 160;

  /** A row's value at the playhead, or null when its track says nothing. */
  const valueAt = (row: TrackRow): number | null => {
    const track = findTrack(timeline, row.ids[0]);
    return track ? evaluateTrack(track, playhead) : null;
  };

  /**
   * Write `value` to every track this row owns, at `time`.
   *
   * Clamped to the row's DISPLAY range, which is the one place that range is
   * more than presentation: a fader that runs off the end of its own scale
   * leaves a value the line cannot draw and the readout cannot be dragged
   * back from, and a negative vignette or a field of view of 4000 degrees is
   * not a shot anyone is composing.
   *
   * `setValueAt` rather than `setKeyframe`, and its header says why at
   * length: the playhead is a float, and an edit to a value is not an edit to
   * its easing.
   */
  function setRowValue(row: TrackRow, value: number, time: number): void {
    const scale = row.scale;
    if (!scale) {
      return;
    }
    const clamped = Math.min(scale.max, Math.max(scale.min, value));
    for (const id of row.ids) {
      setValueAt(timeline, id, time, clamped);
    }
    renderTracks();
    renderRuler();
    renderValues();
  }

  /**
   * The field a click on the readout opens.
   *
   * An `<input>` swapped into the same 64px cell rather than a `contenteditable`
   * or a prompt: it is the only one of the three that gives a real caret, a
   * real selection and real Escape/Enter semantics for free, and swapping it
   * into the cell keeps the row's grid from reflowing while it is open.
   */
  function beginValueEdit(row: TrackRow, cell: HTMLElement): void {
    const scale = row.scale;
    if (!scale || editing) {
      return;
    }
    const current = valueAt(row);
    const restore = cell.textContent ?? '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current === null ? '' : toInputText(scale, current);
    cell.textContent = '';
    cell.appendChild(input);
    editing = row;

    /*
     * Escape removes the field, removing a focused field fires `blur`, and
     * `blur` commits -- so without this flag, cancelling wrote the value it
     * had just been told to throw away. One flag rather than detaching the
     * listener, because the same race exists the other way round: Enter
     * commits and then blurs.
     */
    let settled = false;
    const finish = (commit: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      editing = null;
      const typed = input.value;
      input.remove();
      cell.textContent = restore;
      if (commit) {
        const parsed = parseValue(scale, typed);
        // Unparseable input REVERTS. The cell has already been put back, so
        // there is nothing else to do -- and writing NaN instead would
        // propagate through `evaluateTrack`'s interpolation and blank a whole
        // span of the shot, with a 64px cell reading NaN as the only clue.
        if (parsed !== null) {
          pushUndo();
          setRowValue(row, parsed, playhead);
        }
      }
      renderValues();
    };

    input.addEventListener('keydown', (e) => {
      /*
       * The field owns the keyboard while it is open.
       *
       * `playback-session.ts` listens for Space, K and T on `window`, so
       * typing a value into an unguarded field would pause the clip on the
       * space bar and toggle the whole panel on a `t`. Undo is stopped here
       * for the same reason: Ctrl+Z inside a text field means undo the
       * TYPING, which the browser already does.
       */
      e.stopPropagation();
      if (e.key === 'Enter') {
        finish(true);
      } else if (e.key === 'Escape') {
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
  }

  /**
   * Every value cell and every fader line, against the playhead.
   *
   * Runs once a frame out of `update`, unconditionally, which is why each
   * cell remembers the string it last printed: the work is four
   * `evaluateTrack` scans over a handful of keys each, and the DOM is touched
   * only when a number actually changed. Gating the whole call on "the time
   * moved" was the first version and it is subtly wrong -- an edit made while
   * the clip is paused changes the value at a playhead that did not move, so
   * the readout would sit there stale until something else nudged the clock.
   */
  function renderValues(): void {
    for (const [row, cell] of valueCellFor) {
      const scale = row.scale;
      if (!scale || editing === row) {
        continue;
      }
      const value = valueAt(row);
      const off = value === null || (scale.zeroIsOff && value === 0);
      const text = off ? VALUE_OFF : formatValue(scale, value);
      if (cell.textContent !== text) {
        cell.textContent = text;
      }
      cell.classList.toggle('live', !off);
      cell.classList.toggle('off', off);

      const level = levelFor.get(row);
      if (level) {
        level.hidden = value === null;
        if (value !== null) {
          const t = (value - scale.min) / (scale.max - scale.min);
          level.style.top = `${((1 - Math.min(1, Math.max(0, t))) * 100).toFixed(2)}%`;
        }
      }
    }
  }

  /**
   * Place a keyframe on every track this row owns, at the CURRENT value.
   *
   * "Current" is the live camera pose for the position row and the row's
   * fallback for the look rows, which is the behaviour a keyframe button has
   * everywhere: you fly the camera somewhere, you press the key, the pose is
   * recorded. Reading it back out of the timeline instead would record the
   * value the timeline already had, which is a no-op key.
   */
  /**
   * One row's keys at `time`, at the row's current value. No re-render, no
   * selection -- the callers decide both, because seeding a whole timeline
   * wants one repaint rather than five.
   */
  function writeRowKey(row: TrackRow, time: number): void {
    const pose = hooks.cameraPose();
    const valueFor = (id: TrackId): number => {
      switch (id) {
        case 'camX':
          return pose.x;
        case 'camY':
          return pose.y;
        case 'camZ':
          return pose.z;
        case 'camYaw':
          return pose.yaw;
        case 'camPitch':
          return pose.pitch;
        case 'camRoll':
          return pose.roll;
        default:
          return findTrack(timeline, id)?.keys.at(-1)?.value ?? row.fallback;
      }
    };
    for (const id of row.ids) {
      // DEFAULT_EASE, not the picker's current `ease`.
      //
      // The picker edits the SELECTED key; it is disabled when nothing is
      // selected, so nothing on screen says it also seeds new ones. It did,
      // and the result was that choosing BOUNCE once to fix one key silently
      // made every later key bounce. A new key is linear, you select it, you
      // pick its curve.
      setKeyframe(timeline, id, time, valueFor(id), { ...DEFAULT_EASE });
    }
  }

  function addKey(row: TrackRow, time: number): void {
    pushUndo();
    writeRowKey(row, time);
    sortTimeline(timeline);
    selection = { track: row.ids[0], time };
    ease = { ...DEFAULT_EASE };
    renderTracks();
    renderEase();
    // The ruler draws the timeline's keyframes, so a new one shows up there
    // too -- that is the whole point of there being one kind of mark.
    renderRuler();
    renderValues();
  }

  /**
   * Keyframe the whole camera -- position AND angles AND fov -- at `time`.
   *
   * This is the gesture that makes interpolation reachable. Keying position
   * alone through the CAMERA POS lane leaves the camera pointing wherever the
   * last free-flight left it, so a two-key move slid sideways without ever
   * looking at anything; and there was no way at all to key from the
   * playhead, only from wherever a lane happened to be clicked. Fly, press
   * K, scrub, fly, press K: two keys and the camera flies the shot between
   * them on the easing each key carries.
   */
  /**
   * The keyframe time under the pointer on this row's lane, or null.
   *
   * In PIXELS, like the ruler's, and shared by the two gestures that need it
   * so they can never disagree about what is being pointed at.
   */
  const keyUnderLane = (lane: HTMLElement, row: TrackRow, clientX: number): number | null => {
    const rect = lane.getBoundingClientRect();
    if (rect.width <= 0) {
      return null;
    }
    const track = findTrack(timeline, row.ids[0]);
    let hit: number | null = null;
    let bestGap = KEY_GRAB_PX;
    for (const key of track?.keys ?? []) {
      const gap = Math.abs(rect.left + frac(key.time) * rect.width - clientX);
      if (gap <= bestGap) {
        bestGap = gap;
        hit = key.time;
      }
    }
    return hit;
  };

  /** The row that owns the camera pose -- see `TRACK_ROWS`. */
  const cameraRow = TRACK_ROWS[0]!;

  /**
   * Keyframe the camera where it is now, at `time`.
   *
   * This is exactly what a double-press on the CAMERA POS lane does, and
   * that is the point: there is one way to make a camera keyframe and the
   * `K` shortcut is a shortcut TO it, not a second mechanism beside it. It
   * used to be a button of its own writing a different set of tracks, which
   * is why keys made one way interpolated and keys made the other way did
   * not.
   */
  function keyCameraAt(time: number): void {
    addKey(cameraRow, time);
  }

  function renderTracks(): void {
    for (const [row, lane] of laneFor) {
      lane.innerHTML = '';
      levelFor.delete(row);
      if (row.scale) {
        /*
         * The fader line, FIRST, so every diamond draws over it.
         *
         * Re-made here rather than kept as a permanent child because the line
         * above empties the lane -- and positioned by `renderValues` rather
         * than here, because the value it shows is the value at the playhead
         * and that changes every frame, while this function rebuilds a whole
         * row of buttons and must not.
         */
        const level = document.createElement('div');
        level.className = 'ob-pb-level';
        level.hidden = true;
        lane.appendChild(level);
        levelFor.set(row, level);
      }
      if (row.hatchOutsideFree) {
        // Painted before the diamonds, so a key stranded in a hatched span is
        // still visible on top of it -- it is still the thing you have to be
        // able to grab to get rid of it.
        for (const span of hatchSpans()) {
          const hatch = document.createElement('div');
          hatch.className = 'ob-pb-hatch';
          hatch.style.left = pct(span.from);
          hatch.style.right = `${(100 - frac(span.to) * 100).toFixed(4)}%`;
          lane.appendChild(hatch);
        }
      }
      const track = findTrack(timeline, row.ids[0]);
      lane.parentElement?.querySelector('.ob-pb-track-name')?.classList.toggle(
        'off',
        track !== undefined && !track.enabled,
      );
      if (!track) {
        continue;
      }
      for (const key of track.keys) {
        const diamond = document.createElement('button');
        diamond.type = 'button';
        diamond.className = 'ob-pb-key';
        diamond.style.left = pct(key.time);
        diamond.title = `${formatClock(key.time)} — ${key.value.toFixed(2)}`;
        diamond.classList.toggle(
          'sel',
          selection?.track === row.ids[0] && selection.time === key.time,
        );
        diamond.addEventListener('click', (e) => {
          e.stopPropagation();
          selection = { track: row.ids[0], time: key.time };
          ease = key.ease;
          renderTracks();
          renderEase();
        });
        lane.appendChild(diamond);
      }
    }
    // The fader lines were just re-made and are still hidden at the top of
    // their lanes; only `renderValues` knows where they go. Called from here
    // rather than left to every caller, because "repaint the lanes" and "the
    // lines in them are in the right place" are not two things a caller
    // should have to remember to ask for separately.
    renderValues();
  }

  function renderRuler(): void {
    elRange.style.left = pct(timeline.inPoint);
    elRange.style.right = `${(100 - frac(timeline.outPoint) * 100).toFixed(4)}%`;
    elIn.style.left = pct(timeline.inPoint);
    elOut.style.left = pct(timeline.outPoint);
    elInLabel.textContent = formatClock(timeline.inPoint);
    elOutLabel.textContent = formatClock(timeline.outPoint);
    const span = timeline.outPoint - timeline.inPoint;
    elRangeLabel.textContent =
      `Export range ${formatClock(timeline.inPoint)} – ${formatClock(timeline.outPoint)} ` +
      `(${formatSpan(span)} of ${formatClock(duration)})`;
  }

  function renderCameras(camera: PlaybackCamera): void {
    for (const [id, btn] of camButtons) {
      btn.classList.toggle('active', id === camera);
    }
    elCam.textContent = camera === 'free' ? 'FREE CAM' : `${camera.toUpperCase()} — FIXED`;
    elCam.className = camera === 'free' ? 'ob-pb-badge free' : 'ob-pb-badge cam';
  }

  renderRuler();
  renderModes();
  renderTracks();
  renderEase();
  renderHistory();
  renderCameras(meta.defaultCamera);

  // ---- modals -------------------------------------------------------------

  let pauseEl: HTMLElement | null = null;
  let exportEl: HTMLElement | null = null;
  let progressEl: HTMLElement | null = null;
  let progressFill: HTMLElement | null = null;
  let progressPct: HTMLElement | null = null;
  let progressEta: HTMLElement | null = null;

  const scrim = (cls: string): { scrim: HTMLElement; modal: HTMLElement } => {
    const s = document.createElement('div');
    s.className = 'ob-pb-scrim';
    const m = document.createElement('div');
    m.className = `ob-pb-modal ${cls}`;
    s.appendChild(m);
    parent.appendChild(s);
    return { scrim: s, modal: m };
  };

  function closePause(): void {
    pauseEl?.remove();
    pauseEl = null;
  }

  function openPause(): void {
    if (pauseEl) {
      return;
    }
    const { scrim: s, modal } = scrim('pause');
    pauseEl = s;
    const head = document.createElement('div');
    head.innerHTML = '<div class="ob-pb-kicker">PLAYBACK PAUSED</div>';
    const title = document.createElement('div');
    title.className = 'ob-pb-modal-title';
    title.textContent = meta.name;
    head.appendChild(title);

    const menu = document.createElement('div');
    menu.className = 'ob-pb-menu';
    const item = (label: string, cls: string, onClick: () => void): void => {
      const b = document.createElement('button');
      b.type = 'button';
      if (cls) {
        b.className = cls;
      }
      b.textContent = label;
      b.addEventListener('click', onClick);
      menu.appendChild(b);
    };
    item('Resume', 'primary', () => {
      closePause();
      hooks.setPlaying(true);
    });
    item('Restart playback', '', () => {
      closePause();
      hooks.restart();
    });
    item('Settings', '', () => hooks.openSettings());
    // "Back to title", not "Back to courses" -- playback is not tied to a
    // course run, so the destination course select would offer is not where
    // this came from. `Pd` spells it out.
    item('Back to title', 'quiet', () => hooks.backToTitle());
    modal.append(head, menu);
  }

  function closeExport(): void {
    exportEl?.remove();
    exportEl = null;
  }

  function openExport(): void {
    if (exportEl || progressEl) {
      return;
    }
    const config: ExportConfig = {
      ...defaultExportConfig(duration),
      inPoint: timeline.inPoint,
      outPoint: timeline.outPoint,
    };
    const { scrim: s, modal } = scrim('wide');
    exportEl = s;

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between';
    const h = document.createElement('h2');
    h.textContent = 'Export video';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'ob-pb-x';
    x.style.cssText = 'width:26px;height:26px;font-size:12px';
    x.textContent = '✕';
    x.addEventListener('click', closeExport);
    head.append(h, x);

    const field = (label: string): { wrap: HTMLElement; body: HTMLElement } => {
      const wrap = document.createElement('div');
      wrap.className = 'ob-pb-field';
      const k = document.createElement('div');
      k.className = 'k';
      k.textContent = label;
      const body = document.createElement('div');
      wrap.append(k, body);
      return { wrap, body };
    };

    const res = field('RESOLUTION');
    const resSeg = document.createElement('div');
    resSeg.className = 'ob-pb-seg';
    const resNote = document.createElement('div');
    resNote.className = 'note';
    const resButtons = new Map<string, HTMLButtonElement>();
    let resId = '1080p';
    const pickRes = (id: string): void => {
      const found = RESOLUTIONS.find((rr) => rr.id === id);
      if (!found) {
        return;
      }
      resId = id;
      config.width = found.width;
      config.height = found.height;
      resNote.textContent = found.note;
      for (const [rid, b] of resButtons) {
        b.classList.toggle('active', rid === resId);
      }
      refreshEstimate();
    };
    for (const r of RESOLUTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r.label;
      b.addEventListener('click', () => pickRes(r.id));
      resButtons.set(r.id, b);
      resSeg.appendChild(b);
    }
    res.body.append(resSeg, resNote);

    const fps = field('FRAMERATE');
    const fpsSeg = document.createElement('div');
    fpsSeg.className = 'ob-pb-seg';
    const fpsButtons = new Map<number, HTMLButtonElement>();
    for (const f of FRAMERATES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${f} FPS`;
      b.addEventListener('click', () => {
        config.fps = f;
        for (const [ff, bb] of fpsButtons) {
          bb.classList.toggle('active', ff === f);
        }
        refreshEstimate();
      });
      fpsButtons.set(f, b);
      fpsSeg.appendChild(b);
    }
    fps.body.appendChild(fpsSeg);

    const rate = document.createElement('div');
    rate.className = 'ob-pb-field';
    const rateHead = document.createElement('div');
    rateHead.className = 'ob-pb-headrow';
    const rateValue = document.createElement('span');
    rateValue.className = 'v';
    rateHead.innerHTML = '<span class="k" style="margin:0">BITRATE</span>';
    rateHead.appendChild(rateValue);
    const rateInput = document.createElement('input');
    rateInput.type = 'range';
    rateInput.min = '4';
    rateInput.max = '40';
    rateInput.step = '1';
    rateInput.value = String(config.bitrateMbps);
    rateInput.addEventListener('input', () => {
      config.bitrateMbps = rateInput.valueAsNumber;
      rateValue.textContent = `${config.bitrateMbps} Mbps`;
      refreshEstimate();
    });
    const rateMinMax = document.createElement('div');
    rateMinMax.className = 'ob-pb-minmax';
    rateMinMax.innerHTML = '<span>4 Mbps</span><span>40 Mbps</span>';
    rate.append(rateHead, rateInput, rateMinMax);

    // RANGE is read-only here on purpose: the ruler's in/out markers are the
    // one source of truth for it (`Pe`, "not re-editable here"). Two places
    // to set the same number is how they end up disagreeing.
    const range = field('RANGE');
    const rangeBox = document.createElement('div');
    rangeBox.className = 'ob-pb-range-box';
    const rangeValue = document.createElement('span');
    rangeValue.className = 'v';
    rangeBox.innerHTML = '<span>Set from timeline in/out markers</span>';
    rangeBox.appendChild(rangeValue);
    range.body.appendChild(rangeBox);

    const commit = document.createElement('div');
    commit.className = 'ob-pb-commit';
    const est = document.createElement('div');
    est.className = 'ob-pb-est';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'ob-pb-go';
    go.textContent = 'Start rendering…';
    go.addEventListener('click', () => {
      closeExport();
      hooks.startExport({ ...config });
    });
    commit.append(est, go);

    function refreshEstimate(): void {
      const span = Math.max(0, config.outPoint - config.inPoint);
      rangeValue.textContent =
        `${formatClock(config.inPoint)} – ${formatClock(config.outPoint)} (${formatSpan(span)})`;
      // Bitrate times duration, which is what a constant-bitrate encode
      // actually produces. Deliberately not adjusted for resolution: the
      // bitrate is the budget, and a 4K clip at 16 Mbps is the same size as a
      // 720p one at 16 Mbps and merely worse.
      const bytes = (config.bitrateMbps * 1_000_000 * (span / 1000)) / 8;
      est.innerHTML = `Est. file size <b>~${(bytes / 1_000_000).toFixed(0)} MB</b>`;
    }

    pickRes(resId);
    fpsButtons.get(config.fps)?.classList.add('active');
    rateValue.textContent = `${config.bitrateMbps} Mbps`;
    refreshEstimate();

    modal.append(head, res.wrap, fps.wrap, rate, range.wrap, commit);
  }

  elExport.addEventListener('click', openExport);

  function setExportProgress(done: number, total: number, etaMs: number, label = ''): void {
    if (total <= 0) {
      progressEl?.remove();
      progressEl = null;
      return;
    }
    if (!progressEl) {
      const { scrim: s, modal } = scrim('progress');
      progressEl = s;
      const spin = document.createElement('div');
      spin.className = 'ob-pb-spinner';
      const head = document.createElement('div');
      const title = document.createElement('div');
      title.style.cssText = "font:600 18px/1 var(--ob-font-display);letter-spacing:.02em";
      title.textContent = 'Rendering video…';
      const sub = document.createElement('div');
      sub.style.cssText =
        'margin-top:6px;font:400 11px/1 var(--ob-font-mono);letter-spacing:.05em;color:var(--ob-dim)';
      sub.dataset.sub = '';
      sub.textContent = label;
      head.append(title, sub);

      const bar = document.createElement('div');
      bar.className = 'ob-pb-progress';
      bar.innerHTML =
        '<div class="track"><div class="fill" style="width:0%"></div></div>' +
        '<div class="legend"><span data-pct>0%</span><span data-eta></span></div>';

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'ob-pb-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => hooks.cancelExport());

      modal.append(spin, head, bar, cancel);
      progressFill = bar.querySelector('.fill');
      progressPct = bar.querySelector('[data-pct]');
      progressEta = bar.querySelector('[data-eta]');
    }
    const ratio = Math.min(1, done / total);
    if (progressFill) {
      progressFill.style.width = `${(ratio * 100).toFixed(1)}%`;
    }
    if (progressPct) {
      progressPct.textContent = `${Math.round(ratio * 100)}%`;
    }
    if (progressEta) {
      progressEta.textContent =
        etaMs > 0 && Number.isFinite(etaMs) ? `${formatClock(etaMs)} remaining` : '';
    }
  }

  function exportFinished(message: string): void {
    if (!progressEl) {
      return;
    }
    const sub = progressEl.querySelector<HTMLElement>('[data-sub]');
    if (sub) {
      sub.textContent = message;
    }
    setExportProgress(0, 0, 0);
  }

  // ---- the two views ------------------------------------------------------

  function setTimelineOpen(open: boolean): void {
    timelineOpen = open;
    elPanel.hidden = !open;
    // The floating transport IS the timeline's transport when the panel is
    // open -- `Pc` has one play button, not two.
    elFloat.hidden = open;
    elExport.hidden = !open;
    // Undo and redo go with the panel, because there is nothing to undo
    // without it: `Pb` has no edit in it at all, and the frame draws the pair
    // only in `Pc`.
    elHistory.hidden = !open;
    elToggle.textContent = open ? 'Hide timeline' : 'Show timeline';
    // Opening the timeline switches to the free camera, per `Pc`: the whole
    // point of the panel is shot composition, and every track it exposes
    // except FOV is meaningless from a camera the clip is driving.
    hooks.setCamera(open ? 'free' : meta.defaultCamera);
    if (open) {
      seedInitialKeys();
    }
  }

  /**
   * Give every track a keyframe at 0:00.0 holding the value it starts with.
   *
   * Interpolation needs somewhere to come FROM. Without this, keying the
   * camera at four seconds produced a track with exactly one key, which
   * holds that value across the whole clip -- so the camera did not travel,
   * it teleported into position at the start and sat there, and "the
   * interpolation does not work" is the correct reading of what that looks
   * like. With a key at zero, the first key the user places is the second
   * key of a pair, and the shot moves from the opening frame.
   *
   * Once only, and only for a track that has no keys yet: re-seeding on
   * every open would overwrite a zero key the user had deliberately moved or
   * retimed. The camera rows read the live pose, which is why this runs
   * AFTER `hooks.setCamera('free')` above -- the free camera has to have
   * been placed before there is a pose worth recording.
   */
  function seedInitialKeys(): void {
    let added = false;
    for (const row of TRACK_ROWS) {
      if (findTrack(timeline, row.ids[0])) {
        continue;
      }
      writeRowKey(row, 0);
      added = true;
    }
    if (added) {
      sortTimeline(timeline);
      renderTracks();
      renderRuler();
    }
  }

  elToggle.addEventListener('click', () => setTimelineOpen(!timelineOpen));

  /**
   * Ctrl+Z and Ctrl+Shift+Z, and the three conditions on them.
   *
   * - **Only with the panel open.** `Pb` has no editing surface at all, so an
   *   undo there would silently rewrite a timeline the viewer cannot see.
   *   This is what "while the timeline panel has focus" means on a panel
   *   whose controls are divs: the panel being the mode that is up.
   * - **Never under a modal.** `modalOpen()` already answers it, and a render
   *   in progress is the case that matters -- undoing the timeline the
   *   encoder is halfway through reading would change the shot mid-file.
   * - **Never while a value cell is being typed into.** Ctrl+Z inside a text
   *   field means undo the TYPING, which the browser does itself; the field
   *   also stops the event on its own, and this is the belt to that's braces.
   *
   * `metaKey` as well as `ctrlKey`, because this is Cmd+Z on a Mac and a
   * playback screen is a thing people will open on a laptop.
   */
  const onHistoryKey = (e: KeyboardEvent): void => {
    if (!timelineOpen || editing !== null) {
      return;
    }
    if (pauseEl !== null || exportEl !== null || progressEl !== null) {
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'z') {
      return;
    }
    e.preventDefault();
    if (e.shiftKey) {
      redo();
    } else {
      undo();
    }
  };
  window.addEventListener('keydown', onHistoryKey);

  return {
    timeline,
    get timelineOpen(): boolean {
      return timelineOpen;
    },
    get pauseOpen(): boolean {
      return pauseEl !== null;
    },
    modalOpen(): boolean {
      return pauseEl !== null || exportEl !== null || progressEl !== null;
    },
    dismissModal(): boolean {
      if (exportEl) {
        closeExport();
        return true;
      }
      if (pauseEl) {
        closePause();
        return true;
      }
      return false;
    },
    keyCamera(timeMs: number): void {
      playhead = timeMs;
      /*
       * REFUSED outside a FREE span, and this is the fix for the one place
       * the hatch rule was not enforced.
       *
       * `K` used to be gated on the LIVE camera in `playback-session.ts`, so
       * it could key a pose at a playhead whose CAMERA MODE segment is not
       * FREE -- cut to chase at four seconds, scrub to five, press K, and a
       * camera keyframe lands in a hatched span where nothing will ever drive
       * it. The lane refuses that add for exactly this reason.
       *
       * Refuse rather than cut to FREE, which was the other option. Two
       * arguments, and the first is decisive: `keyCameraAt`'s own comment
       * says there is ONE way to make a camera keyframe and `K` is a shortcut
       * TO it, not a second mechanism beside it -- and the one way refuses
       * here. Making `K` cut instead would re-create exactly the divergence
       * that comment records, with the shortcut doing more than the gesture
       * it stands for. The second is that cutting would not even be a clean
       * cut: `freeStarted` in the session means re-entering free cam does NOT
       * re-seed the flown pose from the camera being left, so `K` in chase
       * would jump the shot to wherever free cam was last parked and then key
       * THAT -- a keyframe of a pose the viewer never chose.
       *
       * Silent, like the lane. Cutting to FREE with the CAMERA pills is one
       * click, and it is an edit to the shot that should be made on purpose.
       */
      if (modeAt(timeMs) !== 'free') {
        return;
      }
      keyCameraAt(timeMs);
    },
    pushUndo,
    toggleTimeline(): void {
      setTimelineOpen(!timelineOpen);
    },
    openPause,
    closePause,
    update(timeMs: number, isPlaying: boolean, camera: PlaybackCamera): void {
      playing = isPlaying;
      elPlay.classList.toggle('paused', !isPlaying);
      elPlay2.classList.toggle('paused', !isPlaying);
      playhead = timeMs;
      if (timeMs !== lastTime) {
        lastTime = timeMs;
        const label = `${formatClock(timeMs)} / ${formatClock(duration)}`;
        elTime.textContent = label;
        elTime2.textContent = label;
        elScrubFill.style.width = pct(timeMs);
        elScrubKnob.style.left = pct(timeMs);
        elHead.style.left = pct(timeMs);
      }
      /*
       * Outside the time gate, deliberately.
       *
       * The readouts are a function of the timeline AS WELL AS the playhead,
       * and an edit made while the clip is paused changes the first without
       * touching the second -- so gating this on "the time moved" would leave
       * a stale number on screen until something else nudged the clock. It is
       * four short scans and no DOM write when nothing changed; see
       * `renderValues`.
       */
      renderValues();
      /*
       * The mode row repaints when the camera changes OR when the segment
       * list does, and the second half is not redundant.
       *
       * Flying the free camera writes a segment from inside the session (see
       * `beginFlying` there), so the list can change without this file having
       * touched it and without the active camera differing from the frame
       * before -- a cut to free while already looking through the free camera
       * is exactly that case. Comparing a signature rather than exposing a
       * "the segments changed" hook keeps every writer, present and future,
       * from having to remember to call one.
       */
      const signature = timeline.cameras.map((s) => `${s.time}:${s.camera}`).join();
      if (camera !== lastCamera || signature !== lastSegments) {
        lastCamera = camera;
        lastSegments = signature;
        renderCameras(camera);
        renderModes();
        // The CAMERA POS hatching is drawn from the same segments.
        renderTracks();
      }
    },
    setExportProgress,
    exportFinished,
    dispose(): void {
      closePause();
      closeExport();
      setExportProgress(0, 0, 0);
      // The one listener this file puts on `window`. Everything else is on an
      // element under `root` and goes with it.
      window.removeEventListener('keydown', onHistoryKey);
      root.remove();
    },
  };
}
