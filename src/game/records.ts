/**
 * Personal best times, and the run-history data under Results (R6).
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * There is no server and no leaderboard: a run is between the player and the
 * map. localStorage is the whole store, and every read is defensive because it
 * is shared with every other page on the origin and can contain anything --
 * a malformed field is dropped, never trusted and never fatal.
 *
 * Records are keyed on `(map, physics, msec, camera)`, per
 * `.agent/plans/UI.md`'s R6: changing any of the four clears nothing, because
 * records are kept per mode rather than merged across modes that are not
 * comparable runs of the same map.
 *
 * - `physics`: CPM is ranked separately from VQ3, since it is reconstructed
 *   from community documentation rather than verified against id's source,
 *   and it moves differently.
 * - `msec`: milliseconds per physics tick (`PMOVE_MSEC`). In the key even
 *   though nothing varies it yet -- Settings (R7, Phase 6) exposes pmove tick
 *   rate, and 125Hz jumps higher than 60 or 1000, so a future tick-rate
 *   change must not silently merge times that are not comparable.
 * - `camera`: `chase`/`side`/`fpv` are not equally hard runs of the same map.
 *   `side` gives up the aim laser's information (you cannot see where the
 *   shot will land, only the map's own scripted framing); `fpv` gives up
 *   seeing your own body relative to the geometry you are judging a jump
 *   against. A PR set in one view is not a fair comparison for another, so
 *   `GhostStore` (which shares this key format -- see that file) and
 *   `RecordBook` both split on it.
 *
 * Every split carries a checkpoint IDENTITY (`Split.cp`, the
 * `target_checkpoint`'s `targetname`), and best segment durations live in a
 * graph between those identities (`MapRecord.segmentBests`) rather than in a
 * positional array. `target_checkpoint` triggers are waypoints, not gates: an
 * experienced runner skips one with an overbounce or a shortcut, and a route
 * that doubles back re-touches one. Positional splits cannot say which
 * checkpoint a split belongs to, so nothing built on them -- per-split Δ
 * against the PB, or a sum of best segments -- could be compared across two
 * runs of different routes. Identities fix both: a Δ is taken against the
 * PB's split at the SAME checkpoint, and sum-of-best is the shortest path
 * through best segments, which is how skipped splits are handled in the
 * speedrunning community's own tooling (LiveSplit). See
 * `.agent/docs/sum-of-best.md`.
 *
 * There is exactly one storage key and no migration chain. Several earlier
 * shapes existed during development, none of them in a release, and the
 * records under them are not worth the code it takes to carry them forward:
 * a stale blob under an old key is simply ignored.
 */

const KEY = 'overbounce.records.v1';

export type PhysicsKey = 'vq3' | 'cpm';

/**
 * The three views `main.ts`'s own `cameraMode` resolves to before a course
 * ever starts -- `'auto'` is a course-select/preference concept only and
 * never reaches here. See the file header for why this is in the record key.
 */
export type CameraKey = 'chase' | 'side' | 'fpv';

/**
 * The camera every `RecordBook` method defaults to, so a caller that has no
 * camera in hand (tests, tooling) still lands on one real key rather than a
 * synthetic one. `chase` is the same fallback `main.ts` resolves to for a map
 * with no `.cam` script.
 */
const DEFAULT_CAMERA: CameraKey = 'chase';

/**
 * One checkpoint crossed during a run. `Course` records the first touch of
 * each checkpoint only, so a run's splits never repeat a `cp`.
 */
export interface Split {
  /**
   * The checkpoint's identity: its `target_checkpoint` entity's `targetname`.
   * Stable across runs and routes, which is what lets two runs that touched
   * different checkpoints still be compared at the ones they share.
   */
  cp: string;
  /** Milliseconds since the start gate. */
  at: number;
}

/**
 * The two ends of every run, as segment-graph nodes. A checkpoint is
 * identified by its `targetname`; these two are reserved on the assumption
 * that no map author names a checkpoint `<start>` or `<finish>`.
 */
export const START_NODE = '<start>';
export const FINISH_NODE = '<finish>';

/**
 * Best observed duration from one node to the next node touched, for every
 * pair of consecutively-touched nodes across every completed run:
 * `segmentBests[from][to]` in milliseconds. A run that skipped `cp2`
 * contributes a `cp1 -> cp3` edge; one that took it contributes `cp1 -> cp2`
 * and `cp2 -> cp3`. Sum-of-best is the shortest `<start>` -> `<finish>`
 * path through this graph (`sumOfBest`).
 */
export type SegmentBests = Record<string, Record<string, number>>;

export interface RunRecord {
  /** Best total time in milliseconds. */
  time: number;
  /** The checkpoints the run touched, in order. The finish is `time`. */
  splits: Split[];
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
   * See `SegmentBests`. Every completed run's segments go in, whatever route
   * it took -- there is no shape to match, because a segment is identified
   * by the two checkpoints it runs between, not by its position in a list.
   *
   * Invariant: the PB run's own segments are always present, at durations no
   * greater than the PB run's. So a `<start>` -> `<finish>` path of total
   * <= `best.time` always exists, and `sumOfBest` never exceeds the PB.
   * `runEnded` maintains it by merging every finished run, PB included;
   * `reconcileSegmentBests` restores it on read.
   */
  segmentBests: SegmentBests;
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
      splits: readonly Split[];
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
  /**
   * Optional because most `RecordStore` callers only ever grow their data --
   * `removeItem` exists for the one place something actually needs to be
   * forgotten (course select's "Reset PR", `GhostStore.delete`). `localStorage`
   * satisfies this for free (structural typing); a caller without a real
   * store, or a hand-built test store that never needed deletion, can leave
   * it out.
   */
  removeItem?(key: string): void;
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
      removeItem: (k) => {
        memory.delete(k);
      },
    };
  }
}

/**
 * `(map, physics, msec, camera)` as one string. Exported so `ghost.ts`'s
 * `GhostStore` can key itself the same way -- see that file's own header for
 * why a ghost has to agree with this file about what makes two runs
 * comparable.
 */
export function recordKey(map: string, physics: PhysicsKey, msec: number, camera: CameraKey): string {
  return `${map}|${physics}|${msec}|${camera}`;
}

function emptyCounters(): RecordCounters {
  return { started: 0, completed: 0, died: 0, restarted: 0 };
}

function emptyMapRecord(): MapRecord {
  return {
    best: null,
    segmentBests: {},
    counters: emptyCounters(),
    timeOnMapMs: 0,
    firstSeen: '',
    recentRuns: [],
  };
}

// ---------------------------------------------------------------------------
// The segment graph
// ---------------------------------------------------------------------------

export interface Segment {
  from: string;
  to: string;
  /** Duration in milliseconds, never negative. */
  ms: number;
}

/**
 * A run's segments: `<start>` to its first checkpoint, checkpoint to
 * checkpoint, last checkpoint to `<finish>`. A run with no checkpoints is one
 * `<start>` -> `<finish>` segment.
 *
 * A repeated `cp` (which `Course` never produces, but stored data is not
 * trusted) counts at its first touch only, so a route that doubled back
 * through `cp1` between `cp2` and `cp3` yields a `cp2 -> cp3` segment that
 * includes the detour -- which is the truth of that run.
 */
export function runSegments(splits: readonly Split[], time: number): Segment[] {
  const out: Segment[] = [];
  const seen = new Set<string>();
  let from = START_NODE;
  let prev = 0;
  for (const { cp, at } of splits) {
    if (seen.has(cp)) {
      continue;
    }
    seen.add(cp);
    out.push({ from, to: cp, ms: Math.max(0, at - prev) });
    from = cp;
    prev = at;
  }
  out.push({ from, to: FINISH_NODE, ms: Math.max(0, time - prev) });
  return out;
}

/** `segmentBests[from][to] = min(existing, ms)` for each segment. */
function mergeSegments(bests: SegmentBests, segments: readonly Segment[]): void {
  for (const { from, to, ms } of segments) {
    const row = (bests[from] ??= {});
    const existing = row[to];
    if (existing === undefined || ms < existing) {
      row[to] = ms;
    }
  }
}

/** A copy safe to keep across a `runEnded`, which mutates the live graph in place. */
export function cloneSegmentBests(bests: SegmentBests): SegmentBests {
  const out: SegmentBests = {};
  for (const [from, row] of Object.entries(bests)) {
    out[from] = { ...row };
  }
  return out;
}

/**
 * The sum of best segments: the shortest `<start>` -> `<finish>` path through
 * `segmentBests`, in milliseconds, or null if no completed run has been
 * recorded (no path). Dijkstra, O(n^2) over a graph of a dozen nodes at most.
 * Weights are non-negative and cycles (a route run backwards through two
 * checkpoints) are legal and harmless.
 *
 * Combining a `cp1 -> cp3` segment from one run with a `cp3 -> <finish>` from
 * another is exactly what the number means: the best time the player has
 * already proven possible, segment by segment, along routes actually run.
 */
export function sumOfBest(entry: Pick<MapRecord, 'segmentBests'>): number | null {
  const bests = entry.segmentBests;
  const dist = new Map<string, number>();
  const done = new Set<string>();
  dist.set(START_NODE, 0);
  for (;;) {
    let node: string | null = null;
    let best = Infinity;
    for (const [n, d] of dist) {
      if (!done.has(n) && d < best) {
        node = n;
        best = d;
      }
    }
    if (node === null) {
      return null;
    }
    if (node === FINISH_NODE) {
      return best;
    }
    done.add(node);
    const row = bests[node];
    if (!row) {
      continue;
    }
    for (const [to, ms] of Object.entries(row)) {
      const d = best + ms;
      const known = dist.get(to);
      if (known === undefined || d < known) {
        dist.set(to, d);
      }
    }
  }
}

/**
 * Re-establishes `MapRecord.segmentBests`'s invariant against the PB. Applied
 * to every entry as it is read, so a display path (course select reads
 * without ever writing) sees consistent data, and so an entry written by an
 * earlier version -- or by anything else on the origin -- cannot put
 * sum-of-best above the PB.
 *
 * Idempotent, and never persisted on its own: the repaired values are
 * re-derived identically on every read, and land on disk with the next
 * genuine write.
 */
function reconcileSegmentBests(entry: MapRecord): void {
  if (!entry.best) {
    // No completed run, nothing a segment could have come from.
    entry.segmentBests = {};
    return;
  }
  mergeSegments(entry.segmentBests, runSegments(entry.best.splits, entry.best.time));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function readSpeedSeries(value: unknown): number[] | undefined {
  return Array.isArray(value)
    ? value.filter((s): s is number => typeof s === 'number' && Number.isFinite(s))
    : undefined;
}

function readSplits(value: unknown): Split[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Split[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const s = item as { cp?: unknown; at?: unknown };
    if (typeof s.cp !== 'string' || typeof s.at !== 'number' || !Number.isFinite(s.at)) {
      continue;
    }
    out.push({ cp: s.cp, at: s.at });
  }
  return out;
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
  const speedSeries = readSpeedSeries(entry.speedSeries);
  return {
    time: entry.time,
    splits: readSplits(entry.splits),
    date: typeof entry.date === 'string' ? entry.date : '',
    ...(speedSeries ? { speedSeries } : {}),
  };
}

function readSegmentBests(value: unknown): SegmentBests {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: SegmentBests = {};
  for (const [from, row] of Object.entries(value as Record<string, unknown>)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    for (const [to, ms] of Object.entries(row as Record<string, unknown>)) {
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
        (out[from] ??= {})[to] = ms;
      }
    }
  }
  return out;
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

function readNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Validates one v4 `MapRecord`, dropping the fields that do not look right rather than the whole entry. */
function readMapRecord(value: unknown): MapRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const m = value as Record<string, unknown>;
  const entry: MapRecord = {
    best: readRunRecord(m.best),
    segmentBests: readSegmentBests(m.segmentBests),
    counters: readCounters(m.counters),
    timeOnMapMs: readNonNegative(m.timeOnMapMs),
    firstSeen: typeof m.firstSeen === 'string' ? m.firstSeen : '',
    recentRuns: readRecentRuns(m.recentRuns),
  };
  reconcileSegmentBests(entry);
  return entry;
}

/** Parses one v4 `{ key: MapRecord }` JSON blob, dropping anything malformed. */
function parseRecordsBlob(raw: string): Record<string, MapRecord> {
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

// ---------------------------------------------------------------------------

export class RecordBook {
  private records: Record<string, MapRecord> = {};

  constructor(private readonly store: RecordStore = defaultStore()) {
    this.records = this.read();
  }

  private read(): Record<string, MapRecord> {
    const raw = this.store.getItem(KEY);
    return raw ? parseRecordsBlob(raw) : {};
  }

  private persist(): void {
    try {
      this.store.setItem(KEY, JSON.stringify(this.records));
    } catch {
      // Quota exceeded or storage revoked mid-session. The in-memory copy is
      // still correct for this session, which is the best that can be done.
    }
  }

  /** Get-or-create for a write path (`runStarted`/`runEnded`). */
  private ensure(map: string, physics: PhysicsKey, msec: number, camera: CameraKey): MapRecord {
    const key = recordKey(map, physics, msec, camera);
    const entry = this.records[key] ?? emptyMapRecord();
    this.records[key] = entry;
    return entry;
  }

  /**
   * The full record for one map/mode/camera, or null if that combination has
   * never been played. A read never creates an entry, so merely opening
   * course-select does not mutate storage.
   */
  mapRecord(map: string, physics: PhysicsKey, msec: number, camera: CameraKey = DEFAULT_CAMERA): MapRecord | null {
    return this.records[recordKey(map, physics, msec, camera)] ?? null;
  }

  best(map: string, physics: PhysicsKey, msec: number, camera: CameraKey = DEFAULT_CAMERA): number | null {
    return this.mapRecord(map, physics, msec, camera)?.best?.time ?? null;
  }

  record(map: string, physics: PhysicsKey, msec: number, camera: CameraKey = DEFAULT_CAMERA): RunRecord | null {
    return this.mapRecord(map, physics, msec, camera)?.best ?? null;
  }

  /**
   * Career-wide totals for the title screen's LIFETIME panel, summed across
   * every `(map, physics, msec, camera)` entry this book holds -- a player's
   * lifetime is not scoped to one mode. `mapsStarted`/`mapsCompleted` count
   * DISTINCT map names (the key's first `|`-separated segment), since the
   * same map under two physics modes is one map played, not two.
   */
  lifetimeStats(): {
    attempts: number;
    playtimeMs: number;
    deaths: number;
    maxSpeed: number;
    mapsStarted: number;
    mapsCompleted: number;
  } {
    let attempts = 0;
    let playtimeMs = 0;
    let deaths = 0;
    let maxSpeed = 0;
    const started = new Set<string>();
    const completed = new Set<string>();

    for (const [key, entry] of Object.entries(this.records)) {
      attempts += entry.counters.started;
      playtimeMs += entry.timeOnMapMs;
      deaths += entry.counters.died;
      for (const run of entry.recentRuns) {
        if (run.topSpeed > maxSpeed) {
          maxSpeed = run.topSpeed;
        }
      }
      const map = key.split('|')[0];
      if (entry.counters.started > 0) {
        started.add(map);
      }
      if (entry.counters.completed > 0) {
        completed.add(map);
      }
    }

    return {
      attempts,
      playtimeMs,
      deaths,
      maxSpeed,
      mapsStarted: started.size,
      mapsCompleted: completed.size,
    };
  }

  /**
   * Course select's "Reset PR" -- forgets everything for exactly this
   * `(map, physics, msec, camera)` entry (best time, segment graph, counters,
   * recent runs), not every mode this map has ever been run under. A player
   * resetting a VQ3 PR to try for a cleaner one is not asking to lose their
   * CPM history on the same map too.
   */
  deleteEntry(map: string, physics: PhysicsKey, msec: number, camera: CameraKey = DEFAULT_CAMERA): void {
    delete this.records[recordKey(map, physics, msec, camera)];
    this.persist();
  }

  /** An attempt crossed the start line. Bumps `started` and stamps `firstSeen` once. */
  runStarted(map: string, physics: PhysicsKey, msec: number, camera: CameraKey = DEFAULT_CAMERA): void {
    const entry = this.ensure(map, physics, msec, camera);
    entry.counters.started++;
    if (!entry.firstSeen) {
      entry.firstSeen = new Date().toISOString();
    }
    this.persist();
  }

  /**
   * An attempt ended. Returns true if `outcome.kind === 'finished'` set a new
   * personal best -- the only case a caller needs a return value for.
   *
   * `camera` trails `outcome` here, unlike every other method's parameter
   * order, so its default keeps working positionally: a default on any
   * parameter before the last one would force every existing call site to
   * pass something for it explicitly, which is exactly the churn the default
   * exists to avoid.
   */
  runEnded(
    map: string,
    physics: PhysicsKey,
    msec: number,
    outcome: RunOutcome,
    camera: CameraKey = DEFAULT_CAMERA,
  ): boolean {
    const entry = this.ensure(map, physics, msec, camera);

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

    entry.recentRuns.push({
      avgSpeed: outcome.avgSpeed,
      topSpeed: outcome.topSpeed,
      atMs: entry.timeOnMapMs,
      date: new Date().toISOString(),
    });
    if (entry.recentRuns.length > RECENT_RUNS_MAX) {
      entry.recentRuns.splice(0, entry.recentRuns.length - RECENT_RUNS_MAX);
    }

    // Every completed run's segments go into the graph, whatever route it
    // took. A run that skipped `cp2` contributes a `cp1 -> cp3` segment,
    // which is a different segment from `cp1 -> cp2`, not a mis-positioned
    // one -- there is nothing to line up and so nothing to exclude. This is
    // also what keeps sum-of-best at or under the PB: the PB run's own
    // segments are in here at durations no greater than its own.
    mergeSegments(entry.segmentBests, runSegments(outcome.splits, outcome.time));

    // The PB is decided on total time alone. Which checkpoints the run
    // touched on the way does not enter into it.
    const improved = entry.best === null || outcome.time < entry.best.time;
    if (improved) {
      entry.best = {
        time: outcome.time,
        splits: outcome.splits.map((s) => ({ cp: s.cp, at: s.at })),
        date: new Date().toISOString(),
        ...(outcome.speedSeries ? { speedSeries: [...outcome.speedSeries] } : {}),
      };
    }

    this.persist();
    return improved;
  }
}
