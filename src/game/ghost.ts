/**
 * Run recording and playback.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A ghost is a usercmd stream, not a path. Recording positions would be
 * simpler, but it would also be a different thing: a stream replayed through
 * the same deterministic pmove reproduces the run exactly, which means a ghost
 * doubles as a regression fixture and as proof the simulation is deterministic.
 * Replay a stream and get a different result, and the physics has drifted.
 *
 * This is the same shape `tools/replay.ts` already consumes, deliberately, so a
 * ghost recorded in the browser can be fed to the headless tooling unchanged.
 *
 * `GhostStore` keys on `(map, physics, msec, camera)`, the exact same tuple
 * `records.ts`'s own PR key uses now -- see that file's header for the full
 * reasoning, `camera` included. The physics half: VQ3 and CPM are not
 * comparable runs (CPM is reconstructed, not verified, and moves
 * differently), so a ghost saved under one must not surface -- or get
 * silently overwritten by a "personal best" -- while racing the other.
 * Before that fix, `GhostStore` keyed on `map` alone: finishing a map once in
 * CPM after already holding a VQ3 best there had `entry.best === null` for
 * the CPM key (a genuinely fresh combination, per `records.ts`), so
 * `runEnded` correctly reported it as an "improvement" for THAT key -- but
 * `GhostStore.save` still clobbered the one map-keyed ghost regardless of
 * which mode either run was in, and the next VQ3 attempt raced a CPM ghost it
 * can't legitimately replay (`ghostGame` builds its simulation from the
 * CURRENT session's physics mode, not the one the ghost was actually recorded
 * under).
 *
 * `camera` joined for a related but distinct reason: it does not change the
 * SIMULATION a ghost replays through (physics does), but it changes what the
 * opponent racing it is fair to compare yourself against -- a `side`-view PR
 * was set without the aim laser's information, an `fpv` one without seeing
 * your own body against the geometry. Racing a `chase` ghost while playing
 * `side` would be racing a run set under an easier information budget, same
 * complaint as racing a VQ3 ghost in CPM.
 *
 * Carrying `physics`/`camera` on the `GhostRun` itself, not just in the
 * storage key, is what makes a loaded ghost unambiguous about which mode and
 * view built it -- `main.ts`'s own save call is *already* gated on
 * `records.runEnded`'s `improved` return value, so within one full key a
 * worse run has never been able to overwrite a better one.
 *
 * MIGRATING AN OLD ENTRY: there is no single camera every pre-camera-key
 * ghost can be assumed to have been recorded under, the way `vq3` is
 * defensible for physics (VQ3 really was the only mode that ever ran).
 * `ob_basics`/`ob_rockets` ship their own `scripts/*.cam`, so
 * `resolveAutoCamera` has ALWAYS resolved them to `side` -- never `chase` --
 * for as long as camera modes have existed, long before this store tracked
 * which one a ghost was under. An earlier version of this migration adopted
 * an old entry only on a `chase` request, reasoning that `chase` was the
 * literal fallback default everywhere else `camera` is resolved -- which
 * silently orphaned every ghost on exactly the two bundled tutorial courses,
 * the first thing a new player runs, since a `side`-locked map's request is
 * never `chase`. The fix: adopt an old entry for WHATEVER camera asks first,
 * not just `chase`. A player who genuinely switched their camera preference
 * for the same map between sessions could get an old ghost credited to the
 * wrong view once -- a real but narrow cost, and a far smaller one than a
 * ghost never appearing at all for the maps most players see first.
 *
 * WHY A TICK CARRIES `weapon`: weapon switching (number keys, the mouse
 * wheel -- `main.ts`'s `selectWeapon`) is NOT part of `usercmd`. It is a
 * direct call on `Game` from a keyboard/wheel handler, outside the fixed-tick
 * loop entirely, so `attack` alone is not enough to reproduce a run that ever
 * switched weapons: replaying it fires whatever weapon the ghost's OWN
 * simulation happens to be holding, which can only ever be "whatever it last
 * auto-equipped from a pickup" without this, not whatever the recorded player
 * had actually selected. A course that uses more than one weapon --
 * switching from the rocket launcher to the grenade launcher for a lower,
 * flatter arc, say -- had the ghost fire the wrong projectile from the wrong
 * point in the arc, which compounds: a missed rocket jump is lost speed for
 * the rest of the run, not a one-tick error. Recorded on every tick, the same
 * way `forward`/`right`/etc. already are, rather than as a sparse
 * "switched at tick N" event list -- one more small integer per tick against
 * a payload that already carries six, for a format that never has to
 * reconstruct "what was equipped right now" by replaying history.
 *
 * WHY A RUN CARRIES A FULL `start` SNAPSHOT, NOT JUST `origin`: a course's
 * start gate is routinely crossed mid-strafe-jump, not from a dead stop --
 * that is the entire point of pre-start acceleration. `ghostGame` used to be
 * built with only the recorded origin, defaulting everything else
 * (`createPlayerState`) to zero velocity, grounded, no view-angle offset. Two
 * simulations fed the SAME subsequent usercmd stream but starting from
 * DIFFERENT velocity/ground-state diverge immediately -- pmove branches
 * between `PM_AirMove`/`PM_WalkMove` on `groundEntityNum` and every tick's
 * acceleration is relative to whatever velocity already exists, so "same
 * inputs" does not mean "same result" unless the starting state matches too.
 * On a straight strafe-jump corridor this reliably steers the ghost into a
 * wall within a few seconds -- the trajectory was wrong from tick one, not
 * drifting from something that started right. `capturePlayerSnapshot`/
 * `applyPlayerSnapshot` carry everything `PM_*` reads from `PlayerState`
 * (see their own doc) across that boundary the same way `weapon` already
 * carries what `Game` reads from outside `usercmd`.
 *
 * WHY A RUN CARRIES `player`: the ghost is drawn as a real player model now,
 * and the model it should wear is the one the RECORDING player wore -- a
 * ghost in someone else's skin is a small lie about whose run it is, and on a
 * shared machine with two people using different models it is a confusing
 * one. The name is `model/skin` (`doom/phobos`), the same string
 * `choosePlayerModel` answers with, and it is written from what actually
 * loaded rather than from what was requested, so a ghost never claims a model
 * that was not on screen. Optional, like `weapon` and `camera` before it, and
 * for the same reason: absent means "recorded before this existed, or drawn
 * with no model at all", and the renderer falls back to its own default
 * preference list. That is a cosmetic unknown, not an unreplayable ghost, so
 * it does not bump `version`.
 */

import type { GameInput } from './game.js';
import { Weapon } from './weapons.js';
import { defaultStore, legacyRecordKey, recordKey } from './records.js';
import type { CameraKey, PhysicsKey, RecordStore } from './records.js';
import type { PlayerState } from '../physics/types.js';
import { ENTITYNUM_NONE } from '../physics/constants.js';

/**
 * Everything `PM_*` reads from `PlayerState` that is not already reconstructed
 * from the usercmd stream or the map's own entities -- see the file header's
 * "why a run carries a full start snapshot". JSON-plain (no `Float32Array`/
 * `Int32Array`) so it round-trips through `localStorage` like the rest of a
 * `GhostRun`.
 */
export interface PlayerSnapshot {
  origin: [number, number, number];
  velocity: [number, number, number];
  viewangles: [number, number, number];
  deltaAngles: [number, number, number];
  pmFlags: number;
  pmTime: number;
  pmType: number;
  groundEntityNum: number;
  gravity: number;
  speed: number;
  jumppadFrame: number;
  /** CPM's double-jump window, so a ghost resumed mid-run can still double jump. */
  doubleJumpTime: number;
  jumppadEnt: number;
  health: number;
  armor: number;
  /** So a ghost recorded after practicing past the start line still has
   *  whatever it had already picked up -- see the file header. */
  ammo: number[];
  powerups: number[];
}

export function capturePlayerSnapshot(ps: PlayerState): PlayerSnapshot {
  return {
    origin: [ps.origin[0], ps.origin[1], ps.origin[2]],
    velocity: [ps.velocity[0], ps.velocity[1], ps.velocity[2]],
    viewangles: [ps.viewangles[0], ps.viewangles[1], ps.viewangles[2]],
    deltaAngles: [ps.delta_angles[0], ps.delta_angles[1], ps.delta_angles[2]],
    pmFlags: ps.pm_flags,
    pmTime: ps.pm_time,
    pmType: ps.pm_type,
    groundEntityNum: ps.groundEntityNum,
    gravity: ps.gravity,
    speed: ps.speed,
    jumppadFrame: ps.jumppad_frame,
    doubleJumpTime: ps.doubleJumpTime,
    jumppadEnt: ps.jumppad_ent,
    health: ps.health,
    armor: ps.armor,
    ammo: Array.from(ps.ammo),
    powerups: Array.from(ps.powerups),
  };
}

/** Applies a captured snapshot onto a live `PlayerState` -- `ghostGame`'s, before its first tick. */
export function applyPlayerSnapshot(ps: PlayerState, snap: PlayerSnapshot): void {
  ps.origin[0] = snap.origin[0];
  ps.origin[1] = snap.origin[1];
  ps.origin[2] = snap.origin[2];
  ps.velocity[0] = snap.velocity[0];
  ps.velocity[1] = snap.velocity[1];
  ps.velocity[2] = snap.velocity[2];
  ps.viewangles[0] = snap.viewangles[0];
  ps.viewangles[1] = snap.viewangles[1];
  ps.viewangles[2] = snap.viewangles[2];
  ps.delta_angles[0] = snap.deltaAngles[0];
  ps.delta_angles[1] = snap.deltaAngles[1];
  ps.delta_angles[2] = snap.deltaAngles[2];
  ps.pm_flags = snap.pmFlags;
  ps.pm_time = snap.pmTime;
  ps.pm_type = snap.pmType;
  ps.groundEntityNum = snap.groundEntityNum;
  ps.gravity = snap.gravity;
  ps.speed = snap.speed;
  ps.jumppad_frame = snap.jumppadFrame;
  ps.doubleJumpTime = snap.doubleJumpTime;
  ps.jumppad_ent = snap.jumppadEnt;
  ps.health = snap.health;
  ps.armor = snap.armor;
  for (let i = 0; i < ps.ammo.length; i++) {
    ps.ammo[i] = snap.ammo[i] ?? 0;
  }
  for (let i = 0; i < ps.powerups.length; i++) {
    ps.powerups[i] = snap.powerups[i] ?? 0;
  }
}

/** The snapshot a ghost saved before `start` existed gets: origin only,
 *  everything else at `createPlayerState`'s own defaults -- exactly today's
 *  pre-fix behaviour, kept rather than retroactively (and speculatively)
 *  reconstructed. See the file header. */
function legacySnapshot(origin: [number, number, number]): PlayerSnapshot {
  return {
    origin,
    velocity: [0, 0, 0],
    viewangles: [0, 0, 0],
    deltaAngles: [0, 0, 0],
    pmFlags: 0,
    pmTime: 0,
    pmType: 0,
    groundEntityNum: ENTITYNUM_NONE,
    gravity: 800,
    speed: 320,
    jumppadFrame: 0,
    doubleJumpTime: 0,
    jumppadEnt: 0,
    health: 125,
    armor: 0,
    ammo: [],
    powerups: [],
  };
}

/** The recorded form of one tick's input. */
export interface GhostTick {
  forward: number;
  right: number;
  up: number;
  yaw: number;
  pitch: number;
  attack: boolean;
  /** Which weapon was equipped when this tick's input was issued -- see the
   *  file header's "why a tick carries weapon". */
  weapon: Weapon;
}

export interface GhostRun {
  /** Format version, so an old recording can be recognised rather than misread. */
  version: 1;
  map: string;
  /**
   * Which pmove this was recorded under -- VQ3 and CPM are not the same
   * simulation, so a ghost is only a valid replay under the mode it was
   * built from. See the file header.
   */
  physics: PhysicsKey;
  /**
   * Which view this was recorded under. Does not affect replay (the
   * simulation does not know about cameras), only which PR it is fair to
   * race against -- see the file header.
   */
  camera: CameraKey;
  /**
   * The player model the run was recorded with, as `model/skin` --
   * `doom/phobos`, `sarge`. Absent when the run was recorded before this
   * field existed, or with no model drawn at all (no paks mounted); the
   * renderer falls back to its own default in both cases. See the file
   * header.
   */
  player?: string | undefined;
  /** Total run time in milliseconds. */
  time: number;
  /** Milliseconds per tick the run was recorded at. Replay must match. */
  msec: number;
  /** Full pmove-relevant state at the moment recording started -- see the
   *  file header's "why a run carries a full start snapshot". */
  start: PlayerSnapshot;
  ticks: GhostTick[];
  /** Checkpoint splits, if the course had any. */
  splits: number[];
  date: string;
}

/**
 * Records ticks while a run is in progress.
 *
 * Recording is unconditional once started and the buffer is only kept if the
 * run finishes, because a run that is abandoned halfway is not a ghost — and
 * the alternative, deciding per tick whether this run will turn out to be
 * worth keeping, is not knowable at the time.
 */
export class GhostRecorder {
  private ticks: GhostTick[] = [];
  private recording = false;
  private startState: PlayerSnapshot = legacySnapshot([0, 0, 0]);

  /**
   * The player model this run is being recorded with, `model/skin`.
   *
   * Mutable and unset by default rather than a constructor argument, because
   * the recorder is built before the model is: the model load is async and
   * can fall back to something other than what was asked for, and the name
   * worth recording is the one that actually loaded. Left undefined when
   * nothing loaded -- see the file header.
   */
  player: string | undefined = undefined;

  constructor(
    private readonly map: string,
    private readonly msec: number,
    private readonly physics: PhysicsKey = 'vq3',
    private readonly camera: CameraKey = 'chase',
  ) {}

  get active(): boolean {
    return this.recording;
  }

  get length(): number {
    return this.ticks.length;
  }

  /**
   * @param ps The live player's state AT THE MOMENT the run starts -- the
   *   whole thing, not just `origin`. See the file header for why a partial
   *   snapshot silently breaks any course crossed mid-air/mid-strafe-jump.
   */
  start(ps: PlayerState): void {
    this.recording = true;
    this.ticks = [];
    this.startState = capturePlayerSnapshot(ps);
  }

  stop(): void {
    this.recording = false;
  }

  /**
   * Record one tick. A no-op when not recording, so it is safe to call always.
   *
   * @param weapon The weapon equipped WHEN this input was issued -- the
   *   caller's own current weapon, read before this tick's `Game.step` (or
   *   any `selectWeapon` a keyboard/wheel handler makes) can change it. See
   *   the file header.
   */
  record(input: GameInput, weapon: Weapon): void {
    if (!this.recording) {
      return;
    }
    this.ticks.push({
      forward: input.forward ?? 0,
      right: input.right ?? 0,
      up: input.up ?? 0,
      yaw: input.yaw ?? 0,
      pitch: input.pitch ?? 0,
      attack: input.attack ?? false,
      weapon,
    });
  }

  /** Freeze what has been recorded into a run. Returns null if nothing has. */
  finish(time: number, splits: readonly number[] = []): GhostRun | null {
    this.recording = false;
    if (!this.ticks.length) {
      return null;
    }
    return {
      version: 1,
      map: this.map,
      physics: this.physics,
      camera: this.camera,
      player: this.player,
      time,
      msec: this.msec,
      start: this.startState,
      ticks: this.ticks,
      splits: [...splits],
      date: new Date().toISOString(),
    };
  }
}

/**
 * Plays a recorded run back as input.
 *
 * Feeding these into a second `Game` running the same world reproduces the run
 * tick for tick — there is no interpolation and no correction, because there is
 * nothing to correct: the same inputs through the same integer-millisecond
 * pmove give the same positions.
 */
export class GhostPlayer {
  private index = 0;

  constructor(private readonly run: GhostRun) {}

  get finished(): boolean {
    return this.index >= this.run.ticks.length;
  }

  get progress(): number {
    return this.run.ticks.length ? this.index / this.run.ticks.length : 1;
  }

  reset(): void {
    this.index = 0;
  }

  /**
   * The next tick's input and equipped weapon, or null once the recording
   * runs out. `weapon` is separate from `input` (rather than folded into
   * `GameInput`) because it is not usercmd -- the caller is expected to
   * apply it via `Game.selectWeapon` BEFORE stepping with `input`, the same
   * order the original tick was recorded in.
   */
  next(): { input: GameInput; weapon: Weapon } | null {
    const tick = this.run.ticks[this.index];
    if (!tick) {
      return null;
    }
    this.index++;
    return {
      input: {
        forward: tick.forward,
        right: tick.right,
        up: tick.up,
        yaw: tick.yaw,
        pitch: tick.pitch,
        attack: tick.attack,
      },
      weapon: tick.weapon,
    };
  }
}

/**
 * One saved ghost per `(map, physics, msec, camera)`, kept apart from the
 * record book.
 *
 * A 60-second run at 125Hz is 7500 ticks, so a ghost is two orders of
 * magnitude larger than a record. Storing them in the same blob would mean
 * re-serialising every ghost to update one time.
 */
export class GhostStore {
  constructor(private readonly store: RecordStore = defaultStore()) {}

  private key(map: string, physics: PhysicsKey, msec: number, camera: CameraKey): string {
    return `overbounce.ghost.v1.${recordKey(map, physics, msec, camera)}`;
  }

  /** The `(map, physics, msec)` key this store used before `camera` joined
   *  it -- checked for WHATEVER camera is requested now; see the file
   *  header's migration note for why restricting this to one camera silently
   *  broke every ghost on a `.cam`-scripted map. */
  private midKey(map: string, physics: PhysicsKey, msec: number): string {
    return `overbounce.ghost.v1.${legacyRecordKey(map, physics, msec)}`;
  }

  /** The bare `overbounce.ghost.v1.<map>` key this store used before it kept
   *  physics/msec apart at all -- see the file header. Only `vq3`/8ms ever
   *  existed under it, the same "only mode that ever ran" reasoning
   *  `records.ts`'s own v1 migration uses; camera is unrestricted for the
   *  same reason `midKey` is. */
  private legacyKey(map: string): string {
    return `overbounce.ghost.v1.${map}`;
  }

  load(map: string, physics: PhysicsKey, msec: number, camera: CameraKey): GhostRun | null {
    const raw = this.store.getItem(this.key(map, physics, msec, camera));
    if (raw) {
      try {
        return parseGhost(JSON.parse(raw));
      } catch {
        return null;
      }
    }

    // One-time migration, generation 1: a ghost saved after physics/msec
    // joined the key but before camera did. Adopted as THIS request's
    // camera -- `parseGhost` would otherwise default a field-less entry to
    // `chase` regardless of who is asking, which would both misreport it and
    // save the adoption under the wrong key, defeating "only ever runs once".
    const midRaw = this.store.getItem(this.midKey(map, physics, msec));
    if (midRaw) {
      let mid: GhostRun | null;
      try {
        mid = parseGhost(JSON.parse(midRaw));
      } catch {
        mid = null;
      }
      if (mid) {
        const adopted: GhostRun = { ...mid, camera };
        this.save(adopted);
        return adopted;
      }
    }

    // One-time migration, generation 0: a ghost saved before this store
    // carried anything but the map in its key at all. Only valid to hand
    // back as a vq3/8ms result -- it may in fact have been recorded under
    // CPM, but there is no way to tell from the old key alone, and vq3 is
    // what the app exclusively ran before CPM existed. Camera is adopted the
    // same way generation 1 is, for the same reason.
    if (physics !== 'vq3' || msec !== 8) {
      return null;
    }
    const legacyRaw = this.store.getItem(this.legacyKey(map));
    if (!legacyRaw) {
      return null;
    }
    let legacy: GhostRun | null;
    try {
      legacy = parseGhost(JSON.parse(legacyRaw));
    } catch {
      return null;
    }
    if (!legacy) {
      return null;
    }
    const adopted: GhostRun = { ...legacy, camera };
    this.save(adopted);
    return adopted;
  }

  /** The key comes from `run` itself -- `map`, `physics`, `msec` and `camera`
   *  are all on it. */
  save(run: GhostRun): boolean {
    try {
      this.store.setItem(this.key(run.map, run.physics, run.msec, run.camera), JSON.stringify(run));
      return true;
    } catch {
      // A long run can exceed the quota. Losing the ghost is acceptable;
      // losing the time is not, and that lives in the record book.
      return false;
    }
  }

  /**
   * Course select's "Reset PR" drops the ghost alongside the record it came
   * from -- a ghost that outlives the PR it represents would keep racing
   * against a time the player just asked to forget. Only the current-key
   * ghost; a stray pre-camera-key entry is harmless leftover, same as
   * `RecordBook.deleteEntry`'s treatment of the equivalent case.
   */
  delete(map: string, physics: PhysicsKey, msec: number, camera: CameraKey): void {
    this.store.removeItem?.(this.key(map, physics, msec, camera));
  }
}

/**
 * `Weapon` is a `const enum` -- inlined at compile time, so there is no
 * runtime object to enumerate its members from. The valid range is
 * `Weapon.NONE`..`Weapon.PLASMAGUN` (0..3); written out numerically here
 * rather than referencing the enum members so this keeps compiling even if
 * TSConfig's `isolatedModules` ever forces `Weapon` off `const`.
 */
function isWeapon(value: unknown): value is Weapon {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3;
}

function vec3Tuple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => typeof n !== 'number')) {
    return null;
  }
  return [value[0], value[1], value[2]];
}

/**
 * Strict: a `start` field that is PRESENT but malformed means real corruption
 * (something wrote a broken snapshot), which is worse to silently paper over
 * with defaults than to refuse -- unlike a `start` field that is simply
 * ABSENT (an old ghost, before this field existed), which `parseGhost` falls
 * back to `legacySnapshot` for instead of calling this at all.
 */
function readPlayerSnapshot(value: unknown): PlayerSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const s = value as Record<string, unknown>;
  const origin = vec3Tuple(s.origin);
  const velocity = vec3Tuple(s.velocity);
  const viewangles = vec3Tuple(s.viewangles);
  const deltaAngles = vec3Tuple(s.deltaAngles);
  if (!origin || !velocity || !viewangles || !deltaAngles) {
    return null;
  }
  const num = (k: string, fallback: number): number => (typeof s[k] === 'number' ? (s[k] as number) : fallback);
  const numArray = (k: string): number[] => (Array.isArray(s[k]) ? (s[k] as unknown[]).filter((n): n is number => typeof n === 'number') : []);
  return {
    origin,
    velocity,
    viewangles,
    deltaAngles,
    pmFlags: num('pmFlags', 0),
    pmTime: num('pmTime', 0),
    pmType: num('pmType', 0),
    groundEntityNum: num('groundEntityNum', ENTITYNUM_NONE),
    gravity: num('gravity', 800),
    speed: num('speed', 320),
    jumppadFrame: num('jumppadFrame', 0),
    doubleJumpTime: num('doubleJumpTime', 0),
    jumppadEnt: num('jumppadEnt', 0),
    health: num('health', 125),
    armor: num('armor', 0),
    ammo: numArray('ammo'),
    powerups: numArray('powerups'),
  };
}

/** Validate anything claiming to be a ghost, e.g. out of localStorage. */
export function parseGhost(value: unknown): GhostRun | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const g = value as Partial<GhostRun> & { origin?: unknown };
  if (g.version !== 1 || typeof g.map !== 'string' || !Array.isArray(g.ticks)) {
    return null;
  }
  if (typeof g.time !== 'number' || !Number.isFinite(g.time)) {
    return null;
  }
  // `start` is the current field; a ghost saved before it existed has a bare
  // `origin` instead -- see `legacySnapshot`'s own doc for why that degrades
  // rather than reconstructs. A `start` that IS present but broken rejects
  // the whole ghost (see `readPlayerSnapshot`); one that is simply absent
  // falls back to the legacy origin-only snapshot, or null if there is
  // neither -- nothing here to replay from.
  let start: PlayerSnapshot | null;
  if (g.start !== undefined) {
    start = readPlayerSnapshot(g.start);
  } else {
    const legacyOrigin = vec3Tuple(g.origin);
    start = legacyOrigin ? legacySnapshot(legacyOrigin) : null;
  }
  if (!start) {
    return null;
  }

  const ticks: GhostTick[] = [];
  for (const raw of g.ticks) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const t = raw as Partial<GhostTick>;
    // A ghost with a malformed tick is not repairable: replaying it would
    // silently diverge, which is worse than refusing it.
    if (
      typeof t.forward !== 'number' ||
      typeof t.right !== 'number' ||
      typeof t.up !== 'number' ||
      typeof t.yaw !== 'number'
    ) {
      return null;
    }
    ticks.push({
      forward: t.forward,
      right: t.right,
      up: t.up,
      yaw: t.yaw,
      pitch: typeof t.pitch === 'number' ? t.pitch : 0,
      attack: t.attack === true,
      // A ghost saved before GhostTick carried this field defaults to NONE,
      // the same "safe no-op" `selectWeapon` already gives any weapon with no
      // ammo -- see `Game.selectWeapon`'s own `WeaponTag.NONE` guard. Such a
      // ghost was never going to switch weapons correctly anyway (the field
      // did not exist to record it); this just keeps it loadable rather than
      // rejecting it outright, same "do not re-orphan an old ghost" stance
      // the camera/physics migrations already take.
      weapon: isWeapon(t.weapon) ? t.weapon : Weapon.NONE,
    });
  }

  return {
    version: 1,
    map: g.map,
    // A ghost saved before GhostRun carried this field is `vq3` -- the only
    // mode that existed at the time, same reasoning as `records.ts`'s own
    // v1 migration.
    physics: g.physics === 'cpm' ? 'cpm' : 'vq3',
    // Same reasoning, one generation later: a ghost saved before `camera`
    // existed on it is `chase`, the default and the only camera an entry
    // with no camera field could unambiguously have been recorded under.
    camera: g.camera === 'side' ? 'side' : g.camera === 'fpv' ? 'fpv' : 'chase',
    // Lenient, unlike `start`: an unrecognised model name is not corruption,
    // it is a model that is simply not in THIS session's paks -- which is the
    // ordinary case for a ghost carried between installs, and which the
    // renderer already handles by falling back. Rejecting the whole ghost
    // over a cosmetic field would throw away a valid run.
    player: typeof g.player === 'string' && g.player ? g.player : undefined,
    time: g.time,
    msec: typeof g.msec === 'number' && g.msec > 0 ? g.msec : 8,
    start,
    ticks,
    splits: Array.isArray(g.splits)
      ? g.splits.filter((s): s is number => typeof s === 'number')
      : [],
    date: typeof g.date === 'string' ? g.date : '',
  };
}
