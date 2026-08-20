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
import { RecordBook } from '../../src/game/records.js';
import type { RecordStore } from '../../src/game/records.js';

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
});
