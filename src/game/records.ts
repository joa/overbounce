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
 * v1 keyed records on the map name alone. v2 keys on `(map, physics, msec,
 * camera)` -- `.agent/plans/UI.md`'s R6: changing physics or tick rate clears
 * nothing, because records are kept per mode, and CPM is ranked separately
 * from VQ3 since it is reconstructed rather than verified. `msec`
 * (milliseconds per physics tick, `PMOVE_MSEC`) is in the key even though
 * nothing varies it yet -- Settings (R7, Phase 6) exposes pmove tick rate,
 * and 125 jumps higher than 60 or 1000, so a future tick-rate change must not
 * silently merge times that are not comparable. v1 had no physics concept,
 * so it migrates as `vq3` at 8ms/125Hz -- the only defensible guess, since
 * VQ3 carries the fidelity guarantee and 125 was the only tick rate that ever
 * ran.
 *
 * `camera` joined the key later, for the same reason `physics` is in it:
 * `chase`/`side`/`fpv` are not equally hard runs of the same map. `side`
 * gives up the aim laser's information (you cannot see where the shot will
 * land, only the map's own scripted framing); `fpv` gives up seeing your own
 * body relative to the geometry you are judging a jump against. A PR set in
 * one view is not a fair comparison for another, so `GhostStore` (which this
 * key format is shared with -- see that file) and `RecordBook` both split on
 * it now.
 *
 * A record set before `camera` existed in the key lived under
 * `(map, physics, msec)` -- three segments, no camera. Unlike the v1->v2
 * physics migration, there is no single defensible guess for what camera an
 * ARBITRARY old entry was actually played under: `chase` is the auto default
 * for a map with no `.cam` script, but `side` is the auto default for one
 * that has one, and a bare map name in an old key carries no way to tell
 * which -- so restricting the fallback to `chase` requests, the first version
 * of this migration's approach, is not the fix it looks like: `ob_basics`/
 * `ob_rockets` ship their own `.cam` script and have ALWAYS auto-resolved to
 * `side`, so every pre-camera-key record on either of the two bundled
 * tutorial courses -- the first thing a new player runs -- would silently
 * stop surfacing. Adopted for whichever camera actually asks first instead: a
 * player who genuinely changed their camera preference for the same map
 * between sessions could get an old record credited to the wrong view once, a
 * real but narrow cost next to a PR silently disappearing for the maps most
 * players see first.
 *
 * Migration reads the v1 key once, on first v2 construction, and leaves it in
 * place rather than deleting it -- a one-way migration with no rollback path
 * is a worse failure mode than a few stray kilobytes of localStorage. The
 * pre-camera v2 entries get the same treatment: adopted into the new key on
 * whichever request finds them first, left in place otherwise.
 */

const V1_KEY = 'overbounce.records.v1';
const V2_KEY = 'overbounce.records.v2';
/**
 * v2's `splits`/`sumOfBest` stop at the last checkpoint -- `target_stopTimer`
 * did not push the finish itself as a split until this fix (`course.ts`).
 * Reading that data straight into the current, finish-inclusive scheme makes
 * `outcome.splits.length` one longer than anything already on disk the very
 * first time anyone finishes a run post-fix, which `runEnded`'s checkpoint-
 * count-changed safety net cannot tell apart from a real map edit -- it
 * would silently wipe every existing PB. v3 exists so that migration runs
 * exactly once, the same way v1 -> v2 already does. See `migrateToV3`.
 */
const V3_KEY = 'overbounce.records.v3';

export type PhysicsKey = 'vq3' | 'cpm';

/**
 * The three views `main.ts`'s own `cameraMode` resolves to before a course
 * ever starts -- `'auto'` is a course-select/preference concept only and
 * never reaches here. See the file header for why this is in the record key.
 */
export type CameraKey = 'chase' | 'side' | 'fpv';

/** The default camera, and the only one a pre-camera-key record could have
 *  been set under -- see the file header's migration note. */
const DEFAULT_CAMERA: CameraKey = 'chase';

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
 * `(map, physics, msec)` as one string. Exported so `ghost.ts`'s `GhostStore`
 * can key itself the same way -- see that file's own header for why a ghost
 * has to agree with this file about what makes two runs comparable.
 */
export function recordKey(map: string, physics: PhysicsKey, msec: number, camera: CameraKey): string {
  return `${map}|${physics}|${msec}|${camera}`;
}

/**
 * The three-part key `recordKey` used before `camera` joined it. Exported
 * only for the one-time pre-camera-key migration fallback both this file and
 * `ghost.ts` need -- see this file's header.
 */
export function legacyRecordKey(map: string, physics: PhysicsKey, msec: number): string {
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

/**
 * Upgrades one v2-shaped `MapRecord` in place: appends the finish leg to
 * `best.splits`/`sumOfBest` that `target_stopTimer` did not used to
 * contribute. Only called from `migrateToV3`, on data already known to
 * predate the fix -- see `V3_KEY`'s comment for why this cannot be inferred
 * generically from shape alone at arbitrary read time.
 *
 * A no-op when the last recorded split already reaches (or somehow exceeds)
 * the total time: nothing missing to add, and re-appending a duplicate
 * would otherwise happen for a v1-migrated entry whose one and only
 * checkpoint happened to sit at the finish line.
 */
function appendImpliedFinishSplit(entry: MapRecord): void {
  if (!entry.best) {
    return;
  }
  const oldSplits = entry.best.splits;
  const lastCheckpoint = oldSplits.length ? oldSplits[oldSplits.length - 1] : 0;
  if (lastCheckpoint >= entry.best.time) {
    return;
  }
  const finalLeg = entry.best.time - lastCheckpoint;
  if (entry.sumOfBest.length === oldSplits.length) {
    entry.sumOfBest = [...entry.sumOfBest, finalLeg];
  }
  entry.best = { ...entry.best, splits: [...oldSplits, entry.best.time] };
}

/** Parses one `{ key: MapRecord }` JSON blob (v2 or v3 -- same on-disk shape), dropping anything malformed. */
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

export class RecordBook {
  private records: Record<string, MapRecord> = {};

  constructor(private readonly store: RecordStore = defaultStore()) {
    this.records = this.read();
  }

  private read(): Record<string, MapRecord> {
    const raw = this.store.getItem(V3_KEY);
    if (raw) {
      return parseRecordsBlob(raw);
    }
    return this.migrateToV3();
  }

  /**
   * One-time: v2 (or, transitively, v1) folded into v3's finish-inclusive
   * splits. See `V3_KEY` and `appendImpliedFinishSplit`.
   */
  private migrateToV3(): Record<string, MapRecord> {
    const rawV2 = this.store.getItem(V2_KEY);
    const out = rawV2 ? parseRecordsBlob(rawV2) : this.migrateFromV1();
    for (const entry of Object.values(out)) {
      appendImpliedFinishSplit(entry);
    }
    if (Object.keys(out).length) {
      this.records = out;
      this.persist();
    }
    return out;
  }

  /** Folds v1's `{ map: { time, splits, date } }` into v2/v3's per-key `MapRecord` shape, as `vq3` at 8ms. Pure -- the finish-split upgrade and the actual persist both happen in `migrateToV3`, uniformly for either source. */
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
      out[recordKey(map, 'vq3', 8, DEFAULT_CAMERA)] = entry;
    }
    return out;
  }

  private persist(): void {
    try {
      this.store.setItem(V3_KEY, JSON.stringify(this.records));
    } catch {
      // Quota exceeded or storage revoked mid-session. The in-memory copy is
      // still correct for this session, which is the best that can be done.
    }
  }

  /**
   * Get-or-create for a write path (`runStarted`/`runEnded`). Adopts a
   * pre-camera-key entry into the new key on WHATEVER camera asks first --
   * see the file header for why restricting this to one camera is not the
   * fix it looks like -- so a returning player's counters and history keep
   * accumulating on the SAME entry rather than starting a phantom-fresh one
   * beside an orphaned old one.
   */
  private ensure(map: string, physics: PhysicsKey, msec: number, camera: CameraKey): MapRecord {
    const key = recordKey(map, physics, msec, camera);
    let entry = this.records[key];
    if (entry) {
      return entry;
    }
    const legacy = this.records[legacyRecordKey(map, physics, msec)];
    if (legacy) {
      this.records[key] = legacy;
      return legacy;
    }
    entry = emptyMapRecord();
    this.records[key] = entry;
    return entry;
  }

  /**
   * The full record for one map/mode/camera, or null if it has never been
   * played. Falls back to a pre-camera-key entry if the camera-keyed one has
   * nothing -- see the file header -- but does not adopt it into the new key
   * itself: that only happens on an actual write (`ensure`), so merely
   * opening course-select never mutates storage.
   */
  mapRecord(map: string, physics: PhysicsKey, msec: number, camera: CameraKey = DEFAULT_CAMERA): MapRecord | null {
    const found = this.records[recordKey(map, physics, msec, camera)];
    if (found) {
      return found;
    }
    return this.records[legacyRecordKey(map, physics, msec)] ?? null;
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
   * `(map, physics, msec, camera)` entry (best time, sum-of-best, counters,
   * recent runs), not every mode this map has ever been run under. A player
   * resetting a VQ3 PR to try for a cleaner one is not asking to lose their
   * CPM history on the same map too.
   */
  deleteEntry(map: string, physics: PhysicsKey, msec: number, camera: CameraKey = DEFAULT_CAMERA): void {
    delete this.records[recordKey(map, physics, msec, camera)];
    delete this.records[legacyRecordKey(map, physics, msec)];
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
   * exists to avoid. `expectedSplits` trails `camera` for the same reason --
   * see its own doc below.
   *
   * @param expectedSplits The course's OWN current checkpoint-plus-finish
   *   count (`target_checkpoint` entities + 1), when the caller has it --
   *   `main.ts` does, callers built for tests generally don't and are not
   *   expected to fabricate one. Used only to detect a genuine map edit (see
   *   below); every other decision here is made from the run's own shape
   *   against the stored history's shape, not against this.
   */
  runEnded(
    map: string,
    physics: PhysicsKey,
    msec: number,
    outcome: RunOutcome,
    camera: CameraKey = DEFAULT_CAMERA,
    expectedSplits?: number,
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

    // A genuine map edit (ob_rockets grew from 2 checkpoints to 5 in this
    // repo's own history) is the ONE case stored sum-of-best actually needs
    // throwing away -- positions from before the edit are not comparable to
    // positions after it, ever, no matter how many runs accumulate. Detected
    // authoritatively from the course's OWN current checkpoint count, not
    // inferred from any single run's shape: inferring it from a run used to
    // be the bug here (see below), because a run's shape varying from the
    // stored history is FAR more often just this one attempt taking a
    // different route -- `target_checkpoint` triggers are waypoints, not
    // gates, and skipping one via a trick (an overbounce past it, a
    // shortcut) is a normal, celebrated way to play a movement-speedrunning
    // game, not an error, and neither is re-touching one on a route that
    // doubles back. `expectedSplits` is only ever omitted by tests that
    // don't care about this distinction; every real call from `main.ts`
    // supplies it.
    if (
      expectedSplits !== undefined &&
      entry.sumOfBest.length > 0 &&
      entry.sumOfBest.length !== expectedSplits
    ) {
      entry.sumOfBest = [];
    }

    // THE BUG THIS REPLACES: resetting `sumOfBest` to `[]` here whenever
    // *this run's* `outcome.splits.length` merely differed from whatever was
    // already stored -- which fires on ordinary route variance, not just map
    // edits, and wipes real multi-run segment history every time it does.
    // Worse, since the reset ran unconditionally before the merge below, the
    // very same deviant run then reseeded `sumOfBest` FROM ITSELF -- so the
    // displayed sum-of-best became that one run's own total, even on a run
    // that was slower than the PB in three of its four segments. Reported
    // directly: "how can the sum of best be the current run's time when it
    // is not the pb?".
    //
    // The fix: only ever MERGE a run into `sumOfBest` when its shape matches
    // what's already stored (or seed directly when there is nothing stored
    // yet). A run whose shape does not match is left out of sum-of-best
    // entirely -- it still counts fully for `counters`/`best`/`recentRuns`
    // above and below, only the position-by-position bookkeeping skips it,
    // because there is nothing honest to do with a segment that does not
    // line up with the rest of the history.
    if (entry.sumOfBest.length === 0) {
      let prev = 0;
      for (const cum of outcome.splits) {
        entry.sumOfBest.push(Math.max(0, cum - prev));
        prev = cum;
      }
    } else if (entry.sumOfBest.length === outcome.splits.length) {
      let prev = 0;
      outcome.splits.forEach((cum, i) => {
        const seg = Math.max(0, cum - prev);
        prev = cum;
        entry.sumOfBest[i] = Math.min(entry.sumOfBest[i], seg);
      });
    }

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
