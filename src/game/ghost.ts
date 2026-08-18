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
 */

import type { GameInput } from './game.js';
import { defaultStore } from './records.js';
import type { RecordStore } from './records.js';

/** The recorded form of one tick's input. */
export interface GhostTick {
  forward: number;
  right: number;
  up: number;
  yaw: number;
  pitch: number;
  attack: boolean;
}

export interface GhostRun {
  /** Format version, so an old recording can be recognised rather than misread. */
  version: 1;
  map: string;
  /** Total run time in milliseconds. */
  time: number;
  /** Milliseconds per tick the run was recorded at. Replay must match. */
  msec: number;
  origin: [number, number, number];
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
  private startOrigin: [number, number, number] = [0, 0, 0];

  constructor(
    private readonly map: string,
    private readonly msec: number,
  ) {}

  get active(): boolean {
    return this.recording;
  }

  get length(): number {
    return this.ticks.length;
  }

  start(origin: ArrayLike<number>): void {
    this.recording = true;
    this.ticks = [];
    this.startOrigin = [origin[0], origin[1], origin[2]];
  }

  stop(): void {
    this.recording = false;
  }

  /** Record one tick. A no-op when not recording, so it is safe to call always. */
  record(input: GameInput): void {
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
      time,
      msec: this.msec,
      origin: [...this.startOrigin],
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

  /** The next tick's input, or null once the recording runs out. */
  next(): GameInput | null {
    const tick = this.run.ticks[this.index];
    if (!tick) {
      return null;
    }
    this.index++;
    return {
      forward: tick.forward,
      right: tick.right,
      up: tick.up,
      yaw: tick.yaw,
      pitch: tick.pitch,
      attack: tick.attack,
    };
  }
}

/**
 * One saved ghost per map, kept apart from the record book.
 *
 * A 60-second run at 125Hz is 7500 ticks, so a ghost is two orders of
 * magnitude larger than a record. Storing them in the same blob would mean
 * re-serialising every ghost to update one time.
 */
export class GhostStore {
  constructor(private readonly store: RecordStore = defaultStore()) {}

  private key(map: string): string {
    return `overbounce.ghost.v1.${map}`;
  }

  load(map: string): GhostRun | null {
    const raw = this.store.getItem(this.key(map));
    if (!raw) {
      return null;
    }
    try {
      return parseGhost(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  save(run: GhostRun): boolean {
    try {
      this.store.setItem(this.key(run.map), JSON.stringify(run));
      return true;
    } catch {
      // A long run can exceed the quota. Losing the ghost is acceptable;
      // losing the time is not, and that lives in the record book.
      return false;
    }
  }
}

/** Validate anything claiming to be a ghost, e.g. out of localStorage. */
export function parseGhost(value: unknown): GhostRun | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const g = value as Partial<GhostRun>;
  if (g.version !== 1 || typeof g.map !== 'string' || !Array.isArray(g.ticks)) {
    return null;
  }
  if (typeof g.time !== 'number' || !Number.isFinite(g.time)) {
    return null;
  }
  if (!Array.isArray(g.origin) || g.origin.length !== 3) {
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
    });
  }

  return {
    version: 1,
    map: g.map,
    time: g.time,
    msec: typeof g.msec === 'number' && g.msec > 0 ? g.msec : 8,
    origin: [g.origin[0], g.origin[1], g.origin[2]],
    ticks,
    splits: Array.isArray(g.splits)
      ? g.splits.filter((s): s is number => typeof s === 'number')
      : [],
    date: typeof g.date === 'string' ? g.date : '',
  };
}
