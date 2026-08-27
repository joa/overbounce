/**
 * The career-wide distance/jump/overbounce/rocket counters behind the title
 * screen's LIFETIME panel.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { describe, it, expect } from 'vitest';
import { LifetimeStats } from '../../src/game/lifetime.js';
import type { RecordStore } from '../../src/game/records.js';

function memoryStore(): RecordStore {
  const values = new Map<string, string>();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
  };
}

describe('LifetimeStats', () => {
  it('starts at zero', () => {
    expect(new LifetimeStats(memoryStore()).read()).toEqual({
      distanceUnits: 0,
      jumps: 0,
      overbounces: 0,
      rockets: 0,
    });
  });

  it('read() sees pending additions before flush()', () => {
    const stats = new LifetimeStats(memoryStore());
    stats.addDistance(120);
    stats.addJump();
    stats.addJump();
    stats.addOverbounce();
    stats.addRocket();
    expect(stats.read()).toEqual({ distanceUnits: 120, jumps: 2, overbounces: 1, rockets: 1 });
  });

  it('flush() persists pending totals and a fresh instance over the same store sees them', () => {
    const store = memoryStore();
    const first = new LifetimeStats(store);
    first.addDistance(500);
    first.addJump();
    first.flush();

    const second = new LifetimeStats(store);
    expect(second.read()).toEqual({ distanceUnits: 500, jumps: 1, overbounces: 0, rockets: 0 });
  });

  it('flush() accumulates across multiple calls rather than overwriting', () => {
    const store = memoryStore();
    const stats = new LifetimeStats(store);
    stats.addRocket();
    stats.flush();
    stats.addRocket();
    stats.addRocket();
    stats.flush();
    expect(new LifetimeStats(store).read().rockets).toBe(3);
  });

  it('tolerates corrupt storage rather than throwing', () => {
    const store = memoryStore();
    store.setItem('overbounce.lifetime.v1', '{not json');
    expect(new LifetimeStats(store).read()).toEqual({
      distanceUnits: 0,
      jumps: 0,
      overbounces: 0,
      rockets: 0,
    });
  });
});
