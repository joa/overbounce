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

  it('an older instance sees a write a newer instance made to a DIFFERENT map', () => {
    // R8: `main.ts`'s `runCourse` holds one instance for a whole course
    // session while `showSettingsScreen`'s Movement tab constructs a fresh
    // one every time it opens. If `get` cached at construction, `old` would
    // still report nothing for a map it never had.
    const backing = memoryStore();
    const old = new PreferenceStore(backing);
    expect(old.get('mega_rl')).toEqual({ physics: null, camera: null });
    new PreferenceStore(backing).set('mega_rl', { physics: null, camera: 'side' });
    expect(old.get('mega_rl')).toEqual({ physics: null, camera: 'side' });
  });

  it('a write from an older instance does not erase a DIFFERENT map a newer instance already wrote', () => {
    // The data-loss half of the same bug: `set` used to persist a snapshot
    // taken at construction, so a write from `old` (built before `new`'s
    // write) would silently overwrite `new`'s change to a different map.
    const backing = memoryStore();
    const old = new PreferenceStore(backing);
    new PreferenceStore(backing).set('q3dm6', { physics: 'cpm', camera: null });
    old.set('mega_rl', { physics: null, camera: 'side' });
    const fresh = new PreferenceStore(backing);
    expect(fresh.get('q3dm6')).toEqual({ physics: 'cpm', camera: null });
    expect(fresh.get('mega_rl')).toEqual({ physics: null, camera: 'side' });
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
