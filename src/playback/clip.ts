/**
 * The playback intermediate representation: one shape both a ghost and a
 * `.dm_68` demo decode into.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ## Why one shape for two very different things
 *
 * A ghost is a usercmd stream, replayed by RE-SIMULATING it through the same
 * deterministic pmove that recorded it. A demo is a network stream, replayed
 * by DECODING what a server already decided and interpolating between its
 * snapshots. Nothing about how they produce a frame is shared, and the
 * obvious consequence -- build two players -- is the thing this file exists
 * to refuse. The camera rig, the timeline, the export path and the renderer
 * should each be written once, and they can be, because what they all
 * actually need is the same small answer: *where is everything at time t*.
 *
 * `PlaybackClip` is that question. Everything above it sees only this.
 *
 * ## The POV is a `PlayerState`
 *
 * Not a bespoke struct. `src/render/player-anim.ts`'s `AnimatedPlayer`
 * already drives MD3 frames from `legsAnim`/`torsoAnim` on a `PlayerState`,
 * and a demo's playerState netfields cover those plus `viewangles`,
 * `weapon`, `pm_flags` and `groundEntityNum`. Using the type the renderer
 * already speaks is what lets one avatar path draw a ghost and a demo POV
 * without knowing which it has.
 *
 * ## Time
 *
 * Clip time is milliseconds from the START of the clip, always -- zero-based,
 * regardless of what absolute clock the source used. A demo's `serverTime`
 * starts at whatever the server happened to be at (880 in the sample DeFRaG
 * demo); a ghost's simulation starts at 0. Rebasing here means a scrubber, a
 * timeline keyframe and an export range are all in one unit and none of them
 * has to know the source.
 *
 * ## Sampling is sub-tick, and interpolation is the VIEW's job
 *
 * Export renders at 30, 60 or 120fps; the physics tick is 8ms and a demo
 * snapshot is 8-50ms. Neither divides the other, so `sample` returns a state
 * plus the bracketing pair it came from -- and the clip does the
 * interpolation, because only the clip knows the right way to do it (angles
 * take the short way round, entity trajectories are analytic rather than
 * lerped). What it must never do is move the SIMULATION off the integer
 * tick; nothing under `src/physics/` is involved in sampling at all.
 */

import type { PlayerState } from '../physics/types.js';
import type { CameraKey, PhysicsKey } from '../game/records.js';
import type { Weapon } from '../game/weapons.js';
import type { Game, GameFrame } from '../game/game.js';
import { findTrack, timeScaleAt } from './timeline.js';
import type { Timeline } from './timeline.js';

/** Which kind of recording a clip came from. */
export type ClipKind = 'ghost' | 'demo';

/** What a clip knows about itself, for the library list and the pause menu. */
export interface ClipMeta {
  kind: ClipKind;
  /** Display name -- a filename, or a ghost's map and time. */
  name: string;
  /** The map this needs mounted, lowercased. Empty if the source has none. */
  map: string;
  /**
   * The physics the recording was made under.
   *
   * `'unknown'` is a real answer and only a demo can produce it: VQ3 versus
   * CPM is a server cvar and plenty of servers publish neither. A ghost
   * always knows, because Overbounce recorded it.
   */
  physics: PhysicsKey | 'unknown';
  /** Total length in milliseconds. */
  durationMs: number;
  /**
   * The camera playback opens in.
   *
   * Fixed `fpv` for a demo -- that is what a `.dm_68` recorded, a first-person
   * view with no other information in it. A ghost opens in the camera it was
   * recorded with (`GhostRun.camera`), because that is the view its run was
   * actually performed under.
   */
  defaultCamera: CameraKey;
  /** Who recorded it, when the source says. */
  playerName: string;
  /** Their `model/skin`, when the source says. */
  playerModel: string;
  /**
   * A run time the SOURCE claims, distinct from `durationMs`.
   *
   * A ghost's is authoritative (Overbounce timed it). A demo's comes from the
   * filename convention and is a claim by whoever named the file -- a demo
   * holds the walk to the start line and whatever happened after the finish,
   * so its duration and its run time are different numbers. Null when there
   * is no claim.
   */
  runTimeMs: number | null;
}

/** One non-POV thing in the world at a moment: another player, a missile, an item. */
export interface PlaybackEntity {
  /** The source's own entity number, stable across frames. */
  number: number;
  /** `entityType_t`. `EntityType` in `src/demo/state.ts`. */
  eType: number;
  origin: [number, number, number];
  angles: [number, number, number];
  /** For a player entity: which client, so a name and model can be found. */
  clientNum: number;
  /** Overbounce's `Weapon`, already mapped out of `weapon_t`. */
  weapon: Weapon;
  legsAnim: number;
  torsoAnim: number;
  /** A configstring model index, for whatever the source resolves it against. */
  modelindex: number;
  /** True when this entity was in the previous frame too, so the renderer
   *  knows whether it may interpolate toward it. False across a teleport. */
  interpolate: boolean;
}

/** Something that happened at a moment: a shot, a landing, a pickup. */
export interface PlaybackEvent {
  /** Clip time in ms. */
  time: number;
  /** Quake's `entity_event_t` number, or a ghost's own `PmEvent`. */
  event: number;
  eventParm: number;
  /** Where, when the event has a position. */
  origin: [number, number, number];
  /** Which entity raised it -- the POV is the clip's own POV number. */
  number: number;
}

/** Everything at one instant. */
export interface PlaybackScene {
  /** Clip time in ms this was sampled at. */
  time: number;
  /**
   * The POV player.
   *
   * OWNED BY THE CLIP and reused between samples -- copy anything that has to
   * outlive the next `sample` call. A clip is sampled once per rendered
   * frame, and allocating a `PlayerState` (five typed arrays) per frame for
   * the whole of an export is the kind of garbage `.agent/docs/
   * perf-gate-findings.md` points out V8's heap profiler cannot even see.
   */
  ps: PlayerState;
  /**
   * The POV's equipped weapon, in Overbounce numbering.
   *
   * OUTSIDE `ps` on purpose, because that is where it lives in this codebase:
   * `PlayerState` is the physics type and pmove has no weapon input, so
   * `Game` owns the current weapon as a field of its own and `GhostTick`
   * records it separately from the usercmd (see `ghost.ts`'s "why a tick
   * carries `weapon`"). Quake's `playerState_t` DOES carry one, which is why
   * this is worth stating: the demo side has to move it out of the
   * playerstate on the way in, rather than the ghost side inventing a place
   * to put it.
   */
  weapon: Weapon;
  /** `weaponstate_t`, and the ms until the weapon is ready. Demo-only --
   *  a ghost clip leaves both at zero, since `Game` does not model them. */
  weaponState: number;
  weaponTime: number;
  /** Everything else. Empty for a ghost clip, which has no other entities. */
  entities: readonly PlaybackEntity[];
  /** Events since the previous sample, oldest first. Empty when scrubbing
   *  backwards -- an event is a thing that happened, not a thing that is. */
  events: readonly PlaybackEvent[];
}

/**
 * One tick's worth of things that HAPPENED, for a renderer that wants to
 * make a noise and stamp a decal.
 *
 * `PlaybackEvent` is deliberately not this: it is the flat
 * `{event, eventParm, origin}` triple Quake sends over the wire, which is
 * all a demo has, and it cannot carry a shotgun's eleven pellet normals or a
 * rail's two endpoints. A ghost is a re-simulation and therefore has the
 * whole structured truth, so it hands the `GameFrame` over as it stands.
 *
 * The arrays inside are safe to hold: `Game` REPLACES them each tick rather
 * than clearing them in place, and every record in them is freshly built.
 */
export interface PlaybackTickFx {
  /** Clip time in ms of the tick that produced it. */
  time: number;
  frame: GameFrame;
}

/**
 * A recording that can be watched.
 *
 * `seek` is separated from `sample` because for a ghost they cost wildly
 * different amounts: sampling is a lerp between two already-simulated ticks,
 * while seeking backwards is a rewind and re-simulate. Playing forward
 * touches only `sample`; a scrubber calls `seek`.
 */
export interface PlaybackClip {
  readonly meta: ClipMeta;
  /** Same as `meta.durationMs`, for convenience at the call site. */
  readonly duration: number;

  /**
   * Move to `timeMs`. May be expensive (a ghost re-simulates when the target
   * is behind where it already is). Clamped to `[0, duration]`.
   */
  seek(timeMs: number): void;

  /**
   * The world at `timeMs`. Advances the clip to that time first, so calling
   * this alone is enough to play forward.
   *
   * The returned scene is owned by the clip -- see `PlaybackScene.ps`.
   */
  sample(timeMs: number): PlaybackScene;

  /**
   * Per-tick effects that are due by `timeMs`, removing them from the queue.
   *
   * GHOST ONLY, and optional for exactly that reason -- see `PlaybackTickFx`.
   * A demo's sounds come through `PlaybackScene.events` instead, which is
   * less, because a demo genuinely knows less.
   */
  takeFx?(timeMs: number): readonly PlaybackTickFx[];

  /**
   * The live simulation behind a re-simulated clip.
   *
   * GHOST ONLY, and optional for the same reason `takeFx` is. It exists for
   * the things the IR deliberately does not carry because a demo could never
   * fill them in -- the map's `ItemWorld`, in particular, which knows which
   * pickups this run actually took and when they come back. A demo falls
   * back to the map's own placements.
   */
  readonly simulation?: Game;

  /**
   * The clip times of overbounces the playhead has just crossed, drained.
   *
   * DEMO ONLY, and the mirror image of `takeFx`'s "ghost only". A ghost is
   * re-simulated, so an overbounce is found where the live game finds one --
   * on the 8ms tick, from the `GameFrame` `takeFx` already hands over. A demo
   * has no ticks, and its sampled playerstate cannot answer the question
   * either: `CG_InterpolatePlayerState` lerps velocity while copying
   * `groundEntityNum` whole, so by the frame the ground flag flips the
   * sampled speed has already been smeared most of the way to the landing
   * value and the jump the test looks for has been interpolated out of
   * existence. Only the raw snapshot pair still has it, which is inside the
   * clip and nowhere else.
   */
  takeOverbounces?(): readonly number[];

  /** Release anything held. Safe to call twice. */
  dispose(): void;
}

/** What "render this timeline to a video" needs to know. */
export interface ExportConfig {
  width: number;
  height: number;
  /** 30, 60 or 120 in the UI; anything positive here. */
  fps: number;
  bitrateMbps: number;
  /** The timeline's in/out markers, in clip milliseconds. */
  inPoint: number;
  outPoint: number;
}

/** `Pe`'s defaults: 1080p60 at 16 Mbps. */
export function defaultExportConfig(duration: number): ExportConfig {
  return {
    width: 1920,
    height: 1080,
    fps: 60,
    bitrateMbps: 16,
    inPoint: 0,
    outPoint: duration,
  };
}

/**
 * The exact clip times an export renders at.
 *
 * The whole point is that rendering frame N is `sample(frameTimes[N])` with
 * NO wall clock anywhere: an export must not drop or duplicate a frame
 * because the machine was busy, and it must produce byte-identical output
 * twice in a row. Deriving every timestamp up front from `fps` alone is what
 * guarantees that, and it is also what makes an export of a ghost clip exact
 * -- the clip seeks to a stated time rather than accumulating a delta.
 *
 * The range is HALF-OPEN: `[inPoint, outPoint)`. Each frame stands for the
 * interval that begins at its timestamp, so a one-second range at 60fps is 60
 * frames starting at 0 and ending at 983.33 -- the frame at exactly 1000 is
 * the first frame of the NEXT second and including it would make every
 * exported clip one frame long.
 *
 * The count is rounded rather than floored, and that is deliberate: at 60fps
 * the interval is 16.666... and `1000 / (1000/60)` comes out as
 * 59.99999999999999 in binary floating point, so flooring drops the last
 * frame of a range that divides exactly. Rounding also keeps a nearly-whole
 * final frame instead of discarding it. A range shorter than one frame still
 * yields a single frame, because exporting a marked range and getting no
 * video is never the answer.
 *
 * Each timestamp is computed as `inPoint + i * interval` rather than by
 * accumulating, so error cannot build up across a long export.
 *
 * ## `timeScale` is the one thing that breaks the uniform step
 *
 * A time scale is SLOW MOTION, which means the output gets longer: the
 * playback loop advances its clock by `dt * timeScaleAt`, so a span marked
 * 0.5x takes twice as long to watch. An export that ignored it would render
 * the same span at normal speed -- the shot on screen and the shot in the
 * file would be different shots, which is exactly what this function exists
 * to prevent.
 *
 * So with a `timeScale` track the walk is INCREMENTAL: each output frame
 * advances clip time by `interval * timeScaleAt(timeline, t)`, mirroring the
 * loop one for one. That gives up the "no accumulated error" property above,
 * and it has to -- the step depends on where you are, so there is no closed
 * form to compute the Nth timestamp from. It gives up nothing else: the walk
 * is still a pure function of the timeline and `fps`, with no wall clock in
 * it, so two exports of the same timeline are still byte-identical.
 *
 * Without such a track -- which is every clip nobody has keyframed -- the
 * exact uniform form is what runs, unchanged.
 *
 * The loop is capped rather than trusted to terminate. `timeScaleAt` clamps
 * positive at 0.01 so progress is guaranteed, and the cap is simply what that
 * clamp implies: a hundred frames of output per frame of source, and not one
 * more. It is a guard against a future change to the clamp, not against any
 * value a user can currently set.
 *
 * **What does NOT follow the scale is the audio.** The export's sound is
 * captured off the same frame loop, so a slowed span produces slowed picture
 * against sound that plays at its own rate. Pitching audio is a resampling
 * problem rather than a timeline one, and it is not solved here.
 */
export function frameTimes(config: ExportConfig, timeline?: Timeline): number[] {
  const out: number[] = [];
  if (config.fps <= 0 || config.outPoint <= config.inPoint) {
    return out;
  }
  const interval = 1000 / config.fps;
  const scaled = timeline && findTrack(timeline, 'timeScale') !== undefined;
  if (!scaled) {
    const count = Math.max(1, Math.round((config.outPoint - config.inPoint) / interval));
    for (let i = 0; i < count; i++) {
      out.push(config.inPoint + i * interval);
    }
    return out;
  }
  const cap = Math.max(1, Math.round((config.outPoint - config.inPoint) / interval)) * 100;
  let t = config.inPoint;
  while (t < config.outPoint && out.length < cap) {
    out.push(t);
    t += interval * timeScaleAt(timeline, t);
  }
  // A range shorter than one frame still yields a single frame, for the same
  // reason the uniform path rounds up to one: exporting a marked range and
  // getting no video is never the answer.
  if (out.length === 0) {
    out.push(config.inPoint);
  }
  return out;
}

/** No entities and no events -- shared so a ghost clip's scene allocates nothing. */
export const NO_ENTITIES: readonly PlaybackEntity[] = [];
export const NO_EVENTS: readonly PlaybackEvent[] = [];
