/**
 * Per-map physics/camera overrides.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { describe, it, expect } from 'vitest';
import { PreferenceStore } from '../../src/game/preferences.js';
import type { RecordStore } from '../../src/game/records.js';

function memoryStore(initial?: string): RecordStore {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_k, v) => {
      value = v;
    },
  };
}

describe('PreferenceStore', () => {
  it('has no override for a map that has never been set', () => {
    expect(new PreferenceStore(memoryStore()).get('q3dm6')).toEqual({ physics: null, camera: null });
  });

  it('remembers a physics override', () => {
    const store = new PreferenceStore(memoryStore());
    store.set('q3dm6', { physics: 'cpm', camera: null });
    expect(store.get('q3dm6')).toEqual({ physics: 'cpm', camera: null });
  });

  it('keeps maps apart', () => {
    const store = new PreferenceStore(memoryStore());
    store.set('q3dm6', { physics: 'cpm', camera: null });
    store.set('mega_rl', { physics: null, camera: 'side' });
    expect(store.get('q3dm6')).toEqual({ physics: 'cpm', camera: null });
    expect(store.get('mega_rl')).toEqual({ physics: null, camera: 'side' });
  });

  it('setting both fields null clears the override entirely', () => {
    const backing = memoryStore();
    const store = new PreferenceStore(backing);
    store.set('q3dm6', { physics: 'cpm', camera: 'side' });
    store.set('q3dm6', { physics: null, camera: null });
    expect(store.get('q3dm6')).toEqual({ physics: null, camera: null });

    // And a fresh store over the same backing sees it cleared too.
    expect(new PreferenceStore(backing).get('q3dm6')).toEqual({ physics: null, camera: null });
  });

  it('persists through the store', () => {
    const backing = memoryStore();
    new PreferenceStore(backing).set('q3dm6', { physics: 'vq3', camera: 'chase' });
    expect(new PreferenceStore(backing).get('q3dm6')).toEqual({ physics: 'vq3', camera: 'chase' });
  });

  it('survives storage that is not JSON at all', () => {
    const store = new PreferenceStore(memoryStore('not json {{{'));
    expect(store.get('q3dm6')).toEqual({ physics: null, camera: null });
    store.set('q3dm6', { physics: 'cpm', camera: null });
    expect(store.get('q3dm6')).toEqual({ physics: 'cpm', camera: null });
  });

  it('drops malformed entries, keeping the good ones', () => {
    const store = new PreferenceStore(
      memoryStore(
        JSON.stringify({
          good: { physics: 'vq3', camera: 'side' },
          badPhysics: { physics: 'quake2', camera: 'side' },
          notAnObject: 7,
        }),
      ),
    );
    expect(store.get('good')).toEqual({ physics: 'vq3', camera: 'side' });
    expect(store.get('badPhysics')).toEqual({ physics: null, camera: 'side' });
    expect(store.get('notAnObject')).toEqual({ physics: null, camera: null });
  });
});
