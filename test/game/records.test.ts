/**
 * Personal best times, and the run-history data under Results.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The interesting cases are all about hostile storage: localStorage is shared
 * with every other page on the origin, so a corrupt or half-written value must
 * lose the records rather than break the game. Also covered: keys stay apart
 * per (map, physics, msec), and a v1 record migrates into v2 as vq3@8ms.
 */

import { describe, it, expect } from 'vitest';
import { RecordBook, legacyRecordKey } from '../../src/game/records.js';
import type { RecordStore } from '../../src/game/records.js';

/** A hand-built v2 entry, for seeding storage directly under an old key. */
function rawMapRecord(time: number) {
  return {
    best: { time, splits: [], date: '2026-01-01T00:00:00.000Z' },
    sumOfBest: [],
    counters: { started: 1, completed: 1, died: 0, restarted: 0 },
    timeOnMapMs: time,
    firstSeen: '2026-01-01T00:00:00.000Z',
    recentRuns: [],
  };
}

function memoryStore(initial?: Record<string, string>): RecordStore & { raw(key: string): string | null } {
  const values = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
    raw: (k) => values.get(k) ?? null,
  };
}

const finished = (time: number, splits: number[] = []) =>
  ({ kind: 'finished', time, splits, avgSpeed: 0, topSpeed: 0 }) as const;

describe('RecordBook', () => {
  it('has no record for a map that has never been run', () => {
    expect(new RecordBook(memoryStore()).best('q3dm6', 'vq3', 8)).toBeNull();
  });

  it('records a first run', () => {
    const book = new RecordBook(memoryStore());
    expect(book.runEnded('q3dm6', 'vq3', 8, finished(12345))).toBe(true);
    expect(book.best('q3dm6', 'vq3', 8)).toBe(12345);
  });

  it('keeps only the faster of two runs', () => {
    const book = new RecordBook(memoryStore());
    book.runEnded('q3dm6', 'vq3', 8, finished(12000));

    expect(book.runEnded('q3dm6', 'vq3', 8, finished(15000))).toBe(false);
    expect(book.best('q3dm6', 'vq3', 8)).toBe(12000);

    expect(book.runEnded('q3dm6', 'vq3', 8, finished(9000))).toBe(true);
    expect(book.best('q3dm6', 'vq3', 8)).toBe(9000);
  });

  it('does not treat an equal time as an improvement', () => {
    const book = new RecordBook(memoryStore());
    book.runEnded('q3dm6', 'vq3', 8, finished(12000));
    expect(book.runEnded('q3dm6', 'vq3', 8, finished(12000))).toBe(false);
  });

  it('keeps maps apart', () => {
    const book = new RecordBook(memoryStore());
    book.runEnded('q3dm6', 'vq3', 8, finished(12000));
    book.runEnded('mega_rl', 'vq3', 8, finished(30000));
    expect(book.best('q3dm6', 'vq3', 8)).toBe(12000);
    expect(book.best('mega_rl', 'vq3', 8)).toBe(30000);
  });

  it('keeps physics modes apart on the same map', () => {
    const book = new RecordBook(memoryStore());
    book.runEnded('q3dm6', 'vq3', 8, finished(12000));
    book.runEnded('q3dm6', 'cpm', 8, finished(9000));
    expect(book.best('q3dm6', 'vq3', 8)).toBe(12000);
    expect(book.best('q3dm6', 'cpm', 8)).toBe(9000);
  });

  it('keeps tick rates apart on the same map and mode', () => {
    const book = new RecordBook(memoryStore());
    book.runEnded('q3dm6', 'vq3', 8, finished(12000));
    book.runEnded('q3dm6', 'vq3', 16, finished(20000));
    expect(book.best('q3dm6', 'vq3', 8)).toBe(12000);
    expect(book.best('q3dm6', 'vq3', 16)).toBe(20000);
  });

  it('keeps camera modes apart on the same map and physics', () => {
    // `chase`/`side`/`fpv` are not equally hard runs of the same map -- a
    // `side` PR was set without the aim laser's information, an `fpv` one
    // without seeing your own body against the geometry. See the file
    // header's camera note.
    const book = new RecordBook(memoryStore());
    book.runEnded('q3dm6', 'vq3', 8, finished(12000), 'chase');
    book.runEnded('q3dm6', 'vq3', 8, finished(9000), 'side');
    book.runEnded('q3dm6', 'vq3', 8, finished(15000), 'fpv');
    expect(book.best('q3dm6', 'vq3', 8, 'chase')).toBe(12000);
    expect(book.best('q3dm6', 'vq3', 8, 'side')).toBe(9000);
    expect(book.best('q3dm6', 'vq3', 8, 'fpv')).toBe(15000);
  });

  it('defaults to chase when no camera is given', () => {
    const book = new RecordBook(memoryStore());
    book.runEnded('q3dm6', 'vq3', 8, finished(12000));
    expect(book.best('q3dm6', 'vq3', 8, 'chase')).toBe(12000);
    expect(book.best('q3dm6', 'vq3', 8, 'side')).toBeNull();
  });

  it('stores the splits from the run that set the record', () => {
    const book = new RecordBook(memoryStore());
    book.runEnded('mega_rl', 'vq3', 8, finished(30000, [10000, 20000]));
    expect(book.record('mega_rl', 'vq3', 8)!.splits).toEqual([10000, 20000]);

    // A slower run must not overwrite them.
    book.runEnded('mega_rl', 'vq3', 8, finished(40000, [1, 2]));
    expect(book.record('mega_rl', 'vq3', 8)!.splits).toEqual([10000, 20000]);
  });

  it('persists through the store', () => {
    const store = memoryStore();
    new RecordBook(store).runEnded('q3dm6', 'vq3', 8, finished(12000));
    // A fresh book over the same storage sees it.
    expect(new RecordBook(store).best('q3dm6', 'vq3', 8)).toBe(12000);
  });

  it('rejects nonsense times rather than storing them', () => {
    const book = new RecordBook(memoryStore());
    expect(book.runEnded('q3dm6', 'vq3', 8, finished(0))).toBe(false);
    expect(book.runEnded('q3dm6', 'vq3', 8, finished(-5))).toBe(false);
    expect(book.runEnded('q3dm6', 'vq3', 8, finished(Number.NaN))).toBe(false);
    expect(book.runEnded('q3dm6', 'vq3', 8, finished(Number.POSITIVE_INFINITY))).toBe(false);
    expect(book.best('q3dm6', 'vq3', 8)).toBeNull();
  });

  it('survives storage that is not JSON at all', () => {
    const book = new RecordBook(memoryStore({ 'overbounce.records.v2': 'not json {{{' }));
    expect(book.best('q3dm6', 'vq3', 8)).toBeNull();
    // ...and is still usable afterwards.
    expect(book.runEnded('q3dm6', 'vq3', 8, finished(1000))).toBe(true);
  });

  it('survives JSON of the wrong shape', () => {
    for (const raw of ['null', '[]', '"a string"', '42']) {
      expect(new RecordBook(memoryStore({ 'overbounce.records.v2': raw })).best('q3dm6', 'vq3', 8)).toBeNull();
    }
  });

  it('drops individual entries that are malformed, keeping the good ones', () => {
    const store = memoryStore({
      'overbounce.records.v2': JSON.stringify({
        'good|vq3|8': { best: { time: 5000, splits: [1000], date: '2026-01-01' } },
        'noTime|vq3|8': { best: { splits: [] } },
        'stringTime|vq3|8': { best: { time: '5000' } },
        'negative|vq3|8': { best: { time: -1 } },
        'notAnObject|vq3|8': 7,
      }),
    });
    const book = new RecordBook(store);
    expect(book.best('good', 'vq3', 8)).toBe(5000);
    expect(book.best('noTime', 'vq3', 8)).toBeNull();
    expect(book.best('stringTime', 'vq3', 8)).toBeNull();
    expect(book.best('negative', 'vq3', 8)).toBeNull();
    expect(book.best('notAnObject', 'vq3', 8)).toBeNull();
  });

  it('keeps working when the store throws on write', () => {
    const store: RecordStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const book = new RecordBook(store);
    // The write fails but the in-memory answer is still right for this session.
    expect(book.runEnded('q3dm6', 'vq3', 8, finished(12000))).toBe(true);
    expect(book.best('q3dm6', 'vq3', 8)).toBe(12000);
  });

  describe('runStarted / runEnded counters', () => {
    it('counts started, completed, died and restarted separately', () => {
      const book = new RecordBook(memoryStore());
      book.runStarted('q3dm6', 'vq3', 8);
      book.runEnded('q3dm6', 'vq3', 8, { kind: 'died', timeOnMapMs: 2000 });

      book.runStarted('q3dm6', 'vq3', 8);
      book.runEnded('q3dm6', 'vq3', 8, { kind: 'restarted', timeOnMapMs: 1000 });

      book.runStarted('q3dm6', 'vq3', 8);
      book.runEnded('q3dm6', 'vq3', 8, finished(9000));

      const rec = book.mapRecord('q3dm6', 'vq3', 8)!;
      expect(rec.counters).toEqual({ started: 3, completed: 1, died: 1, restarted: 1 });
      expect(rec.timeOnMapMs).toBe(2000 + 1000 + 9000);
    });

    it('stamps firstSeen once, on the first runStarted', () => {
      const book = new RecordBook(memoryStore());
      book.runStarted('q3dm6', 'vq3', 8);
      const first = book.mapRecord('q3dm6', 'vq3', 8)!.firstSeen;
      expect(first).not.toBe('');

      book.runStarted('q3dm6', 'vq3', 8);
      expect(book.mapRecord('q3dm6', 'vq3', 8)!.firstSeen).toBe(first);
    });

    it('a died/restarted outcome never sets a PB', () => {
      const book = new RecordBook(memoryStore());
      expect(book.runEnded('q3dm6', 'vq3', 8, { kind: 'died', timeOnMapMs: 500 })).toBe(false);
      expect(book.best('q3dm6', 'vq3', 8)).toBeNull();
    });
  });

  describe('sum-of-best', () => {
    it('takes the best segment across runs, not the segments of the best run', () => {
      const book = new RecordBook(memoryStore());
      // Run A: slow first segment, fast second segment. Cumulative splits.
      book.runEnded('q3dm6', 'vq3', 8, finished(10000, [6000, 10000]));
      // Run B: fast first segment, slow second -- and a slower total, so it is
      // not the record, but its first segment beats run A's.
      book.runEnded('q3dm6', 'vq3', 8, finished(11000, [3000, 11000]));

      const rec = book.mapRecord('q3dm6', 'vq3', 8)!;
      // seg0: min(6000, 3000) = 3000. seg1: min(10000-6000, 11000-3000) = 4000.
      expect(rec.sumOfBest).toEqual([3000, 4000]);
      // The record itself is still run A's, unaffected by sum-of-best bookkeeping.
      expect(rec.best!.time).toBe(10000);
    });

    it('leaves sum-of-best untouched, and never resets the PB, when a run has a different route', () => {
      // A single run taking a different ROUTE through an UNCHANGED course --
      // skipping a checkpoint via a trick, or re-touching one on a route
      // that doubles back -- is not an error: `outcome.time` is still a
      // real, comparable completion time. Only sum-of-best, which needs
      // position-by-position history, stops being comparable FOR THAT RUN.
      const book = new RecordBook(memoryStore());
      book.runEnded('ob_rockets', 'vq3', 8, finished(20000, [5000, 20000]));
      expect(book.mapRecord('ob_rockets', 'vq3', 8)!.sumOfBest).toEqual([5000, 15000]);

      // A differently-shaped run that is SLOWER must never overwrite a real
      // PB just because `entry.best` got nulled out from under it (the
      // original reported bug: a 13.96s checkpoint-skip run's PB replaced by
      // the very next, fuller-route but 15.57s run) -- NOR corrupt the
      // standing sum-of-best by reseeding it from itself, which is what used
      // to make a run's OWN total display as "sum of best" even when three
      // of its four segments were slower than the PB (the bug this test now
      // guards): "how can the sum of best be the current run's time when it
      // is not the pb?".
      const improved = book.runEnded(
        'ob_rockets',
        'vq3',
        8,
        finished(26152, [5776, 12592, 20168, 22696, 25072]),
      );

      const rec = book.mapRecord('ob_rockets', 'vq3', 8)!;
      expect(improved).toBe(false);
      expect(rec.best!.time).toBe(20000);
      // Untouched -- this run's shape doesn't match, so it is excluded from
      // the merge entirely rather than replacing real history with itself.
      expect(rec.sumOfBest).toEqual([5000, 15000]);
      // The invariant the bug violated: once ANY segment has ever been
      // recorded, sum-of-best can only be less than or equal to the PB it
      // was drawn alongside -- it is a lower bound on achievable time, never
      // a number that can exceed a real completion.
      expect(rec.sumOfBest.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(rec.best!.time);
    });

    it('a differently-shaped run that IS faster still becomes the new PB, without touching sum-of-best', () => {
      const book = new RecordBook(memoryStore());
      book.runEnded('ob_rockets', 'vq3', 8, finished(20000, [5000, 20000]));

      const improved = book.runEnded('ob_rockets', 'vq3', 8, finished(9000, [4000, 9000, 9000]));

      const rec = book.mapRecord('ob_rockets', 'vq3', 8)!;
      expect(improved).toBe(true);
      expect(rec.best!.time).toBe(9000);
      // The new PB's own route doesn't match the stored 2-segment shape
      // either, so sum-of-best is left exactly as run A set it -- becoming
      // the PB is a completely separate decision from updating sum-of-best.
      expect(rec.sumOfBest).toEqual([5000, 15000]);
    });

    it('keeps merging normally when the checkpoint count is unchanged', () => {
      const book = new RecordBook(memoryStore());
      book.runEnded('q3dm6', 'vq3', 8, finished(10000, [6000, 10000]));
      book.runEnded('q3dm6', 'vq3', 8, finished(12000, [4000, 12000]));

      const rec = book.mapRecord('q3dm6', 'vq3', 8)!;
      expect(rec.sumOfBest).toEqual([4000, 4000]);
      // Still the faster of the two totals -- no spurious reset.
      expect(rec.best!.time).toBe(10000);
    });

    it('a run that matches the stored shape keeps merging even after unrelated deviant runs came between', () => {
      const book = new RecordBook(memoryStore());
      book.runEnded('q3dm6', 'vq3', 8, finished(10000, [6000, 10000]));
      // A deviant-shaped run in between must not disturb the 2-segment history.
      book.runEnded('q3dm6', 'vq3', 8, finished(9000, [3000, 6000, 9000]));
      // Back to the canonical shape: still merges against the ORIGINAL data,
      // not against nothing.
      book.runEnded('q3dm6', 'vq3', 8, finished(11000, [4000, 11000]));

      const rec = book.mapRecord('q3dm6', 'vq3', 8)!;
      // seg0: min(6000, 4000) = 4000. seg1: min(4000, 11000-4000=7000) = 4000.
      expect(rec.sumOfBest).toEqual([4000, 4000]);
    });

    it('resets sum-of-best only when the course itself reports a different checkpoint count', () => {
      const book = new RecordBook(memoryStore());
      book.runEnded('ob_rockets', 'vq3', 8, finished(20000, [5000, 20000]), 'chase', 2);
      expect(book.mapRecord('ob_rockets', 'vq3', 8)!.sumOfBest).toEqual([5000, 15000]);

      // The course now reports 5 splits -- a real map edit, not a fluke of
      // this one run -- so the stale 2-segment history is discarded and
      // reseeded from this run instead of being left stranded forever.
      book.runEnded(
        'ob_rockets',
        'vq3',
        8,
        finished(26152, [5776, 12592, 20168, 22696, 25072]),
        'chase',
        5,
      );
      expect(book.mapRecord('ob_rockets', 'vq3', 8)!.sumOfBest).toEqual([
        5776, 6816, 7576, 2528, 2376,
      ]);
    });
  });

  describe('deleteEntry', () => {
    it('forgets one (map, physics, msec, camera) entry without touching others', () => {
      const book = new RecordBook(memoryStore());
      book.runEnded('q3dm6', 'vq3', 8, finished(12000));
      book.runEnded('q3dm6', 'cpm', 8, finished(9000));

      book.deleteEntry('q3dm6', 'vq3', 8);

      expect(book.best('q3dm6', 'vq3', 8)).toBeNull();
      expect(book.best('q3dm6', 'cpm', 8)).toBe(9000);
    });

    it('is a no-op for an entry that was never there', () => {
      const book = new RecordBook(memoryStore());
      expect(() => book.deleteEntry('never-run', 'vq3', 8)).not.toThrow();
    });
  });

  describe('lifetimeStats', () => {
    it('is all zero for a book that has never run anything', () => {
      const stats = new RecordBook(memoryStore()).lifetimeStats();
      expect(stats).toEqual({
        attempts: 0,
        playtimeMs: 0,
        deaths: 0,
        maxSpeed: 0,
        mapsStarted: 0,
        mapsCompleted: 0,
      });
    });

    it('sums across every mode and camera, and counts maps by distinct name', () => {
      const book = new RecordBook(memoryStore());
      // Same map, two physics modes -- one map played, not two.
      book.runStarted('q3dm6', 'vq3', 8);
      book.runEnded('q3dm6', 'vq3', 8, {
        kind: 'finished',
        time: 10000,
        splits: [],
        avgSpeed: 300,
        topSpeed: 900,
      });
      book.runStarted('q3dm6', 'cpm', 8, 'side');
      book.runEnded('q3dm6', 'cpm', 8, { kind: 'died', timeOnMapMs: 4000 }, 'side');
      // A second map, started but never finished.
      book.runStarted('mega_rl', 'vq3', 8);
      book.runEnded('mega_rl', 'vq3', 8, { kind: 'died', timeOnMapMs: 2000 });
      // A third finished run with a higher top speed than the first.
      book.runStarted('mega_rl', 'vq3', 16);
      book.runEnded('mega_rl', 'vq3', 16, {
        kind: 'finished',
        time: 5000,
        splits: [],
        avgSpeed: 400,
        topSpeed: 1500,
      });

      const stats = book.lifetimeStats();
      expect(stats.attempts).toBe(4);
      expect(stats.playtimeMs).toBe(10000 + 4000 + 2000 + 5000);
      expect(stats.deaths).toBe(2);
      expect(stats.maxSpeed).toBe(1500);
      // q3dm6 (both modes) + mega_rl (both tick rates) = 2 distinct maps started.
      expect(stats.mapsStarted).toBe(2);
      // Only q3dm6@vq3 and mega_rl@vq3/16ms actually finished.
      expect(stats.mapsCompleted).toBe(2);
    });
  });

  describe('recent runs ring', () => {
    it('is bounded and keeps cumulative time-on-map per entry', () => {
      const book = new RecordBook(memoryStore());
      for (let i = 0; i < 55; i++) {
        book.runEnded('q3dm6', 'vq3', 8, { kind: 'finished', time: 1000, splits: [], avgSpeed: 300, topSpeed: 400 });
      }
      const rec = book.mapRecord('q3dm6', 'vq3', 8)!;
      expect(rec.recentRuns.length).toBe(50);
      // atMs is cumulative: the last entry reflects all 55 runs' time, even
      // though only the last 50 are kept.
      expect(rec.recentRuns.at(-1)!.atMs).toBe(55000);
    });
  });

  describe('migration from v1', () => {
    it('folds a v1 record into v2 as vq3 at 8ms', () => {
      const store = memoryStore({
        'overbounce.records.v1': JSON.stringify({
          q3dm6: { time: 12000, splits: [5000, 12000], date: '2026-01-01T00:00:00.000Z' },
        }),
      });
      const book = new RecordBook(store);
      expect(book.best('q3dm6', 'vq3', 8)).toBe(12000);
      expect(book.record('q3dm6', 'vq3', 8)!.splits).toEqual([5000, 12000]);
      // Never touched under a different mode or tick rate.
      expect(book.best('q3dm6', 'cpm', 8)).toBeNull();
    });

    it('seeds sum-of-best from the migrated run, converted to per-segment', () => {
      const store = memoryStore({
        'overbounce.records.v1': JSON.stringify({
          q3dm6: { time: 12000, splits: [5000, 12000], date: '2026-01-01T00:00:00.000Z' },
        }),
      });
      const book = new RecordBook(store);
      expect(book.mapRecord('q3dm6', 'vq3', 8)!.sumOfBest).toEqual([5000, 7000]);
    });

    it('does not migrate again once v2 exists', () => {
      const store = memoryStore({
        'overbounce.records.v1': JSON.stringify({
          q3dm6: { time: 12000, splits: [], date: '2026-01-01T00:00:00.000Z' },
        }),
      });
      new RecordBook(store); // triggers migration and writes v2
      // Mutate v1 after migration -- a second construction must not re-read it.
      store.setItem(
        'overbounce.records.v1',
        JSON.stringify({ q3dm6: { time: 1, splits: [], date: '2026-01-01T00:00:00.000Z' } }),
      );
      const second = new RecordBook(store);
      expect(second.best('q3dm6', 'vq3', 8)).toBe(12000);
    });

    it('leaves v1 in place rather than deleting it', () => {
      const store = memoryStore({
        'overbounce.records.v1': JSON.stringify({
          q3dm6: { time: 12000, splits: [], date: '2026-01-01T00:00:00.000Z' },
        }),
      });
      new RecordBook(store);
      expect(store.raw('overbounce.records.v1')).not.toBeNull();
    });

    it('is a no-op when there is no v1 data', () => {
      const book = new RecordBook(memoryStore());
      expect(book.best('q3dm6', 'vq3', 8)).toBeNull();
    });
  });

  describe('migration from a pre-camera-key entry', () => {
    it('adopts whichever camera request finds an entry saved under the (map, physics, msec) key', () => {
      // THE regression this guards: an earlier version only adopted this for
      // a `chase` request, reasoning `chase` was the safe historical default
      // -- which silently broke every PR on ob_basics/ob_rockets, since both
      // ship a `.cam` script and have ALWAYS auto-resolved to `side`, never
      // `chase`. See the file header.
      const store = memoryStore({
        'overbounce.records.v2': JSON.stringify({
          [legacyRecordKey('q3dm6', 'vq3', 8)]: rawMapRecord(12000),
        }),
      });
      const book = new RecordBook(store);
      expect(book.best('q3dm6', 'vq3', 8, 'side')).toBe(12000);
    });

    it('never hands the pre-camera entry back for a different physics mode', () => {
      const store = memoryStore({
        'overbounce.records.v2': JSON.stringify({
          [legacyRecordKey('q3dm6', 'vq3', 8)]: rawMapRecord(12000),
        }),
      });
      const book = new RecordBook(store);
      expect(book.best('q3dm6', 'cpm', 8, 'chase')).toBeNull();
    });

    it('adopts the pre-camera entry into the new key on an actual write, not just a read', () => {
      const store = memoryStore({
        'overbounce.records.v2': JSON.stringify({
          [legacyRecordKey('q3dm6', 'vq3', 8)]: rawMapRecord(12000),
        }),
      });
      const book = new RecordBook(store);
      // A worse run must not overwrite the adopted PB. Same split shape as
      // the migrated legacy record (one split -- see `appendImpliedFinishSplit`
      // for a zero-checkpoint `rawMapRecord`), so this exercises "worse run
      // loses" rather than the unrelated checkpoint-count-changed reset.
      expect(book.runEnded('q3dm6', 'vq3', 8, finished(15000, [15000]), 'chase')).toBe(false);
      expect(book.best('q3dm6', 'vq3', 8, 'chase')).toBe(12000);
      // Counters carried forward onto the SAME entry rather than starting a
      // phantom-fresh one beside the orphaned pre-camera one.
      expect(book.mapRecord('q3dm6', 'vq3', 8, 'chase')!.counters.completed).toBe(2);
    });

    it('adopts on a side write too -- the actual ob_basics/ob_rockets case', () => {
      const store = memoryStore({
        'overbounce.records.v2': JSON.stringify({
          [legacyRecordKey('q3dm6', 'vq3', 8)]: rawMapRecord(12000),
        }),
      });
      const book = new RecordBook(store);
      expect(book.runEnded('q3dm6', 'vq3', 8, finished(15000, [15000]), 'side')).toBe(false);
      expect(book.best('q3dm6', 'vq3', 8, 'side')).toBe(12000);
      expect(book.mapRecord('q3dm6', 'vq3', 8, 'side')!.counters.completed).toBe(2);
    });
  });

  describe('migration from v2 to v3 (finish-inclusive splits)', () => {
    // THE reported bug: `target_stopTimer` did not used to push a split of
    // its own, so every v2 record's `splits`/`sumOfBest` stopped at the last
    // checkpoint -- one entry shorter than a post-fix run's `outcome.splits`,
    // which now always ends with the finish. Read straight through, that
    // mismatch tripped the checkpoint-count-changed reset, wiping the PB and
    // making even a SLOWER run look like a new best (`entry.best === null`
    // makes `improved` unconditionally true). See `appendImpliedFinishSplit`.
    it('does not let a slower run steal the PB just because old data predates the finish split', () => {
      const store = memoryStore({
        'overbounce.records.v2': JSON.stringify({
          'q3dm6|vq3|8|chase': {
            best: { time: 10000, splits: [2000, 4000, 6000, 8000], date: '2026-01-01' },
            sumOfBest: [2000, 2000, 2000, 2000],
            counters: { started: 5, completed: 3, died: 1, restarted: 1 },
            timeOnMapMs: 30000,
            firstSeen: '2026-01-01',
            recentRuns: [],
          },
        }),
      });
      const book = new RecordBook(store);

      // Same course, same 4 checkpoints -- just a slower run, now producing
      // a 5-entry `splits` (checkpoints + finish) against old data that
      // migration should have grown to 5 entries too.
      const improved = book.runEnded(
        'q3dm6',
        'vq3',
        8,
        finished(15000, [2500, 4500, 6500, 8500, 15000]),
        'chase',
      );

      expect(improved).toBe(false);
      expect(book.best('q3dm6', 'vq3', 8, 'chase')).toBe(10000);
    });

    it('appends the implied finish leg to both best.splits and sumOfBest', () => {
      const store = memoryStore({
        'overbounce.records.v2': JSON.stringify({
          'q3dm6|vq3|8|chase': {
            best: { time: 10000, splits: [2000, 4000, 6000, 8000], date: '2026-01-01' },
            sumOfBest: [2000, 2000, 2000, 2000],
            counters: { started: 1, completed: 1, died: 0, restarted: 0 },
            timeOnMapMs: 10000,
            firstSeen: '2026-01-01',
            recentRuns: [],
          },
        }),
      });
      const rec = new RecordBook(store).mapRecord('q3dm6', 'vq3', 8, 'chase')!;
      expect(rec.best!.splits).toEqual([2000, 4000, 6000, 8000, 10000]);
      expect(rec.sumOfBest).toEqual([2000, 2000, 2000, 2000, 2000]);
    });

    it('does not duplicate the finish leg when the stored data already reaches it', () => {
      // A v1-migrated (or otherwise coincidental) entry whose last recorded
      // split already equals the total time -- nothing missing to add.
      const store = memoryStore({
        'overbounce.records.v2': JSON.stringify({
          'q3dm6|vq3|8|chase': {
            best: { time: 10000, splits: [4000, 10000], date: '2026-01-01' },
            sumOfBest: [4000, 6000],
            counters: { started: 1, completed: 1, died: 0, restarted: 0 },
            timeOnMapMs: 10000,
            firstSeen: '2026-01-01',
            recentRuns: [],
          },
        }),
      });
      const rec = new RecordBook(store).mapRecord('q3dm6', 'vq3', 8, 'chase')!;
      expect(rec.best!.splits).toEqual([4000, 10000]);
      expect(rec.sumOfBest).toEqual([4000, 6000]);
    });

    it('only migrates once -- a v3 entry is read as-is on a second construction', () => {
      const store = memoryStore({
        'overbounce.records.v2': JSON.stringify({
          'q3dm6|vq3|8|chase': {
            best: { time: 10000, splits: [8000], date: '2026-01-01' },
            sumOfBest: [8000],
            counters: { started: 1, completed: 1, died: 0, restarted: 0 },
            timeOnMapMs: 10000,
            firstSeen: '2026-01-01',
            recentRuns: [],
          },
        }),
      });
      new RecordBook(store); // migrates v2 -> v3
      // Mutate v2 after migration -- a second construction must not re-read it.
      store.setItem(
        'overbounce.records.v2',
        JSON.stringify({ 'q3dm6|vq3|8|chase': { best: { time: 1, splits: [], date: '2026-01-01' } } }),
      );
      const second = new RecordBook(store);
      expect(second.best('q3dm6', 'vq3', 8, 'chase')).toBe(10000);
    });
  });
});
