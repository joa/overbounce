/**
 * The title screen (`1e`).
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Unlike every other screen in `design/`, `1e` is NOT the rail/header/card
 * shell -- it is its own full-bleed layout, per `design/HANDOFF.md`. Built
 * fresh here rather than forced through `shell.ts` for that reason.
 *
 * Two things the mockup shows and this deliberately doesn't build yet:
 * "Learn the movement" (the lesson flow, `HANDOFF.md`'s own "not designed
 * yet" list) and the "last session" stats strip -- `records.v2` (Phase 4)
 * has the data now, but wiring a title-screen summary from it is title-screen
 * scope, not Settings' (Phase 6), and stays undone until something actually
 * asks for it. Neither is faked with placeholder data.
 *
 * The backdrop is a plain background, not a live-rendered map -- see
 * `.agent/plans/UI.md`'s title-screen trap: at this point in the flow no
 * assets are mounted yet, so there is nothing to render behind the menu.
 */

import '../tokens.css';
import { isFaithfulMode, applyRenderPreset } from '../render-preset.js';

export type TitleChoice = 'run' | 'load';

const STYLE = `
.ob-title { position: fixed; inset: 0; z-index: 5; background: var(--ob-background);
  color: var(--ob-text); font-family: var(--ob-font-display); display: flex;
  flex-direction: column; }
.ob-title-bar { height: 52px; flex: none; display: flex; align-items: center;
  justify-content: space-between; padding: 0 26px; border-bottom: 1px solid var(--ob-seam); }
.ob-title-build { font: 400 11px/1 var(--ob-font-mono); letter-spacing: .2em; color: var(--ob-dim); }
.ob-title-bar-right { display: flex; gap: 8px; align-items: center; }
.ob-title-toggle { display: flex; align-items: center; gap: 7px; padding: 6px 11px;
  border: 1px solid var(--ob-control); border-radius: 4px; cursor: pointer; background: transparent;
  color: var(--ob-text-secondary); font: 400 11px/1 var(--ob-font-mono); letter-spacing: .1em; }
.ob-title-toggle:hover { border-color: var(--ob-control-hover); }

.ob-title-main { flex: 1; display: flex; flex-direction: column; justify-content: center;
  padding: 0 74px; max-width: 560px; }
.ob-title-kicker { font: 400 12px/1 var(--ob-font-mono); letter-spacing: .34em; color: var(--ob-accent); }
.ob-title-word { margin-top: 18px; font: 700 100px/.82 var(--ob-font-display); letter-spacing: -.03em;
  text-transform: uppercase; }
.ob-title-word b { color: var(--ob-accent); font-weight: 700; }
.ob-title-tag { margin-top: 18px; font: 400 16px/1.5 var(--ob-font-display); letter-spacing: .02em;
  color: var(--ob-dim); max-width: 52ch; }

.ob-title-actions { margin-top: 30px; display: flex; flex-direction: column; gap: 10px;
  max-width: 400px; }
.ob-title-btn { display: block; width: 100%; text-align: left; padding: 14px 18px;
  border-radius: 5px; font: 600 15px/1 var(--ob-font-display); letter-spacing: .06em;
  text-transform: uppercase; cursor: pointer; }
.ob-title-btn.primary { border: 1px solid var(--ob-accent); background: rgba(232,98,42,.18);
  color: var(--ob-text); }
.ob-title-btn.primary:hover { background: rgba(232,98,42,.28); }
.ob-title-btn.secondary { border: 1px solid var(--ob-control); background: transparent;
  color: var(--ob-text-secondary); font-weight: 400; }
.ob-title-btn.secondary:hover { border-color: var(--ob-control-hover); }

.ob-title-footer { flex: none; padding: 16px 26px; font: 400 10px/1 var(--ob-font-mono);
  letter-spacing: .04em; color: var(--ob-unavailable); }
`;

export function showTitleScreen(parent: HTMLElement): Promise<TitleChoice> {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'ob-title';

  const params = new URLSearchParams(window.location.search);
  const faithful = isFaithfulMode(params);

  root.innerHTML = `
    <div class="ob-title-bar">
      <div class="ob-title-build">OVERBOUNCE</div>
      <div class="ob-title-bar-right">
        <button type="button" class="ob-title-toggle" data-fullscreen>Fullscreen</button>
        <button type="button" class="ob-title-toggle" data-render>${faithful ? 'Faithful 1999' : 'Modern'}</button>
      </div>
    </div>
    <div class="ob-title-main">
      <div class="ob-title-kicker">A SIDESCROLLING SPEEDRUN GAME</div>
      <div class="ob-title-word">Over<b>bounce</b></div>
      <div class="ob-title-tag">A bug-for-bug port of Quake III Arena movement. No enemies,
        no combat — strafe jumps, circle jumps, rocket jumps, and the eighth-of-a-unit
        window the game is named after.</div>
      <div class="ob-title-actions">
        <button type="button" class="ob-title-btn primary" data-run>Run a course</button>
        <button type="button" class="ob-title-btn secondary" data-load>Load .pk3 assets</button>
      </div>
    </div>
    <div class="ob-title-footer">GPLv2-or-later &middot; not affiliated with id Software or Bethesda Softworks</div>`;
  parent.appendChild(root);

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;

  q<HTMLButtonElement>('[data-fullscreen]').addEventListener('click', () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
    }
  });

  q<HTMLButtonElement>('[data-render]').addEventListener('click', () => {
    const url = new URL(window.location.href);
    applyRenderPreset(url, !isFaithfulMode(new URLSearchParams(url.search)));
    window.location.href = url.toString();
  });

  return new Promise((resolve) => {
    const finish = (choice: TitleChoice): void => {
      root.remove();
      style.remove();
      resolve(choice);
    };
    q<HTMLButtonElement>('[data-run]').addEventListener('click', () => finish('run'));
    q<HTMLButtonElement>('[data-load]').addEventListener('click', () => finish('load'));
  });
}
