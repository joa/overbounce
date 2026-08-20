/**
 * Personal best times, and the run-history data under Results (R6).
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * There is no server and no leaderboard: a run is between the player and the
 * map. localStorage is the whole store, and every read is defensive because it
 * is shared with every other page on the origin and can contain anything.
 *
 * v1 keyed records on the map name alone. v2 keys on `(map, physics, msec)` --
 * `.agent/plans/UI.md`'s R6: changing physics or tick rate clears nothing,
 * because records are kept per mode, and CPM is ranked separately from VQ3
 * since it is reconstructed rather than verified. `msec` (milliseconds per
 * physics tick, `PMOVE_MSEC`) is in the key even though nothing varies it yet
 * -- Settings (R7, Phase 6) exposes pmove tick rate, and 125 jumps higher than
 * 60 or 1000, so a future tick-rate change must not silently merge times that
 * are not comparable. v1 had no physics concept, so it migrates as `vq3` at
 * 8ms/125Hz -- the only defensible guess, since VQ3 carries the fidelity
 * guarantee and 125 was the only tick rate that ever ran.
 *
 * Migration reads the v1 key once, on first v2 construction, and leaves it in
 * place rather than deleting it -- a one-way migration with no rollback path
 * is a worse failure mode than a few stray kilobytes of localStorage.
 */

const V1_KEY = 'overbounce.records.v1';
const V2_KEY = 'overbounce.records.v2';

export type PhysicsKey = 'vq3' | 'cpm';

export interface RunRecord {
  /** Best total time in milliseconds. */
  time: number;
  /** Cumulative-at-checkpoint splits from the run that set it. */
  splits: number[];
  /** ISO date the record was set. */
  date: string;
  /** Downsampled ups-over-time trace from the run that set it. */
  speedSeries?: number[];
}

export interface RecordCounters {
  started: number;
  completed: number;
  died: number;
  /** Attempts abandoned without dying -- a voided pause counts here. */
  restarted: number;
}

export interface RecentRun {
  avgSpeed: number;
  topSpeed: number;
  /** Cumulative time on this map, in ms, once this run is folded in. Results'
   *  speed-per-hour-played curve is this ring read by `atMs`. */
  atMs: number;
  date: string;
}

/** The last N completed runs kept per map/mode, for "avg last 10" and the Rc curve. */
const RECENT_RUNS_MAX = 50;

export interface MapRecord {
  best: RunRecord | null;
  /**
   * Best duration of each segment ever recorded, indexed like `splits` --
   * NOT the segments of the best run. A run that missed the overall record
   * can still hold the fastest cp2->cp3 split; sum-of-best tracks that
   * per-segment optimum across every completed run.
   */
  sumOfBest: number[];
  counters: RecordCounters;
  timeOnMapMs: number;
  /** ISO date of the first `runStarted` ever recorded for this key. */
  firstSeen: string;
  recentRuns: RecentRun[];
}

export type RunOutcome =
  | {
      kind: 'finished';
      time: number;
      splits: number[];
      speedSeries?: number[];
      avgSpeed: number;
      topSpeed: number;
    }
  | { kind: 'died'; timeOnMapMs: number }
  | { kind: 'restarted'; timeOnMapMs: number };

/**
 * A storage backend. Injected so the record logic is testable in Node, where
 * there is no localStorage, and so a browser with storage disabled degrades to
 * "no records kept" rather than throwing on the first run.
 */
export interface RecordStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage if it is usable, otherwise an in-memory stand-in. */
export function defaultStore(): RecordStore {
  try {
    const probe = '__ob_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    // Private browsing, disabled storage, or no DOM at all.
    const memory = new Map<string, string>();
    return {
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => {
        memory.set(k, v);
      },
    };
  }
}

function recordKey(map: string, physics: PhysicsKey, msec: number): string {
  return `${map}|${physics}|${msec}`;
}

function emptyCounters(): RecordCounters {
  return { started: 0, completed: 0, died: 0, restarted: 0 };
}

function emptyMapRecord(): MapRecord {
  return {
    best: null,
    sumOfBest: [],
    counters: emptyCounters(),
    timeOnMapMs: 0,
    firstSeen: '',
    recentRuns: [],
  };
}

/** `{ time, splits, date }`, validated the way v1's reader always did. */
function readRunRecord(value: unknown): RunRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const entry = value as { time?: unknown; splits?: unknown; date?: unknown; speedSeries?: unknown };
  if (typeof entry.time !== 'number' || !Number.isFinite(entry.time) || entry.time <= 0) {
    return null;
  }
  const speedSeries = Array.isArray(entry.speedSeries)
    ? entry.speedSeries.filter((s): s is number => typeof s === 'number' && Number.isFinite(s))
    : undefined;
  return {
    time: entry.time,
    splits: Array.isArray(entry.splits)
      ? entry.splits.filter((s): s is number => typeof s === 'number')
      : [],
    date: typeof entry.date === 'string' ? entry.date : '',
    ...(speedSeries ? { speedSeries } : {}),
  };
}

function readCounters(value: unknown): RecordCounters {
  if (!value || typeof value !== 'object') {
    return emptyCounters();
  }
  const c = value as Record<string, unknown>;
  const field = (k: string): number =>
    typeof c[k] === 'number' && Number.isFinite(c[k]) && (c[k] as number) >= 0 ? (c[k] as number) : 0;
  return { started: field('started'), completed: field('completed'), died: field('died'), restarted: field('restarted') };
}

function readRecentRuns(value: unknown): RecentRun[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: RecentRun[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const r = item as { avgSpeed?: unknown; topSpeed?: unknown; atMs?: unknown; date?: unknown };
    if (typeof r.avgSpeed !== 'number' || typeof r.topSpeed !== 'number' || typeof r.atMs !== 'number') {
      continue;
    }
    out.push({
      avgSpeed: r.avgSpeed,
      topSpeed: r.topSpeed,
      atMs: r.atMs,
      date: typeof r.date === 'string' ? r.date : '',
    });
  }
  return out.slice(-RECENT_RUNS_MAX);
}

/** Validates one `MapRecord`, dropping the fields that do not look right rather than the whole entry. */
function readMapRecord(value: unknown): MapRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const m = value as Record<string, unknown>;
  return {
    best: readRunRecord(m.best),
    sumOfBest: Array.isArray(m.sumOfBest)
      ? m.sumOfBest.filter((s): s is number => typeof s === 'number' && Number.isFinite(s) && s >= 0)
      : [],
    counters: readCounters(m.counters),
    timeOnMapMs:
      typeof m.timeOnMapMs === 'number' && Number.isFinite(m.timeOnMapMs) && m.timeOnMapMs >= 0
        ? m.timeOnMapMs
        : 0,
    firstSeen: typeof m.firstSeen === 'string' ? m.firstSeen : '',
    recentRuns: readRecentRuns(m.recentRuns),
  };
}

export class RecordBook {
  private records: Record<string, MapRecord> = {};

  constructor(private readonly store: RecordStore = defaultStore()) {
    this.records = this.read();
  }

  private read(): Record<string, MapRecord> {
    const raw = this.store.getItem(V2_KEY);
    if (!raw) {
      return this.migrateFromV1();
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, MapRecord> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = readMapRecord(value);
        if (entry) {
          out[key] = entry;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  /** One-time: fold v1's `{ map: { time, splits, date } }` into v2 as `vq3` at 8ms. */
  private migrateFromV1(): Record<string, MapRecord> {
    const raw = this.store.getItem(V1_KEY);
    if (!raw) {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const out: Record<string, MapRecord> = {};
    for (const [map, value] of Object.entries(parsed as Record<string, unknown>)) {
      const run = readRunRecord(value);
      if (!run) {
        continue;
      }
      const entry = emptyMapRecord();
      entry.best = run;
      entry.firstSeen = run.date;
      // The only per-segment history v1 has is the record run's own splits --
      // seed sum-of-best from them, converted from cumulative to per-segment.
      let prev = 0;
      for (const cum of run.splits) {
        entry.sumOfBest.push(Math.max(0, cum - prev));
        prev = cum;
      }
      out[recordKey(map, 'vq3', 8)] = entry;
    }

    if (Object.keys(out).length) {
      this.records = out;
      this.persist();
    }
    return out;
  }

  private persist(): void {
    try {
      this.store.setItem(V2_KEY, JSON.stringify(this.records));
    } catch {
      // Quota exceeded or storage revoked mid-session. The in-memory copy is
      // still correct for this session, which is the best that can be done.
    }
  }

  private ensure(key: string): MapRecord {
    let entry = this.records[key];
    if (!entry) {
      entry = emptyMapRecord();
      this.records[key] = entry;
    }
    return entry;
  }

  /** The full record for one map/mode, or null if it has never been played. */
  mapRecord(map: string, physics: PhysicsKey, msec: number): MapRecord | null {
    return this.records[recordKey(map, physics, msec)] ?? null;
  }

  best(map: string, physics: PhysicsKey, msec: number): number | null {
    return this.records[recordKey(map, physics, msec)]?.best?.time ?? null;
  }

  record(map: string, physics: PhysicsKey, msec: number): RunRecord | null {
    return this.records[recordKey(map, physics, msec)]?.best ?? null;
  }

  /** An attempt crossed the start line. Bumps `started` and stamps `firstSeen` once. */
  runStarted(map: string, physics: PhysicsKey, msec: number): void {
    const entry = this.ensure(recordKey(map, physics, msec));
    entry.counters.started++;
    if (!entry.firstSeen) {
      entry.firstSeen = new Date().toISOString();
    }
    this.persist();
  }

  /**
   * An attempt ended. Returns true if `outcome.kind === 'finished'` set a new
   * personal best -- the only case a caller needs a return value for.
   */
  runEnded(map: string, physics: PhysicsKey, msec: number, outcome: RunOutcome): boolean {
    const entry = this.ensure(recordKey(map, physics, msec));

    if (outcome.kind === 'died' || outcome.kind === 'restarted') {
      entry.counters[outcome.kind]++;
      if (Number.isFinite(outcome.timeOnMapMs) && outcome.timeOnMapMs > 0) {
        entry.timeOnMapMs += outcome.timeOnMapMs;
      }
      this.persist();
      return false;
    }

    // 'finished'
    if (!Number.isFinite(outcome.time) || outcome.time <= 0) {
      return false;
    }
    entry.counters.completed++;
    entry.timeOnMapMs += outcome.time;

    let prev = 0;
    outcome.splits.forEach((cum, i) => {
      const seg = Math.max(0, cum - prev);
      prev = cum;
      entry.sumOfBest[i] = entry.sumOfBest[i] === undefined ? seg : Math.min(entry.sumOfBest[i], seg);
    });

    entry.recentRuns.push({
      avgSpeed: outcome.avgSpeed,
      topSpeed: outcome.topSpeed,
      atMs: entry.timeOnMapMs,
      date: new Date().toISOString(),
    });
    if (entry.recentRuns.length > RECENT_RUNS_MAX) {
      entry.recentRuns.splice(0, entry.recentRuns.length - RECENT_RUNS_MAX);
    }

    const improved = entry.best === null || outcome.time < entry.best.time;
    if (improved) {
      entry.best = {
        time: outcome.time,
        splits: [...outcome.splits],
        date: new Date().toISOString(),
        ...(outcome.speedSeries ? { speedSeries: [...outcome.speedSeries] } : {}),
      };
    }

    this.persist();
    return improved;
  }
}
