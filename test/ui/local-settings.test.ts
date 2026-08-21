/**
 * Global localStorage-backed settings, and the URL-overrides-storage merge.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { describe, it, expect } from 'vitest';
import { LocalSettingsStore } from '../../src/ui/local-settings.js';
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

describe('LocalSettingsStore', () => {
  it('has no value for a key that has never been set', () => {
    expect(new LocalSettingsStore(memoryStore()).get('obhelp')).toBeNull();
  });

  it('remembers a value', () => {
    const store = new LocalSettingsStore(memoryStore());
    store.set('obhelp', 'letter');
    expect(store.get('obhelp')).toBe('letter');
  });

  it('keeps keys apart', () => {
    const store = new LocalSettingsStore(memoryStore());
    store.set('obhelp', 'letter');
    store.set('tonemap', 'aces');
    expect(store.get('obhelp')).toBe('letter');
    expect(store.get('tonemap')).toBe('aces');
    expect(store.get('ghost')).toBeNull();
  });

  it('setting a key to null clears it', () => {
    const backing = memoryStore();
    const store = new LocalSettingsStore(backing);
    store.set('ghost', '0');
    store.set('ghost', null);
    expect(store.get('ghost')).toBeNull();

    // And a fresh store over the same backing sees it cleared too.
    expect(new LocalSettingsStore(backing).get('ghost')).toBeNull();
  });

  it('persists through the store', () => {
    const backing = memoryStore();
    new LocalSettingsStore(backing).set('volume', '25');
    expect(new LocalSettingsStore(backing).get('volume')).toBe('25');
  });

  it('an older instance sees a write a newer instance made to the SAME key', () => {
    // R8: `main.ts`'s `runCourse` holds one instance for a whole course
    // session while `showSettingsScreen` constructs a fresh one every time
    // it opens. If `get` cached at construction, `old` would still report
    // the value it saw when it was built.
    const backing = memoryStore();
    const old = new LocalSettingsStore(backing);
    expect(old.get('obhelp')).toBeNull();
    new LocalSettingsStore(backing).set('obhelp', 'letter');
    expect(old.get('obhelp')).toBe('letter');
  });

  it('a write from an older instance does not erase a DIFFERENT key a newer instance already wrote', () => {
    // The data-loss half of the same bug: `set` used to persist a snapshot
    // taken at construction, so a write from `old` (built before `new`'s
    // write) would silently overwrite `new`'s change to a different key.
    const backing = memoryStore();
    const old = new LocalSettingsStore(backing);
    new LocalSettingsStore(backing).set('tonemap', 'reinhard');
    old.set('ghost', '0');
    const fresh = new LocalSettingsStore(backing);
    expect(fresh.get('tonemap')).toBe('reinhard');
    expect(fresh.get('ghost')).toBe('0');
  });

  it('survives storage that is not JSON at all', () => {
    const store = new LocalSettingsStore(memoryStore('not json {{{'));
    expect(store.get('obhelp')).toBeNull();
    store.set('obhelp', 'full');
    expect(store.get('obhelp')).toBe('full');
  });

  it('drops malformed entries, keeping the good ones', () => {
    const store = new LocalSettingsStore(
      memoryStore(
        JSON.stringify({
          obhelp: 'full',
          ghost: 7,
          notASettingKey: 'x',
        }),
      ),
    );
    expect(store.get('obhelp')).toBe('full');
    expect(store.get('ghost')).toBeNull();
  });

  it('never reads a key outside SETTING_KEYS, even if storage has it', () => {
    const store = new LocalSettingsStore(memoryStore(JSON.stringify({ map: 'q3dm6' })));
    // @ts-expect-error -- deliberately not a SettingKey, proving it is ignored.
    expect(store.get('map')).toBeNull();
  });

  describe('withDefaults', () => {
    it('fills in a setting missing from the URL', () => {
      const store = new LocalSettingsStore(memoryStore());
      store.set('obhelp', 'letter');
      const merged = store.withDefaults(new URLSearchParams(''));
      expect(merged.get('obhelp')).toBe('letter');
    });

    it('lets a URL value override storage', () => {
      const store = new LocalSettingsStore(memoryStore());
      store.set('obhelp', 'letter');
      const merged = store.withDefaults(new URLSearchParams('obhelp=full'));
      expect(merged.get('obhelp')).toBe('full');
    });

    it('does not touch storage when the URL overrides it', () => {
      const store = new LocalSettingsStore(memoryStore());
      store.set('obhelp', 'letter');
      store.withDefaults(new URLSearchParams('obhelp=full'));
      expect(store.get('obhelp')).toBe('letter');
    });

    it('leaves a non-setting param untouched either way', () => {
      const store = new LocalSettingsStore(memoryStore());
      const merged = store.withDefaults(new URLSearchParams('map=q3dm6&ssaoradius=48'));
      expect(merged.get('map')).toBe('q3dm6');
      expect(merged.get('ssaoradius')).toBe('48');
    });

    it('never injects a diagnostic-only param from storage', () => {
      // Storage physically cannot hold a non-SETTING_KEYS entry (`set` is
      // typed to SettingKey), so this proves the merge does not manufacture
      // one out of a raw, hand-crafted backing blob either.
      const store = new LocalSettingsStore(memoryStore(JSON.stringify({ ssaoradius: '48' })));
      const merged = store.withDefaults(new URLSearchParams(''));
      expect(merged.has('ssaoradius')).toBe(false);
    });

    it('is a snapshot -- mutating the result does not write back to storage', () => {
      const store = new LocalSettingsStore(memoryStore());
      const merged = store.withDefaults(new URLSearchParams(''));
      merged.set('obhelp', 'full');
      expect(store.get('obhelp')).toBeNull();
    });
  });
});
