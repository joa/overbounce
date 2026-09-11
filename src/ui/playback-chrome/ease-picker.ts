/**
 * `Pc`'s easing picker, and the keyframe selection it edits.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The picker: direction on the left, family on the right, one rule between
 * them. Direction alone is meaningless -- see `easing.ts` -- so the two
 * groups are one control, not two.
 */

import type { Timeline, TrackId } from '../../playback/timeline.js';
import { findTrack } from '../../playback/timeline.js';
import type { Ease, EaseDirection, EaseFamily } from '../../playback/easing.js';
import {
  DEFAULT_EASE,
  PICKER_DIRECTIONS,
  PICKER_FAMILIES,
  withDirection,
  withFamily,
} from '../../playback/easing.js';

/** Which keyframe the easing picker is editing. */
export interface Selection {
  track: TrackId;
  time: number;
}

/**
 * The selection and its curve, as ONE mutable object shared by reference.
 *
 * Two surfaces write it and they are in different files: clicking a diamond
 * on a lane selects, and the picker's buttons then edit what was selected.
 * They were two closure variables in one 2700-line function, which is the
 * cheapest possible sharing and is exactly what this preserves -- an object
 * passed to both, mutated in place. Handing each side an accessor pair
 * instead would have been four functions saying what two fields say, and the
 * fields are the honest description: this really is one piece of state that
 * two controls take turns writing.
 */
export interface EaseState {
  selection: Selection | null;
  ease: Ease;
}

export function emptyEaseState(): EaseState {
  return { selection: null, ease: { ...DEFAULT_EASE } };
}

/**
 * The curve glyphs from `Pc`, transcribed from the frame's own SVG paths.
 *
 * Drawn rather than computed from `applyEase` on purpose: these are 14x14
 * icons whose job is to be recognisable at a glance, and a faithful plot of
 * `bounceOut` at that size is a grey smudge. The frame already decided what
 * each one should look like.
 */
const EASE_GLYPH: Record<string, string> = {
  linear: 'M1 13L13 1',
  in: 'M1 13C1 6 6 1 13 1',
  out: 'M1 13C8 13 1 1 13 1',
  ease: 'M1 13C5 13 4 1 13 1',
  quad: 'M1 13C4 13 3 4 13 1',
  cubic: 'M1 13C6 13 2 7 7 7C11 7 8 1 13 1',
  bounce: 'M1 13C4 13 3 3 6 3C8 3 6 9 8 9C10 9 9 1 13 1',
};

function easeButton(key: string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('viewBox', '0 0 14 14');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', EASE_GLYPH[key] ?? EASE_GLYPH.linear);
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('fill', 'none');
  svg.appendChild(path);
  const text = document.createElement('span');
  text.textContent = label;
  btn.append(svg, text);
  return btn;
}

/**
 * Build the picker into `host`, and return the repaint the chrome calls.
 *
 * It writes to the SELECTED keyframe, and is inert with nothing selected.
 * Disabled rather than hidden: the control is part of the bar's layout in
 * `Pc`, and a bar that reflows when you click a diamond is worse than one
 * with four dim buttons in it. `#4a4a54`-adjacent dimming is exactly what
 * HANDOFF.md reserves for "unavailable", which this is.
 */
export function createEasePicker(
  host: HTMLElement,
  state: EaseState,
  timeline: Timeline,
  pushUndo: () => void,
): { render(): void } {
  const dirButtons = new Map<EaseDirection, HTMLButtonElement>();
  const famButtons = new Map<EaseFamily, HTMLButtonElement>();

  const render = (): void => {
    const live = state.selection !== null;
    for (const [dir, btn] of dirButtons) {
      btn.classList.toggle('active', live && state.ease.direction === dir);
      btn.disabled = !live;
    }
    for (const [fam, btn] of famButtons) {
      // A linear key has no family, so the family half greys out with it --
      // picking CUBIC while LINEAR is selected would show a state the curve
      // does not actually have.
      btn.classList.toggle(
        'active',
        live && state.ease.direction !== 'linear' && state.ease.family === fam,
      );
      btn.disabled = !live || state.ease.direction === 'linear';
    }
  };

  const apply = (next: Ease): void => {
    state.ease = next;
    const selection = state.selection;
    if (selection) {
      const track = findTrack(timeline, selection.track);
      const key = track?.keys.find((k) => k.time === selection.time);
      if (key) {
        // An easing change is an edit to the shot like any other -- it is the
        // difference between a camera that arrives and one that glides in --
        // so it goes on the undo stack with the rest.
        pushUndo();
        key.ease = next;
      }
    }
    render();
  };

  for (const dir of PICKER_DIRECTIONS) {
    const btn = easeButton(dir, dir.toUpperCase());
    btn.addEventListener('click', () => apply(withDirection(state.ease, dir)));
    dirButtons.set(dir, btn);
    host.appendChild(btn);
  }
  const rule = document.createElement('div');
  rule.className = 'rule';
  host.appendChild(rule);
  for (const fam of PICKER_FAMILIES) {
    const btn = easeButton(fam, fam.toUpperCase());
    btn.addEventListener('click', () => apply(withFamily(state.ease, fam)));
    famButtons.set(fam, btn);
    host.appendChild(btn);
  }

  return { render };
}
