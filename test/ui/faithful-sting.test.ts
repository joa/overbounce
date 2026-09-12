/**
 * The Faithful 1999 sting fires once, ever.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { playFaithfulStingOnce, resetFaithfulSting } from '../../src/ui/faithful-sting.js';
import { LocalSettingsStore } from '../../src/ui/local-settings.js';
import type { RecordStore } from '../../src/game/records.js';

function memoryStore(): RecordStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

describe('playFaithfulStingOnce', () => {
  let store: RecordStore;
  let settings: LocalSettingsStore;
  let played: { url: string; volume: number }[];
  const play = (url: string, volume: number): void => {
    played.push({ url, volume });
  };

  beforeEach(() => {
    store = memoryStore();
    settings = new LocalSettingsStore(memoryStore());
    played = [];
  });

  it('plays on the first switch to Faithful and never again', () => {
    expect(playFaithfulStingOnce(true, { store, settings, play })).toBe(true);
    expect(played).toHaveLength(1);
    expect(played[0].url).toMatch(/sfx\/faithful\.webm$/);

    expect(playFaithfulStingOnce(true, { store, settings, play })).toBe(false);
    expect(playFaithfulStingOnce(true, { store, settings, play })).toBe(false);
    expect(played).toHaveLength(1);
  });

  it('says nothing when the switch was to Modern, and does not burn the once', () => {
    expect(playFaithfulStingOnce(false, { store, settings, play })).toBe(false);
    expect(played).toEqual([]);
    // Going back to Faithful is still the first discovery.
    expect(playFaithfulStingOnce(true, { store, settings, play })).toBe(true);
  });

  it('respects mute, and still owes the player the sting afterwards', () => {
    settings.set('muted', '1');
    expect(playFaithfulStingOnce(true, { store, settings, play })).toBe(false);
    expect(played).toEqual([]);

    settings.set('muted', '0');
    expect(playFaithfulStingOnce(true, { store, settings, play })).toBe(true);
  });

  it('plays at the volume the rest of the game is set to', () => {
    settings.set('volume', '35');
    playFaithfulStingOnce(true, { store, settings, play });
    expect(played[0].volume).toBeCloseTo(0.35, 5);
  });

  it('can be reset, which is what clearing records means here', () => {
    playFaithfulStingOnce(true, { store, settings, play });
    resetFaithfulSting(store);
    expect(playFaithfulStingOnce(true, { store, settings, play })).toBe(true);
    expect(played).toHaveLength(2);
  });
});
