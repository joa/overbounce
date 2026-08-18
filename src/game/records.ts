/**
 * Personal best times, kept in the browser.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * There is no server and no leaderboard: a run is between the player and the
 * map. localStorage is the whole store, and every read is defensive because it
 * is shared with every other page on the origin and can contain anything.
 */

const KEY = 'overbounce.records.v1';

export interface RunRecord {
  /** Best total time in milliseconds. */
  time: number;
  /** Splits from the run that set it. */
  splits: number[];
  /** ISO date the record was set. */
  date: string;
}

export type Records = Record<string, RunRecord>;

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

export class RecordBook {
  private records: Records = {};

  constructor(private readonly store: RecordStore = defaultStore()) {
    this.records = this.read();
  }

  private read(): Records {
    const raw = this.store.getItem(KEY);
    if (!raw) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }

      // Validate every entry rather than trusting the shape. Anything that
      // does not look like a record is dropped, not repaired.
      const out: Records = {};
      for (const [map, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') {
          continue;
        }
        const entry = value as { time?: unknown; splits?: unknown; date?: unknown };
        if (typeof entry.time !== 'number' || !Number.isFinite(entry.time) || entry.time <= 0) {
          continue;
        }
        out[map] = {
          time: entry.time,
          splits: Array.isArray(entry.splits)
            ? entry.splits.filter((s): s is number => typeof s === 'number')
            : [],
          date: typeof entry.date === 'string' ? entry.date : '',
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  best(map: string): number | null {
    return this.records[map]?.time ?? null;
  }

  record(map: string): RunRecord | null {
    return this.records[map] ?? null;
  }

  /**
   * Record a finished run. Returns true if it beat the previous best.
   *
   * A slower run is not stored at all — the book holds bests, not history.
   */
  submit(map: string, time: number, splits: readonly number[] = []): boolean {
    if (!Number.isFinite(time) || time <= 0) {
      return false;
    }
    const previous = this.best(map);
    if (previous !== null && time >= previous) {
      return false;
    }

    this.records[map] = {
      time,
      splits: [...splits],
      date: new Date().toISOString(),
    };

    try {
      this.store.setItem(KEY, JSON.stringify(this.records));
    } catch {
      // Quota exceeded or storage revoked mid-session. The in-memory copy is
      // still correct for this session, which is the best that can be done.
    }
    return true;
  }
}
