/**
 * DOM overlay HUD.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Plain DOM, no three.js. Built against `design/Overbounce HUD spec.dc.html`
 * (frames Sa-Sh, Sf, Sg) -- one layout, six runtime states, fixed anchors.
 * See `.agent/plans/UI.md` R3. Measurements below are copied from that
 * mockup's inline styles, not estimated from `design/HANDOFF.md`'s rounded
 * prose summary.
 *
 * The speed readout is still the important part: this is a speedrunning
 * game, and units-per-second is the number players optimise. Everything else
 * is built around not covering it.
 *
 * ## Data this HUD cannot fill in yet
 *
 * Several fields render an em dash when absent because the game layer does
 * not compute them yet -- this file's job is to be ready to draw them, not to
 * invent the numbers. Per `.agent/plans/UI.md`'s Phase 2 note: don't build
 * the recording, render placeholders until it exists.
 *
 *   - `RunDisplay.ghostDeltaSeconds` -- a live position-matched delta against
 *     the ghost, not just a time-at-tick comparison. `ghost.ts` already races
 *     a ghost; computing a meaningful live delta from it is separate work.
 *   - `ObDisplay.gain` (the verbose register's "+390 up / 658 across" numbers)
 *     -- deriving these from `height` needs the same launch-speed physics
 *     `game/overbounce.ts` already has for its OWN classification, and
 *     inventing an approximation here would be exactly the kind of
 *     un-verified physics claim CLAUDE.md's fidelity rule forbids. The verbose
 *     card explains the method in words instead.
 *   - The overbounce readout's "auto-retire after two clean landings"
 *     (`design/HANDOFF.md`): needs a LANDING event, not the aim-preview
 *     `overbounce` field this HUD already receives. `obHelp: 'auto'` reads
 *     verbose until that signal exists.
 *   - `RunDisplay.attempt` and the FINISHED state's "top this run" -- session
 *     counters nothing currently tracks.
 */

import '../ui/tokens.css';
import { createSegmentedControl, createToggle } from '../ui/shell.js';
import { renderQ3Text } from './q3-colors.js';
import { crosshairSvg } from './crosshair.js';

export interface HudData {
  /** Horizontal speed in units per second. */
  speed: number;
  /** View yaw in degrees. */
  yaw: number;
  onGround: boolean;
  origin: readonly [number, number, number];
  health: number;
  /** Armour points. Absorbs 66% of incoming damage while it lasts. */
  armor: number;
  weapon: string;
  /** Rounds left for the held weapon. -1 is unlimited. */
  ammo: number;
  /** Milliseconds until the weapon can fire again. */
  weaponTime: number;
  missiles: number;
  fps: number;
  locked: boolean;
  backend: string;
  /** Run timer, present only on maps that have timer entities. */
  run?: RunDisplay;
  /**
   * Present instead of `run` on a map with no timer entities -- the F3
   * anchor still wants an identity, just not a clock. See `Sc`.
   */
  freerun?: FreerunDisplay;
  /** Strafe quality, present only while airborne and above wishspeed. */
  strafe?: StrafeDisplay;
  /** Overbounce readout for the surface under the aim laser. */
  overbounce?: ObDisplay;
  /** `FULL` always shows the verbose register, `LETTER` always the bare one. */
  obHelp?: ObHelpMode;
  /** Airborne time this hang, seconds. Feeds the F3 debug line's "air 0.34s". */
  airTime?: number;
  /** Jumps this life. Feeds the F3 debug line. */
  jumps?: number;
  /** Physics tick time this frame, ms. Feeds the F3 debug line's "cpu". */
  cpuMs?: number;
  /**
   * A full-screen state that overrides the normal chrome. Independent of
   * `run`/`freerun` -- death and pause both happen on freerun maps too, and
   * the clock/vitals underneath stay visible, just dimmed. See `Se`, `Sh`.
   */
  phase?: HudPhase;
  /** Required when `phase` is set. */
  attemptInfo?: AttemptInfo;
}

export type HudPhase = 'dead' | 'paused';
export type ObHelpMode = 'full' | 'auto' | 'letter';

export interface AttemptInfo {
  mapName: string;
  attempt: number;
  /** Elapsed at the moment of death/pause, ms. */
  elapsed: number;
  /**
   * Whether pausing actually cost a live, recordable attempt. Death always
   * does; a pause does not when there was nothing running to void yet --
   * standing at spawn before crossing a timed course's own start gate, or
   * pausing at all on a freerun map (`runState` never reaches `'running'`
   * there). PAUSED shown in that case has nothing to apologise for.
   */
  voided: boolean;
}

export interface FreerunDisplay {
  /** Top speed reached this session, ups. */
  topSpeed: number;
  /**
   * Why there is no clock. `'map'` (the default) is a map with no timer
   * entities. `'cheats'` is R5's other untimed case -- a TIMED map, but
   * `?give=`/`?selfdamage=0` disqualify the run, so it reads the same as
   * FREERUN rather than as a third, half-timed state.
   */
  reason?: 'map' | 'cheats';
}

/**
 * The overbounce indicator, DeFRaG's most useful readout.
 *
 * Overbounce spots are invisible: nothing about a floor says that landing on
 * it from one particular height converts the fall into speed. Players learn
 * them by memorising maps. This says it out loud.
 *
 * `letter` is the method -- `G`, `J`, `p`, `P`, `r`, `R`, `B`, with `s` and `q`
 * prefixes. See `src/game/overbounce.ts`.
 *
 * There is deliberately ONE readout rather than the separate VOB and HOB rows
 * a defrag HUD shows. In this physics the two are the same set of spots, not
 * merely similar ones: they are the same code path in `PM_WalkMove`, and which
 * you get depends on whether you were holding a direction when you landed, not
 * on where you landed. `tools/diag/vob-hob.ts` checked all 4801 heights between
 * 100 and 400 units -- 260 give both, and NOT ONE gives only one of them. Two
 * rows would always read identically, which would imply a distinction that is
 * not there.
 */
export interface ObDisplay {
  letter: string;
  /** Drop from the player's origin to where they would rest, in units. */
  height: number;
}

export interface StrafeDisplay {
  /** Where the player is aiming, in degrees off their velocity. */
  currentAngle: number;
  /** The angle that gains the most. */
  optimalAngle: number;
  /** Smallest angle that gains anything at all. */
  minGainAngle: number;
  /** 0..1. */
  efficiency: number;
  /** Speed gained this jump, ups. Drives the "this jump" caption beside the instrument. */
  gainedThisJump?: number;
}

export interface RunDisplay {
  state: 'idle' | 'running' | 'finished';
  /** Elapsed milliseconds. */
  elapsed: number;
  /** Best recorded time for this map in milliseconds, or null. */
  best: number | null;
  /** Checkpoint splits so far, in milliseconds. */
  splits: readonly number[];
  /**
   * The recorded best run's own splits, same units. Drives the idle state's
   * "PB" column and the running/finished state's per-split Δ -- both are the
   * same underlying data (`records.ts`'s `RunRecord.splits`), read two ways.
   */
  bestSplits?: readonly number[];
  /** Set on a finished run that beat `best`. Distinguishes a "NEW BEST" badge from an ordinary delta pill. */
  personalBest?: boolean;
  /** Attempt number this session. */
  attempt?: number;
  /** Live delta against a raced ghost, seconds, negative is ahead. See the file header. */
  ghostDeltaSeconds?: number;
}

/** m:ss.mmm, the format defrag records are quoted in. */
export function formatTime(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = Math.floor(total % 1000);
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');
  return minutes > 0 ? `${minutes}:${ss}.${mmm}` : `${seconds}.${mmm}`;
}

/** `+1.12` / `-0.41`, the format every delta pill and split row uses. */
export function formatDelta(ms: number): string {
  const sign = ms >= 0 ? '+' : '−';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(2)}`;
}

export interface Hud {
  update(data: HudData): void;
  /** Top-right identity block, bright line. Bare name -- mode is `setMode`. */
  setMapName(name: string): void;
  /** Top-right identity block, dim line -- "VQ3" or "CPM". */
  setMode(mode: string): void;
  /** F3. Defaults to visible, matching the panel's previous always-on behaviour. */
  setDebugVisible(visible: boolean): void;
  /**
   * Rebuilds PAUSED's QUICK SETTINGS controls (`Sh`) from fresh values.
   *
   * `main.ts` calls this after the full Settings screen closes: that screen
   * writes to the very same storage this panel reads from, and without this
   * call a change made there (obhelp, say) would leave PAUSED showing the
   * value it had when the dialog first opened, not the one now in effect --
   * two doors into one setting must not show two different answers behind
   * them.
   */
  refreshQuickSettings(values: HudQuickSettingsInit): void;
  /**
   * `cp` — Quake's centerprint, from `target_print`.
   *
   * Replaces whatever is showing rather than queueing. That is Quake's own
   * behaviour and it is also what the maps need: `ob_basics` gives its hint
   * triggers `wait 5`, so standing in one re-fires every five seconds, and a
   * queue would stack a backlog of the same sentence. Re-printing the text
   * already on screen refreshes its timer and does not restart the fade, so a
   * re-fire is invisible instead of a flicker.
   */
  centerPrint(text: string): void;
  /**
   * Turn the crosshair on. Off by default.
   *
   * Only first person wants one. From a side or chase view the AIM LASER is
   * the indicator -- it shows where the shot goes in the world, which a dot in
   * the middle of the screen cannot when the camera is not behind the gun.
   * First person is the reverse: the laser starts at the eye and is useless,
   * and a crosshair is the whole answer.
   */
  setCrosshair(enabled: boolean): void;
  /**
   * Pick which of the ten Quake III crosshair styles to draw -- see
   * `crosshair.ts`. `0` hides it regardless of `setCrosshair`, the same as
   * `cg_drawCrosshair 0` in Quake; any other value is `% NUM_CROSSHAIRS`,
   * wraparound included, so this never throws on an out-of-range setting.
   *
   * Independent of `setCrosshair`: that one is camera-mode-driven (fpv vs.
   * not) and this one is player preference, and the crosshair only actually
   * shows when both agree it should.
   */
  setCrosshairStyle(style: number): void;
  dispose(): void;
}

/**
 * How long a centerprint stays up before fading.
 *
 * Quake's `cp` is drawn for `cg_centertime` (3 seconds by default) and this
 * matches it. Long enough to read a sentence while running, short enough that
 * a hint is gone before the jump it describes.
 */
const PRINT_HOLD_MS = 3000;

/** The speed trace's rolling window. Matches the "10s" caption under it. */
const TRACE_WINDOW_MS = 10000;
/**
 * Samples across the window. The mockup's own polyline has 24 points, but
 * that is a static SVG that never has to animate -- at 24 points over 10s,
 * each bucket spans ~417ms, and every rendered frame nudges the window
 * forward by only ~16ms, so a speed change sits pinned to ONE bucket for
 * roughly 25 consecutive frames before jumping to the next: exactly the
 * "steps through the points and animates like a snake" bug the repo owner
 * found by watching it live, confirmed by capturing `points` every 150ms
 * (`.agent/docs/speed-trace-resolution.md`) and seeing the rising edge
 * visibly marching left one bucket at a time instead of sliding smoothly.
 * `.ob-trace` renders at 150 CSS px wide, so 150 samples puts one bucket at
 * roughly one physical pixel -- finer than that buys nothing since
 * sub-pixel steps are already invisible, and `polyline()`'s cursor-based
 * lookup below stays O(samples + TRACE_SAMPLES) regardless, so the extra
 * resolution is free.
 */
const TRACE_SAMPLES = 150;
/** The trace SVG's own coordinate space, copied from the mockup's viewBox. */
const TRACE_VIEW_W = 260;
const TRACE_VIEW_H = 64;
/**
 * Caps how often the speed instrument (numeric readout, cap bar, and the
 * trace's own sample push) redraws, independent of the display's actual
 * refresh rate. Two reasons: `game.speed` only changes on an 8ms/125Hz
 * physics tick, so a 144Hz+ display re-reading it every frame is pure
 * waste; and pushing samples into the trace at a fixed cadence keeps its
 * spacing predictable regardless of monitor Hz or render load, rather than
 * inheriting whatever rate rAF happens to fire at (see
 * `.agent/docs/speed-trace-resolution.md`'s backgrounded-tab section for
 * how extreme that variance can get).
 */
const SPEED_UPDATE_INTERVAL_MS = 1000 / 60;

const STYLE = `
.ob-hud { position:absolute; inset:0; pointer-events:none; color:var(--ob-text);
  font-family:var(--ob-font-display); }
.ob-hud .mono { font-family:var(--ob-font-mono); }

/* ---- top-left: clock / freerun ---- */
.ob-clock, .ob-freerun { position:absolute; left:24px; top:20px; width:236px; }
.ob-clock.hidden, .ob-freerun.hidden { display:none; }
.ob-clock-row { display:flex; align-items:baseline; justify-content:space-between; }
.ob-clock-time { font:600 46px/1 var(--ob-font-display); letter-spacing:-.015em;
  font-variant-numeric:tabular-nums; }
.ob-clock-badge { padding:2px 7px; border-radius:3px; font:700 12px/1 var(--ob-font-mono); }
.ob-clock-badge.ready { border:1px solid var(--ob-control); font-weight:400; letter-spacing:.12em; }
.ob-clock-badge.hidden { display:none; }
.ob-clock-sub { margin-top:6px; display:flex; justify-content:space-between;
  font:400 11px/1 var(--ob-font-mono); letter-spacing:.04em; color:var(--ob-dim); }
.ob-clock-sub b { font-weight:400; color:var(--ob-text); }
.ob-clock-sub.hidden { display:none; }
.ob-splits { margin-top:14px; display:grid; grid-template-columns:auto 1fr auto;
  column-gap:12px; font:400 11px/1 var(--ob-font-mono); font-variant-numeric:tabular-nums; }
.ob-splits .head { letter-spacing:.14em; color:var(--ob-dim); padding-bottom:6px;
  border-bottom:1px solid var(--ob-seam); }
.ob-splits .head.right { text-align:right; }
.ob-splits .cp { color:var(--ob-dim); padding-top:6px; }
.ob-splits .val { text-align:right; padding-top:6px; }
.ob-splits.hidden { display:none; }

.ob-freerun-label { font:500 17px/1 var(--ob-font-display); letter-spacing:.14em;
  text-transform:uppercase; }
.ob-freerun-stats { margin-top:6px; display:flex; gap:14px; font:400 11px/1 var(--ob-font-mono);
  letter-spacing:.04em; color:var(--ob-dim); }
.ob-freerun-stats b { font-weight:400; color:#ffd166; }

/* ---- top-right: identity + debug ---- */
.ob-identity { position:absolute; right:24px; top:20px; text-align:right;
  font:400 11px/1.5 var(--ob-font-mono); letter-spacing:.08em; color:var(--ob-dim); }
.ob-identity .map { color:var(--ob-text); }
.ob-debug { position:absolute; right:24px; top:72px; text-align:right; opacity:.62; }
.ob-debug.hidden { display:none; }
.ob-debug-label { font:400 9px/1 var(--ob-font-mono); letter-spacing:.18em;
  color:var(--ob-dim); padding-bottom:5px; }
.ob-debug-grid { display:grid; grid-template-columns:auto auto; gap:2px 16px;
  justify-content:end; font:400 11px/1.4 var(--ob-font-mono); color:var(--ob-dim);
  font-variant-numeric:tabular-nums; }
.ob-debug-grid b { font-weight:400; color:var(--ob-text-secondary); }

/* ---- bottom-centre: speed instrument ---- */
.ob-instrument { position:absolute; left:50%; bottom:26px; transform:translateX(-50%);
  display:flex; align-items:flex-end; gap:20px; }
.ob-trace { position:relative; width:150px; height:58px; }
.ob-trace svg { display:block; }
.ob-trace-caption { position:absolute; left:0; bottom:-3px; font:400 9px/1 var(--ob-font-mono);
  letter-spacing:.12em; color:var(--ob-text-secondary); }
.ob-speedbox { text-align:center; }
.ob-speed-row { display:flex; align-items:baseline; gap:8px; justify-content:center; }
.ob-speed-num { font:600 76px/.82 var(--ob-font-display); letter-spacing:-.035em;
  font-variant-numeric:tabular-nums; }
.ob-speed-unit { font:500 12px/1 var(--ob-font-display); letter-spacing:.2em;
  color:var(--ob-dim); padding-bottom:7px; }
.ob-cap-bar { margin-top:8px; position:relative; width:280px; height:5px; border-radius:3px;
  background:#26262e; overflow:hidden; }
.ob-cap-fill { position:absolute; left:0; top:0; bottom:0;
  background:linear-gradient(90deg,#7ee081,#ffd166); }
.ob-cap-tick { position:absolute; top:-2px; bottom:-2px; width:1px; background:var(--ob-dim); }
.ob-strafe-row { margin-top:9px; display:flex; gap:10px; align-items:center; }
.ob-strafe-row.hidden { display:none; }
.ob-strafe-track { position:relative; flex:1; height:8px; border-radius:4px;
  background:#26262e; overflow:hidden; }
.ob-strafe-window { position:absolute; top:0; bottom:0; background:#2f6f3a; }
.ob-strafe-best { position:absolute; top:0; bottom:0; width:2px; background:#7ee081; }
.ob-strafe-you { position:absolute; top:-3px; bottom:-3px; width:3px; border-radius:2px;
  background:var(--ob-text); }
.ob-strafe-pct { font:600 15px/1 var(--ob-font-display); font-variant-numeric:tabular-nums; }
.ob-gain { padding-bottom:6px; }
.ob-gain.hidden { display:none; }
.ob-gain-value { font:400 10px/1 var(--ob-font-mono); letter-spacing:.1em; }
.ob-gain-label { margin-top:5px; font:400 10px/1 var(--ob-font-mono); letter-spacing:.1em;
  color:var(--ob-dim); }

/* ---- bottom-left: overbounce, both registers ---- */
.ob-ob-bare { position:absolute; left:24px; bottom:22px; display:flex; align-items:center;
  gap:10px; width:118px; padding:7px 11px; border-radius:5px;
  border:1px solid rgba(98,208,255,.35); background:rgba(16,16,20,.8); }
.ob-ob-bare.hidden { display:none; }
.ob-ob-letter { font:700 26px/1 var(--ob-font-display); }
.ob-ob-meta { font:400 11px/1.35 var(--ob-font-mono); color:var(--ob-dim); }
.ob-ob-meta b { font-weight:400; color:var(--ob-text); }

.ob-ob-full { position:absolute; left:24px; bottom:22px; width:302px; padding:11px 13px;
  border:1px solid rgba(98,208,255,.35); border-left:3px solid #62d0ff; border-radius:5px;
  background:var(--ob-panel); }
.ob-ob-full.hidden { display:none; }
.ob-ob-full-head { display:flex; align-items:center; justify-content:space-between; }
.ob-ob-full-kicker { font:400 10px/1 var(--ob-font-mono); letter-spacing:.16em; color:#62d0ff; }
.ob-ob-full-letter { font:700 26px/1 var(--ob-font-display); }
.ob-ob-full-desc { margin-top:8px; font:500 14px/1.25 var(--ob-font-display); letter-spacing:.04em; }
.ob-ob-full-desc b { font-weight:600; }
.ob-ob-full-note { margin-top:7px; font:400 11px/1.35 var(--ob-font-mono); color:var(--ob-dim); }

/* ---- bottom-right: vitals ---- */
.ob-vitals { position:absolute; right:24px; bottom:22px; width:210px; display:flex;
  flex-direction:column; gap:11px; }
.ob-vital-head { display:flex; align-items:flex-end; justify-content:space-between; margin-bottom:5px; }
.ob-vital-label { font:400 9px/1 var(--ob-font-mono); letter-spacing:.18em; }
.ob-vital-num { font:600 26px/1 var(--ob-font-display); font-variant-numeric:tabular-nums; }
.ob-vital-bar { display:flex; gap:2px; height:6px; }
.ob-vital-bar span { flex:1; border-radius:1px; background:#1e1e26; }
.ob-vitals-weapon { display:flex; align-items:center; justify-content:space-between;
  padding-top:9px; border-top:1px solid var(--ob-seam); }
.ob-vitals-weapon .name { font:500 13px/1 var(--ob-font-display); letter-spacing:.12em;
  text-transform:uppercase; color:var(--ob-dim); }
.ob-vitals-weapon .ammo-row { display:flex; align-items:baseline; gap:5px; }
.ob-vitals-weapon .ammo { font:600 20px/1 var(--ob-font-display); font-variant-numeric:tabular-nums; }
.ob-vitals-weapon .ready { font:400 9px/1 var(--ob-font-mono); }

/* ---- overlays: hint, finished, dead, paused ---- */
.ob-hint { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  width:420px; padding:22px 26px; border:1px solid var(--ob-control); border-radius:8px;
  background:rgba(16,16,20,.9); color:var(--ob-text-secondary); text-align:center; }
.ob-hint b { color:var(--ob-text); }
.ob-hint.hidden { display:none; }

.ob-finished { position:absolute; left:50%; top:44%; transform:translate(-50%,-50%);
  text-align:center; }
.ob-finished.hidden { display:none; }
.ob-finished-kicker { font:400 11px/1 var(--ob-font-mono); letter-spacing:.34em; color:#ffd166; }
.ob-finished-time { margin-top:12px; font:600 128px/.84 var(--ob-font-display);
  letter-spacing:-.03em; font-variant-numeric:tabular-nums; color:#ffd166; }
.ob-finished-hint { margin-top:14px; font:400 12px/1 var(--ob-font-mono); letter-spacing:.16em;
  color:var(--ob-dim); }

.ob-dead { position:absolute; left:50%; top:48%; transform:translate(-50%,-50%); text-align:center;
  pointer-events:auto; }
.ob-dead.hidden { display:none; }
.ob-dead-title { font:600 62px/1 var(--ob-font-display); letter-spacing:.06em;
  text-transform:uppercase; color:#ff6b6b; }
.ob-dead-note { margin-top:10px; font:400 14px/1.5 var(--ob-font-display); letter-spacing:.06em;
  color:var(--ob-dim); }
.ob-dead-actions { margin-top:22px; display:flex; gap:10px; justify-content:center; }
.ob-dead-actions button { border-radius:5px; font:600 14px/1 var(--ob-font-display);
  letter-spacing:.12em; text-transform:uppercase; cursor:pointer; padding:10px 18px; }
.ob-dead-actions .primary { border:1px solid var(--ob-accent); background:rgba(232,98,42,.16);
  color:var(--ob-text); }
.ob-dead-actions .ghost { border:1px solid var(--ob-control-hover); background:transparent;
  font-weight:400; color:var(--ob-dim); }

.ob-paused { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:560px;
  border:1px solid var(--ob-control); border-radius:8px; background:rgba(16,16,20,.9);
  overflow:hidden; pointer-events:auto; }
.ob-paused.hidden { display:none; }
.ob-paused-head { display:flex; align-items:center; justify-content:space-between;
  padding:18px 22px; border-bottom:1px solid var(--ob-seam); }
.ob-paused-title { font:600 24px/1 var(--ob-font-display); letter-spacing:.1em; text-transform:uppercase; }
.ob-paused-sub { margin-top:7px; font:400 11px/1 var(--ob-font-mono); letter-spacing:.06em; color:var(--ob-dim); }
.ob-paused-body { margin-top:8px; max-width:44ch; font:400 13px/1.4 var(--ob-font-display);
  letter-spacing:.03em; color:var(--ob-dim); }
.ob-paused-body.hidden { display:none; }
.ob-paused-badge { padding:4px 9px; border-radius:3px; background:rgba(255,209,102,.16);
  font:700 10px/1 var(--ob-font-mono); letter-spacing:.1em; color:#ffd166; white-space:nowrap; }
.ob-paused-badge.hidden { display:none; }
.ob-paused-footer { padding:16px 22px; border-top:1px solid var(--ob-seam); display:flex;
  align-items:center; justify-content:space-between; gap:14px; }
.ob-paused-footer .left { display:flex; gap:9px; }
.ob-paused-footer button { padding:11px 18px; border:1px solid var(--ob-control-hover);
  border-radius:5px; font:400 13px/1 var(--ob-font-display); letter-spacing:.1em;
  text-transform:uppercase; color:var(--ob-dim); background:transparent; cursor:pointer; }
.ob-paused-footer .resume { border:1px solid var(--ob-accent); background:rgba(232,98,42,.18);
  font:600 14px/1 var(--ob-font-display); letter-spacing:.12em; color:var(--ob-text); }
.ob-paused-footer button:disabled { color:var(--ob-unavailable); cursor:default; }

.ob-paused-quick { padding:18px 22px; display:flex; flex-direction:column; gap:13px;
  border-bottom:1px solid var(--ob-seam); }
.ob-paused-quick-label { font:400 10px/1 var(--ob-font-mono); letter-spacing:.2em; color:var(--ob-dim); }
.ob-qs-row { display:flex; align-items:center; justify-content:space-between; gap:20px; }
.ob-qs-label { font:400 15px/1 var(--ob-font-display); letter-spacing:.05em; color:var(--ob-text-secondary); }
.ob-segmented.compact button { padding:7px 13px; font-size:11px; }
.ob-qs-volume { display:flex; align-items:center; gap:11px; }
.ob-qs-volume-slider { width:150px; height:5px; appearance:none; background:#26262e; border-radius:3px;
  outline:none; }
.ob-qs-volume-slider::-webkit-slider-thumb { appearance:none; width:4px; height:13px; border-radius:2px;
  background:var(--ob-text); cursor:pointer; }
.ob-qs-volume-slider::-moz-range-thumb { width:4px; height:13px; border:0; border-radius:2px;
  background:var(--ob-text); cursor:pointer; }
.ob-qs-volume-value { width:30px; font:400 11px/1 var(--ob-font-mono); color:var(--ob-dim); text-align:right; }
.ob-qs-fullscreen { display:flex; align-items:center; gap:11px; }
.ob-qs-f11 { font:400 10px/1 var(--ob-font-mono); color:var(--ob-dim); }

/* dimmed-not-hidden: the underlying HUD stays visible but faded behind a dialog. See Sh. */
.ob-dim-behind { opacity:.4; }

/* The centerprint. Deliberately separate from .ob-hint, which is the
   click-to-play pointer-lock prompt and is toggled by the locked flag --
   sharing them would make a map's hint vanish the moment the player took
   control, which is the exact moment they need to read it.
   Above centre rather than on it: the crosshair and the speed readout are the
   two things a player is actually looking at, and a hint that lands on either
   is a hint they have to look away from. */
.ob-print { position:absolute; left:50%; top:22%; transform:translateX(-50%);
  max-width:70%; text-align:center; font-size:19px; font-weight:600;
  line-height:1.45; color:#f2f2f6; text-shadow:0 2px 10px rgba(0,0,0,0.85);
  opacity:1; transition:opacity 420ms ease-out; white-space:pre-wrap; }
.ob-print.hidden { opacity:0; }

/* The crosshair. First person only -- see Hud.setCrosshair. Its shape comes
   from Hud.setCrosshairStyle, one of the ten in crosshair.ts, injected as
   inline SVG (see elCross.innerHTML below) rather than fixed markup here.
   'color' feeds every shape's currentColor; the drop-shadow is what a bar
   crosshair always needed to stay visible against a bright texture -- the
   one pixel that matters when the shot is a rocket at your own feet. */
.ob-cross { position:absolute; left:50%; top:50%; width:22px; height:22px;
  margin:-11px 0 0 -11px; opacity:0.85; color:var(--ob-text); }
.ob-cross.hidden { display:none; }
.ob-cross svg { width:100%; height:100%; display:block;
  filter:drop-shadow(0 0 2px rgba(0,0,0,0.9)); }
`;

/** Speed colouring: the 320 ground cap is the reference point players know. */
function speedColor(speed: number): string {
  if (speed < 320) {
    return '#e8e8ec';
  }
  if (speed < 500) {
    return '#7ee081';
  }
  if (speed < 800) {
    return '#ffd166';
  }
  if (speed < 1200) {
    return '#ff9f45';
  }
  return '#ff6b6b';
}

/** Cap-bar fill: proportional to a soft ceiling above the 320 cap, matching the mockup's ~59% at 742. */
function capBarPct(speed: number): number {
  const ceiling = 1260;
  return Math.max(0, Math.min(100, (speed / ceiling) * 100));
}
const CAP_TICK_PCT = (320 / 1260) * 100;

/** `G`/`J`/`p`/`P`/`r`/`R`/`B` -> its colour, by what the method costs. See `Sg`. */
function obColor(letter: string): string {
  const method = letter.slice(-1);
  if (method === 'B') {
    return '#62d0ff';
  }
  if (method === 'G' || method === 'J') {
    return '#7ee081';
  }
  if (method === 'p' || method === 'P') {
    return '#ffd166';
  }
  return '#ff9f45';
}

const OB_METHOD_TEXT: Record<string, { gerund: string; cost: string }> = {
  G: { gerund: 'walking into it', cost: 'Free.' },
  J: { gerund: 'jumping', cost: 'Free.' },
  p: { gerund: 'plasma climbing', cost: 'Costs a little health.' },
  P: { gerund: 'plasma climbing', cost: 'Costs a little health.' },
  r: { gerund: 'rocket jumping', cost: 'Costs a lot.' },
  R: { gerund: 'rocket jumping', cost: 'Costs a lot.' },
  B: { gerund: 'landing', cost: 'Happening now -- hold a direction.' },
};

/** Time constant, in ms, for easing the trace's vertical scale down after a
 *  peak ages out of the window. Frame-rate independent, same shape as
 *  `steerShadowDirection` in `shadow-map.ts`. */
const TRACE_TOP_DECAY_MS = 600;
/** Longest step the decay will honour in one go -- a hitch (tab switch,
 *  stall) shouldn't be worth that much easing, same reasoning as
 *  `MAX_STEER_STEP_MS`. */
const TRACE_TOP_MAX_STEP_MS = 100;

/** A 10-second ring buffer of speed samples, downsampled for the trace SVG.
 *  Exported for `test/render/speed-trace.test.ts` -- pure state, no DOM. */
export function createSpeedTrace(): {
  push(nowMs: number, speed: number): void;
  polyline(cap: number): string | null;
  capY(cap: number): number;
} {
  const samples: { t: number; speed: number }[] = [];

  // The vertical scale eases toward its target instead of snapping to it
  // every frame. Above the 320 cap the current speed usually IS the window
  // max, so without damping `top` -- and with it, every point on the trace,
  // including settled history -- would visibly shimmy each frame the newest
  // sample nudges the max. Rises are instant (a damped rise could push the
  // newest point's y negative, clipping it above the viewBox); only the
  // decay once a peak ages out of the window is eased.
  let dampedTop: number | null = null;
  let dampedAtT: number | null = null;

  function currentTop(cap: number): number {
    const raw = Math.max(cap, ...samples.map((s) => s.speed), 1) * 1.15;
    const latest = samples.length ? samples[samples.length - 1].t : null;

    if (latest === null || latest === dampedAtT) {
      // Nothing to show yet, or already settled for this frame.
      dampedTop ??= raw;
      return dampedTop;
    }
    if (dampedTop === null || raw >= dampedTop) {
      dampedTop = raw;
    } else {
      const step = Math.min(latest - (dampedAtT ?? latest), TRACE_TOP_MAX_STEP_MS);
      const alpha = 1 - Math.exp(-step / TRACE_TOP_DECAY_MS);
      dampedTop += (raw - dampedTop) * alpha;
    }
    dampedAtT = latest;
    return dampedTop;
  }

  return {
    push(nowMs: number, speed: number): void {
      samples.push({ t: nowMs, speed });
      const cutoff = nowMs - TRACE_WINDOW_MS;
      while (samples.length > 1 && samples[0].t < cutoff) {
        samples.shift();
      }
    },

    polyline(cap: number): string | null {
      if (samples.length < 2) {
        return null;
      }
      const latest = samples[samples.length - 1].t;
      const earliest = latest - TRACE_WINDOW_MS;
      // Headroom above the peak so the trace does not touch the top edge,
      // matching the mockup's polyline (peak at y=11.2 of 64, not y=0).
      const top = currentTop(cap);

      const toY = (speed: number): number => TRACE_VIEW_H * (1 - speed / top);
      const points: string[] = [];
      // Nearest sample at or before `t`; the ring buffer is coarse enough
      // that interpolating between samples would imply false precision.
      // `cursor` only walks forward -- both `t` (as `i` grows) and
      // `samples` are already time-ordered, so re-scanning from
      // `samples[0]` every iteration (the mockup-era version of this loop)
      // is wasted work at TRACE_SAMPLES's current resolution; one shared
      // cursor keeps the whole pass O(samples.length + TRACE_SAMPLES).
      let cursor = 0;
      for (let i = 0; i < TRACE_SAMPLES; i++) {
        const t = earliest + (TRACE_WINDOW_MS * i) / (TRACE_SAMPLES - 1);
        while (cursor < samples.length - 1 && samples[cursor + 1].t <= t) {
          cursor++;
        }
        const s = samples[cursor];
        const x = (TRACE_VIEW_W * i) / (TRACE_SAMPLES - 1);
        points.push(`${x.toFixed(1)},${toY(s.speed).toFixed(1)}`);
      }
      return points.join(' ');
    },

    capY(cap: number): number {
      return TRACE_VIEW_H * (1 - cap / currentTop(cap));
    },
  };
}

/** PAUSED's Camera quick-setting -- `Sh`'s three segments. FPV stays reachable
 *  only through "All settings", matching the mockup exactly. */
export type QuickCameraOverride = 'auto' | 'chase' | 'side';

/**
 * Starting values for PAUSED's QUICK SETTINGS panel (`Sh`). Read once at
 * `createHud` time -- `main.ts` already knows all of these by then (they are
 * resolved from URL params before the HUD is built). Fullscreen is not here:
 * it is browser state this file can read and toggle itself, not something
 * `main.ts` tracks. Debug panel's live value can also change from outside
 * this panel (F3) -- `Hud.setDebugVisible` keeps the toggle in sync with that.
 */
export interface HudQuickSettingsInit {
  camera: QuickCameraOverride;
  obHelp: ObHelpMode;
  ghost: boolean;
  debugPanel: boolean;
  /** 0-100. */
  volume: number;
}

/**
 * DEAD/PAUSED dialog actions (R5), plus PAUSED's QUICK SETTINGS row handlers
 * (`Sh`). `main.ts` owns what each one actually does -- reacquiring pointer
 * lock, resetting to spawn, resolving `CourseHandle.exited`, writing
 * `PreferenceStore` or a URL param -- this file only needs to know they exist.
 */
export interface HudCallbacks {
  /** DEAD's only action, and PAUSED's "R Restart": start this life over. */
  onRestart(): void;
  /** PAUSED's "Esc Resume": keep playing from where the pause caught it. */
  onResume(): void;
  /** DEAD's "Esc Courses" and PAUSED's "Courses": back to course select. */
  onExit(): void;
  /** PAUSED's "All settings" -- there is no DEAD equivalent in `Se`. */
  onSettings(): void;
  /**
   * Quick-setting Camera. This is the per-map override, not a live camera
   * swap -- `cameraMode` feeds axis lock, occlusion and the crosshair for the
   * whole run, the same reason Settings' own Movement panel defers this to
   * next start rather than applying it mid-run.
   */
  onCameraChange(mode: QuickCameraOverride): void;
  /** Quick-setting Overbounce help. Live -- the HUD reads this every frame. */
  onObHelpChange(mode: ObHelpMode): void;
  /** Quick-setting Ghost. Live: hides/shows an already-loaded ghost immediately,
   *  and decides whether the next start-gate crossing loads one at all. */
  onGhostToggle(enabled: boolean): void;
  /** Quick-setting Debug panel. Same live flag F3 flips. */
  onDebugToggle(enabled: boolean): void;
  /** Volume slider, fired continuously while dragging -- live audio feedback,
   *  no URL write (see `onVolumeCommit`). */
  onVolumeInput(percent: number): void;
  /** Volume slider release -- writes the `?volume=` param. */
  onVolumeCommit(percent: number): void;
}

export function createHud(
  parent: HTMLElement,
  callbacks: HudCallbacks,
  quickSettings: HudQuickSettingsInit,
): Hud {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'ob-hud';
  root.innerHTML = `
    <div class="ob-clock hidden" data-clock>
      <div>
        <div class="ob-clock-row">
          <div class="ob-clock-time mono" data-clock-time>0.000</div>
          <div class="ob-clock-badge mono" data-clock-badge></div>
        </div>
        <div class="ob-clock-sub" data-clock-sub></div>
      </div>
      <div class="ob-splits" data-splits></div>
    </div>

    <div class="ob-freerun hidden" data-freerun>
      <div class="ob-freerun-label" data-freerun-label>Freerun</div>
      <div class="ob-freerun-stats"><span>top <b data-freerun-top>0 ups</b></span></div>
    </div>

    <div class="ob-identity" data-identity>
      <div class="map" data-map></div>
      <div data-mode></div>
    </div>
    <div class="ob-debug" data-debug>
      <div class="ob-debug-label">DEBUG &middot; F3 TO HIDE</div>
      <div class="ob-debug-grid" data-debug-grid></div>
    </div>

    <div class="ob-instrument">
      <div class="ob-trace">
        <svg viewBox="0 0 ${TRACE_VIEW_W} ${TRACE_VIEW_H}" width="150" height="58"
             preserveAspectRatio="none" data-trace-svg>
          <line data-trace-cap x1="0" x2="${TRACE_VIEW_W}" stroke="#3a3a46" stroke-width="1.5"
                stroke-dasharray="6 7"></line>
          <polyline data-trace-line fill="none" stroke="#ffd166" stroke-width="2.5"
                    stroke-linejoin="round"></polyline>
        </svg>
        <div class="ob-trace-caption mono">10s &middot; 320 cap</div>
      </div>
      <div class="ob-speedbox">
        <div class="ob-speed-row">
          <div class="ob-speed-num" data-speed>0</div>
          <div class="ob-speed-unit">UPS</div>
        </div>
        <div class="ob-cap-bar">
          <div class="ob-cap-fill" data-cap-fill></div>
          <div class="ob-cap-tick" style="left:${CAP_TICK_PCT}%"></div>
        </div>
        <div class="ob-strafe-row hidden" data-strafe>
          <div class="ob-strafe-track">
            <div class="ob-strafe-window" data-strafe-window></div>
            <div class="ob-strafe-best" data-strafe-best></div>
            <div class="ob-strafe-you" data-strafe-you></div>
          </div>
          <div class="ob-strafe-pct mono" data-strafe-pct>0%</div>
        </div>
      </div>
      <div class="ob-gain hidden" data-gain>
        <div class="ob-gain-value mono" data-gain-value></div>
        <div class="ob-gain-label">this jump</div>
      </div>
    </div>

    <div class="ob-ob-bare hidden" data-ob-bare>
      <div class="ob-ob-letter" data-ob-bare-letter>O</div>
      <div class="ob-ob-meta mono" data-ob-bare-meta></div>
    </div>
    <div class="ob-ob-full hidden" data-ob-full>
      <div class="ob-ob-full-head">
        <div class="ob-ob-full-kicker mono" data-ob-full-kicker></div>
        <div class="ob-ob-full-letter" data-ob-full-letter></div>
      </div>
      <div class="ob-ob-full-desc" data-ob-full-desc></div>
      <div class="ob-ob-full-note mono">Every spot is both VOB and HOB.</div>
    </div>

    <div class="ob-vitals">
      <div>
        <div class="ob-vital-head">
          <span class="ob-vital-label mono" data-health-label>HEALTH</span>
          <span class="ob-vital-num" data-health-num>100</span>
        </div>
        <div class="ob-vital-bar" data-health-bar></div>
      </div>
      <div>
        <div class="ob-vital-head">
          <span class="ob-vital-label mono" data-armor-label>ARMOR</span>
          <span class="ob-vital-num" data-armor-num>0</span>
        </div>
        <div class="ob-vital-bar" data-armor-bar></div>
      </div>
      <div class="ob-vitals-weapon">
        <span class="name" data-weapon></span>
        <span class="ammo-row">
          <span class="ammo" data-ammo></span>
          <span class="ready mono" data-ready></span>
        </span>
      </div>
    </div>

    <div class="ob-finished hidden" data-finished>
      <div class="ob-finished-kicker mono" data-finished-kicker></div>
      <div class="ob-finished-time mono" data-finished-time></div>
      <div class="ob-finished-hint">R RESTART &middot; ENTER RESULTS</div>
    </div>

    <div class="ob-dead hidden" data-dead>
      <div class="ob-dead-title">You died</div>
      <div class="ob-dead-note">the clock stops and the attempt is discarded &mdash; nothing partial is recorded</div>
      <div class="ob-dead-actions">
        <button type="button" class="primary ob-cta-pulse" data-dead-restart>R &middot; Restart</button>
        <button type="button" class="ghost" data-dead-exit>Esc &middot; Courses</button>
      </div>
    </div>

    <div class="ob-paused hidden" data-paused>
      <div class="ob-paused-head">
        <div>
          <div class="ob-paused-title">Paused</div>
          <div class="ob-paused-sub mono" data-paused-sub></div>
          <div class="ob-paused-body" data-paused-body>The clock stops here &mdash; resuming continues an attempt that can no longer be recorded.</div>
        </div>
        <div class="ob-paused-badge mono" data-paused-badge>ATTEMPT DISCARDED</div>
      </div>
      <div class="ob-paused-quick">
        <div class="ob-paused-quick-label mono">QUICK SETTINGS</div>
        <div class="ob-qs-row"><span class="ob-qs-label">Camera</span><div data-qs-camera></div></div>
        <div class="ob-qs-row"><span class="ob-qs-label">Overbounce help</span><div data-qs-obhelp></div></div>
        <div class="ob-qs-row"><span class="ob-qs-label">Ghost</span><div data-qs-ghost></div></div>
        <div class="ob-qs-row"><span class="ob-qs-label">Debug panel</span><div data-qs-debug></div></div>
        <div class="ob-qs-row">
          <span class="ob-qs-label">Volume</span>
          <div class="ob-qs-volume">
            <input type="range" class="ob-qs-volume-slider" min="0" max="100" step="1" data-qs-volume-slider />
            <span class="mono ob-qs-volume-value" data-qs-volume-value></span>
          </div>
        </div>
        <div class="ob-qs-row">
          <span class="ob-qs-label">Fullscreen</span>
          <div class="ob-qs-fullscreen">
            <span class="mono ob-qs-f11">F11</span>
            <div data-qs-fullscreen></div>
          </div>
        </div>
      </div>
      <div class="ob-paused-footer">
        <div class="left">
          <button type="button" data-paused-restart>R &middot; Restart</button>
          <button type="button" data-paused-exit>Courses</button>
          <button type="button" data-paused-settings>All settings</button>
        </div>
        <button type="button" class="resume ob-cta-pulse" data-paused-resume>Esc &middot; Resume</button>
      </div>
    </div>

    <div class="ob-hint" data-hint>
      <b>Click to play</b><br />WASD move &middot; mouse turn &middot; space jump<br />
      click to fire rockets &middot; ctrl crouch
    </div>
    <div class="ob-cross hidden" data-cross></div>
    <div class="ob-print hidden" data-print></div>`;
  parent.appendChild(root);

  const q = <T extends Element>(sel: string): T => root.querySelector(sel) as T;

  const elClock = q<HTMLElement>('[data-clock]');
  const elClockTime = q<HTMLElement>('[data-clock-time]');
  const elClockBadge = q<HTMLElement>('[data-clock-badge]');
  const elClockSub = q<HTMLElement>('[data-clock-sub]');
  const elSplits = q<HTMLElement>('[data-splits]');
  const elFreerun = q<HTMLElement>('[data-freerun]');
  const elFreerunLabel = q<HTMLElement>('[data-freerun-label]');
  const elFreerunTop = q<HTMLElement>('[data-freerun-top]');

  const elIdentity = q<HTMLElement>('[data-identity]');
  const elMap = q<HTMLElement>('[data-map]');
  const elMode = q<HTMLElement>('[data-mode]');
  const elDebug = q<HTMLElement>('[data-debug]');
  const elDebugGrid = q<HTMLElement>('[data-debug-grid]');

  const elTraceLine = q<SVGPolylineElement>('[data-trace-line]');
  const elTraceCap = q<SVGLineElement>('[data-trace-cap]');
  const elSpeed = q<HTMLElement>('[data-speed]');
  const elCapFill = q<HTMLElement>('[data-cap-fill]');
  const elStrafe = q<HTMLElement>('[data-strafe]');
  const elStrafeWindow = q<HTMLElement>('[data-strafe-window]');
  const elStrafeBest = q<HTMLElement>('[data-strafe-best]');
  const elStrafeYou = q<HTMLElement>('[data-strafe-you]');
  const elStrafePct = q<HTMLElement>('[data-strafe-pct]');
  const elGain = q<HTMLElement>('[data-gain]');
  const elGainValue = q<HTMLElement>('[data-gain-value]');

  const elObBare = q<HTMLElement>('[data-ob-bare]');
  const elObBareLetter = q<HTMLElement>('[data-ob-bare-letter]');
  const elObBareMeta = q<HTMLElement>('[data-ob-bare-meta]');
  const elObFull = q<HTMLElement>('[data-ob-full]');
  const elObFullKicker = q<HTMLElement>('[data-ob-full-kicker]');
  const elObFullLetter = q<HTMLElement>('[data-ob-full-letter]');
  const elObFullDesc = q<HTMLElement>('[data-ob-full-desc]');

  const elHealthLabel = q<HTMLElement>('[data-health-label]');
  const elHealthNum = q<HTMLElement>('[data-health-num]');
  const elHealthBar = q<HTMLElement>('[data-health-bar]');
  const elArmorLabel = q<HTMLElement>('[data-armor-label]');
  const elArmorNum = q<HTMLElement>('[data-armor-num]');
  const elArmorBar = q<HTMLElement>('[data-armor-bar]');
  const elWeapon = q<HTMLElement>('[data-weapon]');
  const elAmmo = q<HTMLElement>('[data-ammo]');
  const elReady = q<HTMLElement>('[data-ready]');

  const elHint = q<HTMLElement>('[data-hint]');
  const elPrint = q<HTMLElement>('[data-print]');
  const elCross = q<HTMLElement>('[data-cross]');
  const elFinished = q<HTMLElement>('[data-finished]');
  const elFinishedKicker = q<HTMLElement>('[data-finished-kicker]');
  const elFinishedTime = q<HTMLElement>('[data-finished-time]');
  const elDead = q<HTMLElement>('[data-dead]');
  const elPaused = q<HTMLElement>('[data-paused]');
  const elPausedSub = q<HTMLElement>('[data-paused-sub]');
  const elPausedBody = q<HTMLElement>('[data-paused-body]');
  const elPausedBadge = q<HTMLElement>('[data-paused-badge]');

  q<HTMLButtonElement>('[data-dead-restart]').addEventListener('click', () => callbacks.onRestart());
  q<HTMLButtonElement>('[data-dead-exit]').addEventListener('click', () => callbacks.onExit());
  q<HTMLButtonElement>('[data-paused-restart]').addEventListener('click', () => callbacks.onRestart());
  q<HTMLButtonElement>('[data-paused-resume]').addEventListener('click', () => callbacks.onResume());
  q<HTMLButtonElement>('[data-paused-exit]').addEventListener('click', () => callbacks.onExit());
  q<HTMLButtonElement>('[data-paused-settings]').addEventListener('click', () => callbacks.onSettings());

  // ---- PAUSED's QUICK SETTINGS (Sh) ----
  const elQsCamera = q<HTMLElement>('[data-qs-camera]');
  const elQsObHelp = q<HTMLElement>('[data-qs-obhelp]');
  const elQsGhost = q<HTMLElement>('[data-qs-ghost]');
  const elQsDebug = q<HTMLElement>('[data-qs-debug]');
  const elVolumeSlider = q<HTMLInputElement>('[data-qs-volume-slider]');
  const elVolumeValue = q<HTMLElement>('[data-qs-volume-value]');

  // Reassigned by `mountQuickSettings`, so `setDebugVisible` below (F3, and
  // main.ts's live Settings-screen sync) always flips the CURRENT button.
  let debugToggle: HTMLButtonElement;

  /**
   * Builds (or rebuilds) the four stateful controls from `values`. Called
   * once at startup and again from `Hud.refreshQuickSettings` -- the door
   * `main.ts` uses after the full Settings screen closes, so a change made
   * there (obhelp, say) does not leave this panel showing the value it had
   * when PAUSED first opened. Camera/OB help/Ghost/Debug are torn down and
   * rebuilt rather than have their active state poked from outside:
   * `createSegmentedControl` tracks "current" in its own closure, and an
   * external class-only update would desync it from what a click there
   * actually believes is selected. Volume and Fullscreen are not rebuilt --
   * Volume's `<input>` just gets a new `.value`, and Fullscreen is browser
   * state nothing else here ever changes, always self-syncing via its own
   * `fullscreenchange` listener below.
   */
  const mountQuickSettings = (values: HudQuickSettingsInit): void => {
    elQsCamera.innerHTML = '';
    const cameraSeg = createSegmentedControl(
      [
        { id: 'auto', label: 'AUTO' },
        { id: 'chase', label: 'CHASE' },
        { id: 'side', label: 'SIDE' },
      ],
      values.camera,
      (id) => callbacks.onCameraChange(id as QuickCameraOverride),
    );
    cameraSeg.classList.add('compact');
    elQsCamera.appendChild(cameraSeg);

    elQsObHelp.innerHTML = '';
    const obHelpSeg = createSegmentedControl(
      [
        { id: 'full', label: 'FULL' },
        { id: 'auto', label: 'AUTO' },
        { id: 'letter', label: 'LETTER' },
      ],
      values.obHelp,
      (id) => callbacks.onObHelpChange(id as ObHelpMode),
    );
    obHelpSeg.classList.add('compact');
    elQsObHelp.appendChild(obHelpSeg);

    elQsGhost.innerHTML = '';
    let ghostOn = values.ghost;
    const ghostToggle = createToggle(ghostOn, () => {
      ghostOn = !ghostOn;
      ghostToggle.className = 'ob-toggle ' + (ghostOn ? 'on' : 'off');
      callbacks.onGhostToggle(ghostOn);
    });
    elQsGhost.appendChild(ghostToggle);

    elQsDebug.innerHTML = '';
    // Kept in sync with F3 too -- see `setDebugVisible` below, the single
    // place both that key and this toggle end up.
    debugToggle = createToggle(values.debugPanel, () => {
      callbacks.onDebugToggle(!debugToggle.classList.contains('on'));
    });
    elQsDebug.appendChild(debugToggle);

    elVolumeSlider.value = String(values.volume);
    elVolumeValue.textContent = String(values.volume);
  };
  mountQuickSettings(quickSettings);

  elVolumeSlider.addEventListener('input', () => {
    const v = elVolumeSlider.valueAsNumber;
    elVolumeValue.textContent = String(v);
    callbacks.onVolumeInput(v);
  });
  elVolumeSlider.addEventListener('change', () => callbacks.onVolumeCommit(elVolumeSlider.valueAsNumber));

  // Fullscreen is browser state, not a `main.ts` setting -- no callback,
  // just the same request/exitFullscreen pair `title.ts`'s toggle uses. The
  // `fullscreenchange` listener keeps the knob honest against F11 and Esc,
  // which this button does not otherwise hear about.
  const fullscreenToggle = createToggle(!!document.fullscreenElement, () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', () => {
    fullscreenToggle.className = 'ob-toggle ' + (document.fullscreenElement ? 'on' : 'off');
  });
  q<HTMLElement>('[data-qs-fullscreen]').appendChild(fullscreenToggle);

  for (let i = 0; i < 10; i++) {
    elHealthBar.appendChild(document.createElement('span'));
    elArmorBar.appendChild(document.createElement('span'));
  }
  const healthSegs = Array.from(elHealthBar.children) as HTMLElement[];
  const armorSegs = Array.from(elArmorBar.children) as HTMLElement[];

  /** Everything that fades to 40% behind the DEAD/PAUSED dialog. See `Sh`/`Se`. */
  const dimmable = [
    elClock,
    elFreerun,
    elIdentity,
    elDebug,
    q<HTMLElement>('.ob-instrument'),
    elObBare,
    elObFull,
    q<HTMLElement>('.ob-vitals'),
  ];

  const trace = createSpeedTrace();
  /** Next `performance.now()` timestamp the speed instrument is allowed to
   *  redraw at -- see `SPEED_UPDATE_INTERVAL_MS`. Starts at 0 so the very
   *  first `update()` call always draws immediately. */
  let nextSpeedUpdate = 0;

  /** Whether this camera mode wants a crosshair at all. See `setCrosshair`. */
  let crosshair = false;
  /** Which style, `0` = none. See `setCrosshairStyle`. */
  let crosshairStyle = 0;
  let debugVisible = true;

  /** What is on screen now, so a re-fire can be told from a new message. */
  let printed: string | null = null;
  let printTimer: ReturnType<typeof setTimeout> | null = null;

  const renderVitalBar = (
    segs: readonly HTMLElement[],
    fillColor: string,
    value: number,
    max: number,
  ): void => {
    const filled = Math.round((Math.max(0, value) / max) * segs.length);
    segs.forEach((seg, i) => {
      seg.style.background = i < filled ? fillColor : '';
    });
  };

  return {
    setCrosshair(enabled: boolean): void {
      crosshair = enabled;
    },

    setCrosshairStyle(style: number): void {
      crosshairStyle = style;
      elCross.innerHTML = style > 0 ? crosshairSvg(style) : '';
    },

    setDebugVisible(visible: boolean): void {
      debugVisible = visible;
      debugToggle.className = 'ob-toggle ' + (visible ? 'on' : 'off');
    },

    refreshQuickSettings(values: HudQuickSettingsInit): void {
      mountQuickSettings(values);
    },

    centerPrint(text: string): void {
      const message = text.trim();
      if (!message) {
        return;
      }

      // `renderQ3Text`, NEVER `innerHTML`: this string comes out of a `.bsp`
      // the player supplied, and the maps use emoji AND `^N` colour codes in
      // it on purpose. Building one text node/span per colour run keeps the
      // "cannot execute anything" guarantee `textContent` always had while
      // still honouring `^1red^7 text`.
      if (message !== printed) {
        renderQ3Text(elPrint, message);
        printed = message;
      }
      elPrint.classList.remove('hidden');

      // Restarting the timer on a re-fire is what makes `wait 5` triggers feel
      // like one continuous hint rather than a blink every five seconds.
      if (printTimer !== null) {
        clearTimeout(printTimer);
      }
      printTimer = setTimeout(() => {
        elPrint.classList.add('hidden');
        printed = null;
        printTimer = null;
      }, PRINT_HOLD_MS);
    },

    update(d: HudData): void {
      const now = performance.now();

      // ---- speed instrument, throttled to a fixed 60fps -- see
      // SPEED_UPDATE_INTERVAL_MS. Skipped entirely on a frame that arrives
      // early rather than updated with a stale `now`, so the trace's own
      // sample timestamps stay real wall-clock time throughout.
      if (now >= nextSpeedUpdate) {
        nextSpeedUpdate = now + SPEED_UPDATE_INTERVAL_MS;
        trace.push(now, d.speed);

        const ups = Math.round(d.speed);
        elSpeed.textContent = String(ups);
        elSpeed.style.color = speedColor(d.speed);
        elCapFill.style.width = `${capBarPct(d.speed)}%`;

        const line = trace.polyline(320);
        if (line) {
          elTraceLine.setAttribute('points', line);
          elTraceLine.style.display = '';
        } else {
          elTraceLine.style.display = 'none';
        }
        const capY = trace.capY(320);
        elTraceCap.setAttribute('y1', capY.toFixed(1));
        elTraceCap.setAttribute('y2', capY.toFixed(1));
      }

      elStrafe.classList.toggle('hidden', !d.strafe);
      elGain.classList.toggle('hidden', !d.strafe?.gainedThisJump);
      if (d.strafe) {
        const pos = (deg: number): number => Math.max(0, Math.min(100, (deg / 90) * 100));
        elStrafeWindow.style.left = `${pos(d.strafe.minGainAngle)}%`;
        elStrafeWindow.style.width = `${100 - pos(d.strafe.minGainAngle)}%`;
        elStrafeBest.style.left = `${pos(d.strafe.optimalAngle)}%`;
        elStrafeYou.style.left = `${pos(d.strafe.currentAngle)}%`;

        const pct = Math.round(d.strafe.efficiency * 100);
        elStrafePct.textContent = `${pct}%`;
        elStrafePct.style.color =
          pct > 90 ? '#7ee081' : pct > 60 ? '#ffd166' : pct > 20 ? '#ff9f45' : '#ff6b6b';

        if (d.strafe.gainedThisJump) {
          const g = Math.round(d.strafe.gainedThisJump);
          elGainValue.textContent = `${g >= 0 ? '+' : '−'}${Math.abs(g)} ups`;
          elGainValue.style.color = g >= 0 ? '#7ee081' : '#ff6b6b';
        }
      }

      // ---- identity + debug (F3) ----
      elDebug.classList.toggle('hidden', !debugVisible);
      elDebugGrid.innerHTML = '';
      const debugRow = (label: string, value: string, color?: string): void => {
        const span = document.createElement('span');
        span.innerHTML = `${label} <b${color ? ` style="color:${color}"` : ''}>${value}</b>`;
        elDebugGrid.appendChild(span);
      };
      debugRow(
        'pos',
        `${d.origin[0].toFixed(0)} ${d.origin[1].toFixed(0)} ${d.origin[2].toFixed(0)}`,
      );
      debugRow('yaw', `${(((d.yaw % 360) + 360) % 360).toFixed(0)}°`);
      debugRow(
        'ground',
        d.onGround ? 'yes' : d.airTime !== undefined ? `air ${d.airTime.toFixed(2)}s` : 'air',
        d.onGround ? undefined : '#ffd166',
      );
      debugRow('jumps', d.jumps !== undefined ? String(d.jumps) : '—');
      debugRow('cpu', d.cpuMs !== undefined ? `${d.cpuMs.toFixed(2)}ms` : '—');
      debugRow('', `${Math.round(d.fps)} fps`);

      // ---- overbounce readout, two registers ----
      const help = d.obHelp ?? 'letter';
      const showFull = !!d.overbounce && (help === 'full' || help === 'auto');
      elObBare.classList.toggle('hidden', !d.overbounce || showFull);
      elObFull.classList.toggle('hidden', !showFull);
      if (d.overbounce) {
        const color = obColor(d.overbounce.letter);
        const method = OB_METHOD_TEXT[d.overbounce.letter.slice(-1)];
        const height = Math.round(d.overbounce.height);

        elObBareLetter.textContent = d.overbounce.letter;
        elObBareLetter.style.color = color;
        elObBareMeta.innerHTML = `${height}u<br><b>&mdash;</b>`;

        if (showFull) {
          elObFullKicker.textContent = `OVERBOUNCE · ${height}u BELOW`;
          elObFullLetter.textContent = d.overbounce.letter;
          elObFullLetter.style.color = color;
          if (method) {
            elObFullDesc.innerHTML =
              `${d.overbounce.letter} &mdash; reachable by <b style="color:${color}">${method.gerund}</b>. ${method.cost}`;
          }
        }
      }

      // ---- vitals ----
      const healthColor = d.health > 50 ? '#e8e8ec' : d.health > 25 ? '#ffd166' : '#ff6b6b';
      elHealthNum.textContent = String(Math.max(0, Math.round(d.health)));
      elHealthNum.style.color = healthColor;
      elHealthLabel.style.color = d.health > 0 ? 'var(--ob-dim)' : '#ff6b6b';
      renderVitalBar(healthSegs, '#7ee081', d.health, 100);

      const hasArmor = d.armor > 0;
      elArmorNum.textContent = String(Math.max(0, Math.round(d.armor)));
      // Armour dimmed at zero rather than hidden: a player has to be able to
      // see that they have none, not just fail to see that they have some.
      elArmorNum.style.color = hasArmor ? '#7ec8e0' : 'var(--ob-unavailable)';
      elArmorLabel.style.color = hasArmor ? 'var(--ob-dim)' : 'var(--ob-unavailable)';
      renderVitalBar(armorSegs, '#7ec8e0', d.armor, 100);

      elWeapon.textContent = d.weapon;
      const unarmed = d.weapon === 'none';
      // -1 is Quake's unlimited marker, and printing it as a number reads as
      // a bug. The gauntlet and the grapple are the only weapons that carry it.
      elAmmo.textContent = unarmed ? '' : d.ammo < 0 ? '∞' : String(d.ammo);
      elAmmo.style.color =
        d.ammo < 0 ? 'var(--ob-dim)' : d.ammo === 0 ? '#ff6b6b' : d.ammo <= 3 ? '#ffd166' : 'var(--ob-text)';
      elReady.style.display = unarmed ? 'none' : '';
      elReady.textContent = d.weaponTime > 0 ? `${d.weaponTime}ms` : 'ready';
      elReady.style.color = d.weaponTime > 0 ? 'var(--ob-dim)' : '#7ee081';

      // ---- state: clock / freerun / hint / finished / dead / paused ----
      elFreerun.classList.toggle('hidden', !d.freerun);
      elClock.classList.toggle('hidden', !d.run);
      if (d.freerun) {
        elFreerunLabel.textContent = d.freerun.reason === 'cheats' ? 'No clock — cheats' : 'Freerun';
        elFreerunTop.textContent = `${Math.round(d.freerun.topSpeed)} ups`;
      }

      // DEAD collapses the clock column to just the frozen elapsed time,
      // unavailable-coloured -- no badge, no pb/ghost row, no splits. See `Se`.
      elClockBadge.classList.toggle('hidden', d.phase === 'dead');
      elClockSub.classList.toggle('hidden', d.phase === 'dead');
      elSplits.classList.toggle('hidden', d.phase === 'dead');

      if (d.phase === 'dead' && d.attemptInfo) {
        // NOT `d.run.elapsed`: death already reset the course by the time this
        // renders (`course.reset()` zeroes `startTime`, so `elapsed()` reads
        // back time-since-map-load, not time-since-this-attempt). `attemptInfo`
        // is the snapshot `main.ts` took before that reset ran -- see there.
        elClockTime.textContent = formatTime(d.attemptInfo.elapsed);
        elClockTime.style.color = 'var(--ob-unavailable)';
      } else if (d.run) {
        const state = d.run.state;
        const color = state === 'running' ? '#7ee081' : state === 'finished' ? '#ffd166' : '#8a8a96';
        elClockTime.textContent = formatTime(d.run.elapsed);
        elClockTime.style.color = color;

        elClockBadge.classList.remove('ready');
        if (state === 'idle') {
          elClockBadge.classList.add('ready');
          elClockBadge.textContent = 'READY';
          elClockBadge.style.background = '';
          elClockBadge.style.color = '#8a8a96';
        } else if (d.run.best !== null) {
          const delta = d.run.elapsed - d.run.best;
          if (state === 'finished' && d.run.personalBest) {
            elClockBadge.textContent = 'NEW BEST';
            elClockBadge.style.background = 'rgba(255,209,102,.18)';
            elClockBadge.style.color = '#ffd166';
          } else {
            elClockBadge.textContent = formatDelta(delta);
            elClockBadge.style.background =
              state === 'finished' ? 'rgba(255,209,102,.18)' : 'rgba(126,224,129,.16)';
            elClockBadge.style.color = color;
          }
        } else {
          elClockBadge.textContent = '';
        }

        elClockSub.innerHTML = '';
        if (state === 'idle') {
          elClockSub.innerHTML =
            (d.run.best !== null ? `<span>pb <b>${formatTime(d.run.best)}</b></span>` : '<span></span>') +
            (d.run.attempt !== undefined ? `<span>attempt <b>${d.run.attempt}</b></span>` : '');
        } else if (state === 'finished') {
          elClockSub.innerHTML = d.run.best !== null
            ? `<span>old pb <b>${formatTime(d.run.best)}</b></span>`
            : '<span></span>';
        } else {
          elClockSub.innerHTML =
            (d.run.best !== null ? `<span>pb <b>${formatTime(d.run.best)}</b></span>` : '<span></span>') +
            (d.run.ghostDeltaSeconds !== undefined
              ? `<span>ghost <b style="color:#62d0ff">${d.run.ghostDeltaSeconds >= 0 ? '+' : ''}${d.run.ghostDeltaSeconds.toFixed(1)}s</b></span>`
              : '');
        }

        // Splits: idle shows the PB column (what to beat); running/finished
        // show Δ against it. Same source data, `RunDisplay.bestSplits`.
        elSplits.classList.toggle('hidden', state === 'idle' && !d.run.bestSplits);
        elSplits.innerHTML = '';
        const headRight = state === 'idle' ? 'PB' : 'Δ';
        elSplits.innerHTML = `
          <span class="head">SPLITS</span><span class="head"></span><span class="head right">${headRight}</span>`;
        const rowCount = Math.max(d.run.splits.length, d.run.bestSplits?.length ?? 0, 3);
        for (let i = 0; i < rowCount; i++) {
          const have = i < d.run.splits.length;
          const split = d.run.splits[i];
          const best = d.run.bestSplits?.[i];
          const label = i === rowCount - 1 && state !== 'idle' && have ? 'end' : `cp${i + 1}`;
          let right = '—';
          let rightColor = 'var(--ob-unavailable)';
          if (state === 'idle') {
            right = best !== undefined ? formatTime(best) : '—';
            rightColor = best !== undefined ? 'var(--ob-dim)' : 'var(--ob-unavailable)';
          } else if (have && best !== undefined) {
            const delta = split - best;
            right = formatDelta(delta);
            rightColor = delta <= 0 ? '#7ee081' : '#ff6b6b';
          }
          // Three separate grid items, not a wrapper -- `.ob-splits` is a CSS
          // grid and a wrapping element would break the column alignment
          // unless it were `display:contents`, which is more indirection than
          // three `appendChild` calls for the same result.
          const cp = document.createElement('span');
          cp.className = 'cp';
          cp.style.color = have ? '#8a8a96' : 'var(--ob-unavailable)';
          cp.textContent = label;

          const val = document.createElement('span');
          val.className = 'val';
          val.style.color = have ? 'var(--ob-text)' : 'var(--ob-unavailable)';
          val.textContent = have ? formatTime(split) : '—';

          const delta = document.createElement('span');
          delta.className = 'val';
          delta.style.color = rightColor;
          delta.textContent = right;

          elSplits.append(cp, val, delta);
        }
      }

      // Only while playing and not paused/dead: those states own the centre.
      elHint.classList.toggle('hidden', d.locked || !!d.phase);
      elCross.classList.toggle('hidden', !crosshair || !d.locked || crosshairStyle === 0);

      const finished = d.run?.state === 'finished';
      elFinished.classList.toggle('hidden', !finished || !!d.phase);
      if (finished && d.run) {
        elFinishedKicker.textContent = d.run.personalBest
          ? 'FINISHED · PERSONAL BEST'
          : 'FINISHED';
        elFinishedTime.textContent = formatTime(d.run.elapsed);
        elFinishedTime.style.color = d.run.personalBest ? '#ffd166' : 'var(--ob-text)';
      }

      elDead.classList.toggle('hidden', d.phase !== 'dead');
      elPaused.classList.toggle('hidden', d.phase !== 'paused');
      if (d.phase === 'paused' && d.attemptInfo) {
        elPausedSub.textContent =
          `${d.attemptInfo.mapName} · attempt ${d.attemptInfo.attempt} · ` +
          `${formatTime(d.attemptInfo.elapsed)} elapsed`;
        // Nothing was actually discarded pausing before a timed course's own
        // start gate, or on a freerun map -- see `AttemptInfo.voided`.
        elPausedBody.classList.toggle('hidden', !d.attemptInfo.voided);
        elPausedBadge.classList.toggle('hidden', !d.attemptInfo.voided);
      }

      // Everything but the active dialog dims behind it, per `Sh`/`Se`.
      const dimmed = !!d.phase;
      for (const el of dimmable) {
        el.classList.toggle('ob-dim-behind', dimmed);
      }
    },

    setMapName(name: string): void {
      elMap.textContent = name;
    },

    setMode(mode: string): void {
      elMode.textContent = mode;
    },

    dispose(): void {
      if (printTimer !== null) {
        clearTimeout(printTimer);
      }
      root.remove();
      style.remove();
    },
  };
}
