/**
 * Personal best times, and the run-history data under Results.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The interesting cases are all about hostile storage: localStorage is shared
 * with every other page on the origin, so a corrupt or half-written value must
 * lose the records rather than break the game. Also covered: keys stay apart
 * per (map, physics, msec, camera), and the segment graph's invariant that
 * sum-of-best can never come out above the PB.
 */

import { describe, it, expect } from 'vitest';
import { RecordBook, runSegments, sumOfBest } from '../../src/game/records.js';
import type { RecordStore, Split } from '../../src/game/records.js';

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

/** A split at checkpoint `id`, `at` ms into the run. */
const cp = (id: string, at: number): Split => ({ cp: id, at });

const finished = (time: number, splits: Split[] = []) =>
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
    book.runEnded('mega_rl', 'vq3', 8, finished(30000, [cp('cp1', 10000), cp('cp2', 20000)]));
    expect(book.record('mega_rl', 'vq3', 8)!.splits).toEqual([cp('cp1', 10000), cp('cp2', 20000)]);

    // A slower run must not overwrite them.
    book.runEnded('mega_rl', 'vq3', 8, finished(40000, [cp('cp1', 1), cp('cp2', 2)]));
    expect(book.record('mega_rl', 'vq3', 8)!.splits).toEqual([cp('cp1', 10000), cp('cp2', 20000)]);
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
    const book = new RecordBook(memoryStore({ 'overbounce.records.v1': 'not json {{{' }));
    expect(book.best('q3dm6', 'vq3', 8)).toBeNull();
    // ...and is still usable afterwards.
    expect(book.runEnded('q3dm6', 'vq3', 8, finished(1000))).toBe(true);
  });

  it('survives JSON of the wrong shape', () => {
    for (const raw of ['null', '[]', '"a string"', '42']) {
      expect(new RecordBook(memoryStore({ 'overbounce.records.v1': raw })).best('q3dm6', 'vq3', 8)).toBeNull();
    }
  });

  it('drops individual entries that are malformed, keeping the good ones', () => {
    const store = memoryStore({
      'overbounce.records.v1': JSON.stringify({
        'good|vq3|8|chase': { best: { time: 5000, splits: [{ cp: 'cp1', at: 1000 }], date: '2026-01-01' } },
        'noTime|vq3|8|chase': { best: { splits: [] } },
        'stringTime|vq3|8|chase': { best: { time: '5000' } },
        'negative|vq3|8|chase': { best: { time: -1 } },
        'notAnObject|vq3|8|chase': 7,
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
    /**
     * The invariant everything below leans on (`MapRecord.segmentBests`):
     * the PB run's own segments are always in the graph, so sum-of-best is
     * never more than the PB. Checked after every write, not just at the end.
     */
    const expectBounded = (book: RecordBook, map = 'q3dm6'): number | null => {
      const rec = book.mapRecord(map, 'vq3', 8)!;
      const sob = sumOfBest(rec);
      if (rec.best) {
        expect(sob).not.toBeNull();
        expect(sob!).toBeLessThanOrEqual(rec.best.time);
      } else {
        expect(sob).toBeNull();
      }
      return sob;
    };

    it('is null until a run has been completed', () => {
      expect(sumOfBest({ segmentBests: {} })).toBeNull();
      const book = new RecordBook(memoryStore());
      book.runStarted('q3dm6', 'vq3', 8);
      book.runEnded('q3dm6', 'vq3', 8, { kind: 'died', timeOnMapMs: 500 });
      expect(expectBounded(book)).toBeNull();
    });

    it('takes the best segment across runs, not the segments of the best run', () => {
      const book = new RecordBook(memoryStore());
      // Run A: slow first segment, fast second segment.
      book.runEnded('q3dm6', 'vq3', 8, finished(10000, [cp('cp1', 6000)]));
      // Run B: fast first segment, slow second -- and a slower total, so it is
      // not the record, but its first segment beats run A's.
      book.runEnded('q3dm6', 'vq3', 8, finished(11000, [cp('cp1', 3000)]));

      const rec = book.mapRecord('q3dm6', 'vq3', 8)!;
      expect(rec.segmentBests).toEqual({ '<start>': { cp1: 3000 }, cp1: { '<finish>': 4000 } });
      expect(expectBounded(book)).toBe(7000);
      // The record itself is still run A's, unaffected by segment bookkeeping.
      expect(rec.best!.time).toBe(10000);
    });

    it('a run that skips a checkpoint contributes the segment it actually ran', () => {
      // `target_checkpoint` triggers are waypoints, not gates. An overbounce
      // past cp2 is a `cp1 -> cp3` segment -- a different segment from
      // `cp1 -> cp2`, not a mis-positioned one -- and the run's other
      // segments compete at the checkpoints it did touch. Nothing is ignored.
      const book = new RecordBook(memoryStore());
      book.runEnded('q3dm6', 'vq3', 8, finished(20000, [cp('cp1', 5000), cp('cp2', 12000), cp('cp3', 16000)]));
      const improved = book.runEnded('q3dm6', 'vq3', 8, finished(21000, [cp('cp1', 4800), cp('cp3', 15000)]));

      const rec = book.mapRecord('q3dm6', 'vq3', 8)!;
      expect(improved).toBe(false);
      expect(rec.best!.time).toBe(20000);
      expect(rec.segmentBests).toEqual({
        '<start>': { cp1: 4800 },
        cp1: { cp2: 7000, cp3: 10200 },
        cp2: { cp3: 4000 },
        cp3: { '<finish>': 4000 },
      });
      // Best start->cp1 (4800) + the skip (10200) + best cp3->finish (4000).
      expect(expectBounded(book)).toBe(19000);
    });

    it('a differently-routed run that is faster becomes the PB, and both routes stay in the graph', () => {
      const book = new RecordBook(memoryStore());
      book.runEnded('q3dm6', 'vq3', 8, finished(20000, [cp('cp1', 5000)]));
      const improved = book.runEnded('q3dm6', 'vq3', 8, finished(9000, [cp('cp1', 4000), cp('cp2', 9000)]));

      const rec = book.mapRecord('q3dm6', 'vq3', 8)!;
      expect(improved).toBe(true);
      expect(rec.best!.time).toBe(9000);
      expect(rec.best!.splits).toEqual([cp('cp1', 4000), cp('cp2', 9000)]);
      expect(rec.segmentBests).toEqual({
        '<start>': { cp1: 4000 },
        cp1: { '<finish>': 15000, cp2: 5000 },
        cp2: { '<finish>': 0 },
      });
      expect(expectBounded(book)).toBe(9000);
    });

    it('combines best segments from different runs along different routes', () => {
      // The community meaning of the number (LiveSplit computes skipped
      // splits the same way): the best time already proven segment by
      // segment, along routes actually run -- not necessarily one route.
      const book = new RecordBook(memoryStore());
      book.runEnded('q3dm6', 'vq3', 8, finished(9000, [cp('cp1', 3000), cp('cp2', 6000)]));
      book.runEnded('q3dm6', 'vq3', 8, finished(12000, [cp('cp2', 5500)]));

      // start->cp2 direct (5500) beats start->cp1->cp2 (6000); cp2->finish
      // is run A's 3000, not run B's 6500.
      expect(expectBounded(book)).toBe(8500);
      expect(book.best('q3dm6', 'vq3', 8)).toBe(9000);
    });

    it("a slower run's one genuinely best segment counts, and its slow ones change nothing", () => {
      // The report this replaces: "SoB is computed as if my slow run, where
      // every segment was slower, could still improve the time". A slow
      // run's segments enter the graph like any other's: one that IS a best
      // lowers the sum, and the slow ones change nothing, because the PB's
      // own segments are already there at better times.
      const book = new RecordBook(memoryStore());
      book.runEnded(
        'q3dm6',
        'vq3',
        8,
        finished(10560, [cp('cp1', 2744), cp('cp2', 5232), cp('cp3', 6680), cp('cp4', 9632)]),
      );
      // Every segment slower than the PB's.
      book.runEnded(
        'q3dm6',
        'vq3',
        8,
        finished(15584, [cp('cp1', 2760), cp('cp2', 5432), cp('cp3', 7808), cp('cp4', 11008), cp('cp5', 13952)]),
      );
      expect(expectBounded(book)).toBe(10560);

      // Slower overall, but nails cp3 -> cp4 (1256 against the PB's 2952).
      book.runEnded(
        'q3dm6',
        'vq3',
        8,
        finished(13000, [cp('cp1', 3000), cp('cp2', 6000), cp('cp3', 8000), cp('cp4', 9256)]),
      );
      expect(expectBounded(book)).toBe(2744 + 2488 + 1448 + 1256 + 928);
      expect(book.best('q3dm6', 'vq3', 8)).toBe(10560);
    });

    it('holds the bound through a season of runs of varying route', () => {
      const book = new RecordBook(memoryStore());
      const runs: [number, Split[], number][] = [
        // time, splits, expected sum-of-best afterwards
        [14728, [cp('cp1', 3200), cp('cp3', 7900), cp('cp4', 12100)], 14728], // cp2 and cp5 skipped
        [13000, [cp('cp1', 2900), cp('cp2', 5400), cp('cp3', 6900), cp('cp4', 9900), cp('cp5', 12000)], 12528],
        [15584, [cp('cp1', 2760), cp('cp2', 5432), cp('cp3', 7808), cp('cp4', 9064), cp('cp5', 13952)], 10644],
        [10560, [cp('cp1', 2744), cp('cp2', 5232), cp('cp3', 6680), cp('cp4', 9632)], 8864], // cp5 skipped
      ];
      for (const [time, splits, expected] of runs) {
        book.runEnded('q3dm6', 'vq3', 8, finished(time, splits));
        expect(expectBounded(book)).toBe(expected);
      }
      expect(book.best('q3dm6', 'vq3', 8)).toBe(10560);
    });

    it('counts a repeated checkpoint at its first touch only', () => {
      const book = new RecordBook(memoryStore());
      book.runEnded('q3dm6', 'vq3', 8, finished(10000, [cp('a', 2000), cp('b', 4000), cp('a', 6000)]));
      const rec = book.mapRecord('q3dm6', 'vq3', 8)!;
      expect(rec.segmentBests).toEqual({ '<start>': { a: 2000 }, a: { b: 2000 }, b: { '<finish>': 6000 } });
      expect(runSegments(rec.best!.splits, rec.best!.time)).toEqual([
        { from: '<start>', to: 'a', ms: 2000 },
        { from: 'a', to: 'b', ms: 2000 },
        { from: 'b', to: '<finish>', ms: 6000 },
      ]);
    });

    it("restores the PB's own segments on read, so stored data can never put the sum above the PB", () => {
      const store = memoryStore({
        'overbounce.records.v1': JSON.stringify({
          'q3dm6|vq3|8|chase': {
            best: { time: 20000, splits: [cp('cp1', 5000), cp('cp2', 12000)], date: '2026-08-31' },
            // Missing the PB's own edges, and worse than it where present.
            segmentBests: { '<start>': { cp1: 6000 }, cp1: { cp3: 9000 } },
            counters: { started: 2, completed: 2, died: 0, restarted: 0 },
            timeOnMapMs: 40000,
            firstSeen: '2026-08-31',
            recentRuns: [],
          },
        }),
      });
      const before = store.raw('overbounce.records.v1');
      const rec = new RecordBook(store).mapRecord('q3dm6', 'vq3', 8, 'chase')!;
      expect(rec.segmentBests).toEqual({
        '<start>': { cp1: 5000 },
        cp1: { cp3: 9000, cp2: 7000 },
        cp2: { '<finish>': 8000 },
      });
      expect(sumOfBest(rec)).toBe(20000);
      // Reading never writes on its own -- the repair is re-derived on every
      // load and lands on disk with the next genuine write.
      expect(store.raw('overbounce.records.v1')).toBe(before);
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
});
