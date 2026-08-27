/**
 * Configurable key/mouse bindings -- two slots per action, `input.ts`'s own
 * consumer.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Before this, movement was three hardcoded layouts at once (WASD, arrows,
 * and L/N/R/T -- `input.ts`'s old `FORWARD_KEYS` etc.) and Attack/Jump were
 * hardcoded to specific mouse buttons. The Settings Controls panel needs a
 * real two-slot-per-action model to remap, which cannot hold three layouts
 * at once -- so the defaults below keep WASD and the L/N/R/T alternate
 * layout (the two hands the original comment cared about) and DROP the
 * arrow keys from the default bindings. This is a real behaviour change for
 * anyone currently relying on arrow keys: they still work if manually bound
 * to a slot, they are just no longer live out of the box.
 *
 * A "bind" is either a `KeyboardEvent.code` string (`'KeyW'`, `'Space'`,
 * `'ControlLeft'`...) or a synthetic `'Mouse0'`/`'Mouse1'`/`'Mouse2'` for a
 * mouse button (`MouseEvent.button`, 0-indexed) -- `input.ts` folds both into
 * one `held` set so movement, jump and attack all check the same way
 * regardless of which device satisfied them.
 */

import type { RecordStore } from '../game/records.js';
import { defaultStore } from '../game/records.js';

export const ACTIONS = ['forward', 'back', 'left', 'right', 'jump', 'crouch', 'attack'] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABEL: Record<Action, string> = {
  forward: 'Forward',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  jump: 'Jump',
  crouch: 'Crouch',
  attack: 'Attack',
};

/** A `KeyboardEvent.code`, a synthetic `'Mouse<N>'`, or unbound. */
export type Bind = string | null;
export type Binds = Record<Action, [Bind, Bind]>;

/**
 * Real current defaults, not the mockup's arbitrary example values (which
 * put Attack's second slot on Ctrl -- already Crouch here, a real conflict
 * this project's own game never had). Jump keeps its actual second bind,
 * right-click, because rocket jumping wants fire and jump on the same hand
 * -- see `input.ts`'s own comment on why that exists at all.
 */
export const DEFAULT_BINDS: Binds = {
  forward: ['KeyW', 'KeyL'],
  back: ['KeyS', 'KeyR'],
  left: ['KeyA', 'KeyN'],
  right: ['KeyD', 'KeyT'],
  jump: ['Space', 'Mouse2'],
  crouch: ['ControlLeft', 'KeyC'],
  attack: ['Mouse0', null],
};

const KEY = 'overbounce.keybinds.v1';

function isBind(v: unknown): v is Bind {
  return v === null || typeof v === 'string';
}

function readBinds(store: RecordStore): Binds {
  const raw = store.getItem(KEY);
  const out: Binds = { ...DEFAULT_BINDS };
  if (!raw) {
    return out;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return out;
    }
    const p = parsed as Record<string, unknown>;
    for (const action of ACTIONS) {
      const slots = p[action];
      if (Array.isArray(slots) && slots.length === 2 && isBind(slots[0]) && isBind(slots[1])) {
        out[action] = [slots[0], slots[1]];
      }
    }
    return out;
  } catch {
    return out;
  }
}

export class KeyBindsStore {
  private readonly store: RecordStore;

  constructor(store: RecordStore = defaultStore()) {
    this.store = store;
  }

  read(): Binds {
    return readBinds(this.store);
  }

  /** Persists the whole map -- callers read-modify-write via `read()` first. */
  write(binds: Binds): void {
    try {
      this.store.setItem(KEY, JSON.stringify(binds));
    } catch {
      // Quota exceeded or storage revoked -- the in-memory copy this session
      // is using stays correct; only persistence across reloads is lost.
    }
  }

  resetAll(): Binds {
    this.write(DEFAULT_BINDS);
    return { ...DEFAULT_BINDS };
  }

  resetOne(action: Action): Binds {
    const binds = this.read();
    binds[action] = [...DEFAULT_BINDS[action]];
    this.write(binds);
    return binds;
  }
}

/**
 * A bind whose SLOT in another action already holds `bind` is cleared --
 * `input.ts`'s `held` set cannot tell two actions apart if they share a
 * physical key, and the design leaves this case unspecified, so "the old
 * assignment loses" is the simplest defensible rule rather than a UI to
 * choose between them.
 */
export function clearElsewhere(binds: Binds, bind: Bind, except: Action, exceptSlot: 0 | 1): Binds {
  if (bind === null) {
    return binds;
  }
  const out: Binds = { ...binds };
  for (const action of ACTIONS) {
    const slots = out[action];
    const next: [Bind, Bind] = [...slots];
    for (const slot of [0, 1] as const) {
      if (action === except && slot === exceptSlot) {
        continue;
      }
      if (next[slot] === bind) {
        next[slot] = null;
      }
    }
    out[action] = next;
  }
  return out;
}

const NAMED: Record<string, string> = {
  Space: 'SPACE',
  ControlLeft: 'CTRL',
  ControlRight: 'CTRL',
  ShiftLeft: 'SHIFT',
  ShiftRight: 'SHIFT',
  AltLeft: 'ALT',
  AltRight: 'ALT',
  Escape: 'ESC',
  Tab: 'TAB',
  Enter: 'ENTER',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
};

/** How a bind reads in the UI -- `'KeyW'` -> `'W'`, `'Mouse0'` -> `'MOUSE 1'`. */
export function bindLabel(bind: Bind): string {
  if (bind === null) {
    return '—';
  }
  if (bind.startsWith('Mouse')) {
    return `MOUSE ${Number(bind.slice(5)) + 1}`;
  }
  if (NAMED[bind]) {
    return NAMED[bind];
  }
  if (bind.startsWith('Key')) {
    return bind.slice(3);
  }
  if (bind.startsWith('Digit')) {
    return bind.slice(5);
  }
  if (bind.startsWith('Arrow')) {
    return bind.slice(5).toUpperCase();
  }
  return bind.toUpperCase();
}

/** `KeyboardEvent.code` for a keydown, or the synthetic `'Mouse<N>'` for a mousedown. */
export function bindFromKeyboardEvent(e: KeyboardEvent): Bind {
  return e.code;
}
export function bindFromMouseEvent(e: MouseEvent): Bind {
  return `Mouse${e.button}`;
}
