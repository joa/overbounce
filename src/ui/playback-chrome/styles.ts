/**
 * The playback chrome's stylesheet, and the one-shot that installs it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Split out of playback-chrome.ts as a whole, comments included: the rules
 * here explain themselves at length because several of them carry behaviour
 * in ways CSS does not advertise -- the [hidden] override, the ruler's
 * z-index of 0, the lane's user-select -- and every one of those was paid for
 * by a bug someone reported.
 *
 * ## Never write a backtick below this comment
 *
 * The whole sheet is ONE template literal, and a backtick anywhere inside it
 * -- a CSS comment included, since the literal does not know what a CSS
 * comment is -- ends the literal early. What follows is then parsed as
 * TypeScript, so the error lands hundreds of lines away from the character
 * that caused it and says nothing about quoting. That has broken this build
 * six times, twice in one week. Name a class in a comment in this file with
 * no quoting at all, the way the rules below already do.
 *
 * This header is above the literal and so is free to quote normally, but it
 * does not, on the grounds that the next person to add a comment here will
 * copy the style of the one they are looking at.
 */

export const STYLE = `
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

export function installStyle(): void {
  if (styleInstalled) {
    return;
  }
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  styleInstalled = true;
}
