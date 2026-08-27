/**
 * The configurable key/mouse binds store behind Settings' Controls panel.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { describe, it, expect } from 'vitest';
import {
  ACTIONS,
  DEFAULT_BINDS,
  KeyBindsStore,
  bindLabel,
  clearElsewhere,
} from '../../src/input/keybinds.js';
import type { Binds } from '../../src/input/keybinds.js';
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

describe('KeyBindsStore', () => {
  it('reads the real defaults when nothing is stored', () => {
    expect(new KeyBindsStore(memoryStore()).read()).toEqual(DEFAULT_BINDS);
  });

  it('round-trips a write through a fresh instance over the same store', () => {
    const store = memoryStore();
    const binds: Binds = { ...DEFAULT_BINDS, jump: ['Space', 'KeyJ'] };
    new KeyBindsStore(store).write(binds);
    expect(new KeyBindsStore(store).read()).toEqual(binds);
  });

  it('falls back to defaults per-action on a partial or corrupt entry', () => {
    const store = memoryStore();
    store.setItem('overbounce.keybinds.v1', JSON.stringify({ jump: ['Space', null] }));
    const read = new KeyBindsStore(store).read();
    expect(read.jump).toEqual(['Space', null]);
    expect(read.forward).toEqual(DEFAULT_BINDS.forward);
  });

  it('tolerates unparsable JSON rather than throwing', () => {
    const store = memoryStore();
    store.setItem('overbounce.keybinds.v1', '{not json');
    expect(new KeyBindsStore(store).read()).toEqual(DEFAULT_BINDS);
  });

  it('resetOne restores a single action without touching the others', () => {
    const store = memoryStore();
    const kb = new KeyBindsStore(store);
    kb.write({ ...DEFAULT_BINDS, jump: ['KeyJ', null], forward: ['KeyI', null] });
    const after = kb.resetOne('jump');
    expect(after.jump).toEqual(DEFAULT_BINDS.jump);
    expect(after.forward).toEqual(['KeyI', null]);
  });

  it('resetAll restores every action', () => {
    const store = memoryStore();
    const kb = new KeyBindsStore(store);
    kb.write({ ...DEFAULT_BINDS, jump: ['KeyJ', null] });
    expect(kb.resetAll()).toEqual(DEFAULT_BINDS);
    expect(kb.read()).toEqual(DEFAULT_BINDS);
  });

  it('every action has a real default entry', () => {
    for (const action of ACTIONS) {
      expect(DEFAULT_BINDS[action]).toBeDefined();
    }
  });
});

describe('clearElsewhere', () => {
  it('clears a bind reassigned to a different action -- the caller does the assignment itself', () => {
    const binds: Binds = { ...DEFAULT_BINDS, crouch: ['ControlLeft', 'KeyC'] };
    // The caller's own flow: assign the slot, then scrub the old owner.
    binds.jump = [binds.jump[0], 'ControlLeft'];
    const next = clearElsewhere(binds, 'ControlLeft', 'jump', 1);
    expect(next.crouch).toEqual([null, 'KeyC']);
    expect(next.jump[1]).toBe('ControlLeft');
  });

  it('does not clear the slot being assigned itself', () => {
    const binds: Binds = { ...DEFAULT_BINDS, jump: ['Space', 'Mouse2'] };
    const next = clearElsewhere(binds, 'Space', 'jump', 0);
    expect(next.jump).toEqual(['Space', 'Mouse2']);
  });

  it('is a no-op for an unbind (null)', () => {
    const binds: Binds = { ...DEFAULT_BINDS };
    expect(clearElsewhere(binds, null, 'jump', 0)).toEqual(binds);
  });
});

describe('bindLabel', () => {
  it('formats keys, mouse buttons, and unbound slots', () => {
    expect(bindLabel('KeyW')).toBe('W');
    expect(bindLabel('Digit1')).toBe('1');
    expect(bindLabel('Space')).toBe('SPACE');
    expect(bindLabel('ControlLeft')).toBe('CTRL');
    expect(bindLabel('ArrowUp')).toBe('UP');
    expect(bindLabel('Mouse0')).toBe('MOUSE 1');
    expect(bindLabel('Mouse2')).toBe('MOUSE 3');
    expect(bindLabel(null)).toBe('—');
  });
});
