/**
 * Personal best times.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The interesting cases are all about hostile storage: localStorage is shared
 * with every other page on the origin, so a corrupt or half-written value must
 * lose the records rather than break the game.
 */

import { describe, it, expect } from 'vitest';
import { RecordBook } from '../../src/game/records.js';
import type { RecordStore } from '../../src/game/records.js';

function memoryStore(initial?: string): RecordStore & { raw(): string | null } {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_k, v) => {
      value = v;
    },
    raw: () => value,
  };
}

describe('RecordBook', () => {
  it('has no record for a map that has never been run', () => {
    expect(new RecordBook(memoryStore()).best('q3dm6')).toBeNull();
  });

  it('records a first run', () => {
    const book = new RecordBook(memoryStore());
    expect(book.submit('q3dm6', 12345)).toBe(true);
    expect(book.best('q3dm6')).toBe(12345);
  });

  it('keeps only the faster of two runs', () => {
    const book = new RecordBook(memoryStore());
    book.submit('q3dm6', 12000);

    expect(book.submit('q3dm6', 15000)).toBe(false);
    expect(book.best('q3dm6')).toBe(12000);

    expect(book.submit('q3dm6', 9000)).toBe(true);
    expect(book.best('q3dm6')).toBe(9000);
  });

  it('does not treat an equal time as an improvement', () => {
    const book = new RecordBook(memoryStore());
    book.submit('q3dm6', 12000);
    expect(book.submit('q3dm6', 12000)).toBe(false);
  });

  it('keeps maps apart', () => {
    const book = new RecordBook(memoryStore());
    book.submit('q3dm6', 12000);
    book.submit('mega_rl', 30000);
    expect(book.best('q3dm6')).toBe(12000);
    expect(book.best('mega_rl')).toBe(30000);
  });

  it('stores the splits from the run that set the record', () => {
    const book = new RecordBook(memoryStore());
    book.submit('mega_rl', 30000, [10000, 20000]);
    expect(book.record('mega_rl')!.splits).toEqual([10000, 20000]);

    // A slower run must not overwrite them.
    book.submit('mega_rl', 40000, [1, 2]);
    expect(book.record('mega_rl')!.splits).toEqual([10000, 20000]);
  });

  it('persists through the store', () => {
    const store = memoryStore();
    new RecordBook(store).submit('q3dm6', 12000);
    // A fresh book over the same storage sees it.
    expect(new RecordBook(store).best('q3dm6')).toBe(12000);
  });

  it('rejects nonsense times rather than storing them', () => {
    const book = new RecordBook(memoryStore());
    expect(book.submit('q3dm6', 0)).toBe(false);
    expect(book.submit('q3dm6', -5)).toBe(false);
    expect(book.submit('q3dm6', Number.NaN)).toBe(false);
    expect(book.submit('q3dm6', Number.POSITIVE_INFINITY)).toBe(false);
    expect(book.best('q3dm6')).toBeNull();
  });

  it('survives storage that is not JSON at all', () => {
    const book = new RecordBook(memoryStore('not json {{{'));
    expect(book.best('q3dm6')).toBeNull();
    // ...and is still usable afterwards.
    expect(book.submit('q3dm6', 1000)).toBe(true);
  });

  it('survives JSON of the wrong shape', () => {
    for (const raw of ['null', '[]', '"a string"', '42']) {
      expect(new RecordBook(memoryStore(raw)).best('q3dm6')).toBeNull();
    }
  });

  it('drops individual entries that are malformed, keeping the good ones', () => {
    const store = memoryStore(
      JSON.stringify({
        good: { time: 5000, splits: [1000], date: '2026-01-01' },
        noTime: { splits: [] },
        stringTime: { time: '5000' },
        negative: { time: -1 },
        notAnObject: 7,
      }),
    );
    const book = new RecordBook(store);
    expect(book.best('good')).toBe(5000);
    expect(book.best('noTime')).toBeNull();
    expect(book.best('stringTime')).toBeNull();
    expect(book.best('negative')).toBeNull();
    expect(book.best('notAnObject')).toBeNull();
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
    expect(book.submit('q3dm6', 12000)).toBe(true);
    expect(book.best('q3dm6')).toBe(12000);
  });
});
