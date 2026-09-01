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
 * The mockup's 4-button list (`1e`) is trimmed to two here: "Learn the
 * movement" (the lesson flow, `HANDOFF.md`'s own "not designed yet" list)
 * stays out because it isn't built, and "Load .pk3 assets" is gone as a
 * separate destination now that course select carries its own drop/browse
 * section (`course-select.ts`) -- there is no longer a reason to detour
 * through a dedicated screen before seeing any courses.
 *
 * The LIFETIME panel IS wired to real data now (`RecordBook.lifetimeStats`
 * for attempts/playtime/deaths/max speed/maps played, `game/lifetime.ts`'s
 * own store for distance/jumps/overbounces/rockets, which nothing else
 * tracks). A fresh install renders honest zeros, not the mockup's own
 * placeholder numbers -- see both files' own docs for exactly what each
 * figure means and how it's measured.
 *
 * The backdrop is a static image, not a live-rendered map -- see
 * `.agent/plans/UI.md`'s title-screen trap: at this point in the flow no
 * assets are mounted yet, so there is nothing to render behind the menu.
 * `public/backdrop.jpg` (a re-encode of the design reference,
 * `design/refs/backdrop.png` -- JPEG because it is heavily blurred and
 * darkened in CSS anyway, so the PNG's lossless weight bought nothing here)
 * sits behind the content, blurred and darkened per the mockup so it reads
 * as atmosphere rather than something the eye tries to focus on.
 */

import '../tokens.css';
import { isFaithfulMode, applyRenderPreset, FAITHFUL_QUERY } from '../render-preset.js';
import { LocalSettingsStore, stripUrlParam } from '../local-settings.js';
import { createSegmentedControl } from '../shell.js';
import { formatDistance } from '../units.js';
import { RecordBook } from '../../game/records.js';
import { LifetimeStats } from '../../game/lifetime.js';

export type TitleChoice = 'run' | 'settings';

const STYLE = `
.ob-title { position: fixed; inset: 0; z-index: 5; background: var(--ob-background);
  color: var(--ob-text); font-family: var(--ob-font-display); display: flex;
  flex-direction: column; }
/* Out of flow (absolute inside .ob-title's own fixed box), so these sit
 * behind the flex column of real content below without taking part in it.
 * z-index: -1 is load-bearing, not decorative: .ob-title-bar/-main/-footer
 * are ordinary static flex children, and CSS paints ALL positioned
 * descendants of a stacking context above ALL static ones regardless of DOM
 * order -- an absolutely positioned div earlier in the markup still paints
 * over later static content, not under it. Without the negative z-index
 * here (scoped by .ob-title's own z-index: 5, so it cannot escape behind
 * anything outside this screen), the backdrop and scrim blacked out the
 * entire menu instead of sitting behind it. Scale compensates for blur's
 * edge softening -- without it, a 6px blur would show a faint lighter
 * fringe where the image meets its own edge. */
.ob-title-backdrop { position: absolute; inset: 0; z-index: -1; background: url('/backdrop.jpg') center/cover no-repeat;
  filter: blur(6px) saturate(.5) brightness(.42); transform: scale(1.06); }
.ob-title-scrim { position: absolute; inset: 0; z-index: -1;
  background: linear-gradient(100deg, rgba(11,11,14,.97) 0%, rgba(11,11,14,.88) 46%, rgba(11,11,14,.35) 100%); }
.ob-title-bar { height: 52px; flex: none; display: flex; align-items: center;
  justify-content: space-between; padding: 0 26px; border-bottom: 1px solid var(--ob-seam); }
.ob-title-build { font: 400 11px/1 var(--ob-font-mono); letter-spacing: .2em; color: var(--ob-dim); }
.ob-title-bar-right { display: flex; gap: 8px; align-items: center; }
.ob-title-toggle { display: flex; align-items: center; gap: 7px; padding: 6px 11px;
  border: 1px solid var(--ob-control); border-radius: 4px; cursor: pointer; background: transparent;
  color: var(--ob-text-secondary); font: 400 11px/1 var(--ob-font-mono); letter-spacing: .1em;
  text-transform: uppercase; }
.ob-title-toggle:hover { border-color: var(--ob-control-hover); }
.ob-title-toggle-box { width: 11px; height: 11px; flex: none; border: 1.5px solid var(--ob-dim);
  border-radius: 1px; }
.ob-title-toggle-hint { font: 400 10px/1 var(--ob-font-mono); color: var(--ob-dim); }
.ob-title-source { margin-top: 24px; display: flex; align-items: center; gap: 8px;
  width: fit-content; font: 400 12px/1 var(--ob-font-mono); letter-spacing: .1em;
  text-transform: uppercase; color: var(--ob-dim); text-decoration: none; }
.ob-title-source:hover { color: var(--ob-text-secondary); }
.ob-title-render { display: flex; align-items: center; gap: 8px; }
.ob-title-render-label { font: 400 11px/1 var(--ob-font-mono); letter-spacing: .14em; color: var(--ob-dim); }

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

.ob-title-lifetime { position: absolute; right: 56px; top: 0; bottom: 0; width: 300px;
  display: flex; flex-direction: column; justify-content: center; gap: 22px; }
.ob-title-lifetime-label { font: 400 10px/1 var(--ob-font-mono); letter-spacing: .28em; color: #5a5a66; }
.ob-title-lifetime-rows { display: flex; flex-direction: column; gap: 16px; }
.ob-title-lifetime-row { display: flex; align-items: baseline; justify-content: space-between;
  padding-bottom: 14px; border-bottom: 1px solid rgba(58,58,70,.4); }
.ob-title-lifetime-row:last-child { padding-bottom: 0; border-bottom: none; }
.ob-title-lifetime-key { font: 400 12px/1 var(--ob-font-display); letter-spacing: .03em; color: var(--ob-dim); }
.ob-title-lifetime-val { font: 600 17px/1 var(--ob-font-mono); color: var(--ob-text); }
.ob-title-lifetime-minor { margin-top: 6px; display: flex; gap: 18px; font: 400 10px/1 var(--ob-font-mono);
  letter-spacing: .04em; color: var(--ob-unavailable); }
`;

/** `RecordBook.lifetimeStats()`'s deaths + `game/lifetime.ts`'s own live-session read. */
function formatPlaytime(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function showTitleScreen(parent: HTMLElement): Promise<TitleChoice> {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'ob-title';

  // The merged view -- storage filled in, a URL value overriding it -- so
  // this label agrees with whatever Settings' Display panel would show, and
  // does not read Modern just because the URL that happened to load this
  // page did not carry the recipe's params. See `local-settings.ts`.
  const settings = new LocalSettingsStore();
  const params = settings.withDefaults(new URLSearchParams(window.location.search));
  const faithful = isFaithfulMode(params);

  const career = new RecordBook().lifetimeStats();
  const lifetime = new LifetimeStats().read();

  root.innerHTML = `
    <div class="ob-title-backdrop"></div>
    <div class="ob-title-scrim"></div>
    <div class="ob-title-bar">
      <div class="ob-title-build">OVERBOUNCE</div>
      <div class="ob-title-bar-right">
        <button type="button" class="ob-title-toggle" data-fullscreen><span class="ob-title-toggle-box"></span>Fullscreen<span class="ob-title-toggle-hint">F11</span></button>
        <div class="ob-title-render">
          <span class="ob-title-render-label">RENDER</span>
          <span data-render></span>
        </div>
      </div>
    </div>
    <div class="ob-title-main">
      <div class="ob-title-kicker">A SIDESCROLLING SPEEDRUN GAME</div>
      <div class="ob-title-word">Over<b>bounce</b></div>
      <div class="ob-title-tag">A bug-for-bug port of Quake III Arena movement. No enemies,
        no combat — strafe jumps, circle jumps, rocket jumps, and the eighth-of-a-unit
        window the game is named after.</div>
      <div class="ob-title-actions">
        <button type="button" class="ob-title-btn primary ob-cta-pulse" data-run>Run a course</button>
        <button type="button" class="ob-title-btn secondary" data-settings>Settings</button>
      </div>
      <a class="ob-title-source" href="https://github.com/joa/overbounce" target="_blank" rel="noopener">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>
        Open source</a>
    </div>
    <div class="ob-title-lifetime">
      <div class="ob-title-lifetime-label">LIFETIME</div>
      <div class="ob-title-lifetime-rows">
        <div class="ob-title-lifetime-row"><span class="ob-title-lifetime-key">Total attempts</span><span class="ob-title-lifetime-val">${career.attempts.toLocaleString()}</span></div>
        <div class="ob-title-lifetime-row"><span class="ob-title-lifetime-key">Playtime</span><span class="ob-title-lifetime-val">${formatPlaytime(career.playtimeMs)}</span></div>
        <div class="ob-title-lifetime-row"><span class="ob-title-lifetime-key">Distance covered</span><span class="ob-title-lifetime-val">${formatDistance(lifetime.distanceUnits, navigator.language)}</span></div>
        <div class="ob-title-lifetime-row"><span class="ob-title-lifetime-key">Max speed</span><span class="ob-title-lifetime-val">${Math.round(career.maxSpeed).toLocaleString()} u/s</span></div>
        <div class="ob-title-lifetime-row"><span class="ob-title-lifetime-key">Maps played</span><span class="ob-title-lifetime-val">${career.mapsCompleted} / ${career.mapsStarted}</span></div>
      </div>
      <div class="ob-title-lifetime-minor">
        <span>${lifetime.jumps.toLocaleString()} jumps</span><span>${lifetime.overbounces.toLocaleString()} OBs</span><span>${lifetime.rockets.toLocaleString()} rockets</span><span>${career.deaths.toLocaleString()} deaths</span>
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

  // The MODERN/FAITHFUL 1999 segmented control (`1e`) -- a two-way switch,
  // not Settings' three-way Modern/Faithful/Custom (R7, Phase 6): Custom only
  // means something once individual effects have been touched, which this
  // screen has no controls for. A page that arrives already Custom (Settings
  // was used earlier) reads as whichever side `isFaithfulMode` says --
  // exactly `renderMovement`'s Physics/Camera pattern of "informational
  // without full context," not a third segment invented for symmetry.
  const renderSlot = q<HTMLElement>('[data-render]');
  renderSlot.replaceWith(
    createSegmentedControl(
      [
        { id: 'modern', label: 'MODERN' },
        { id: 'faithful', label: 'FAITHFUL 1999' },
      ],
      faithful ? 'faithful' : 'modern',
      (id) => {
        // No reload (R8) -- nothing is running yet at the title screen to
        // apply this to, so a storage write is the whole of what "changing"
        // this preset means here. `?map=`/`?devpak=` (a direct dev-path
        // load) DOES render immediately after this screen, which is exactly
        // why storage, not the URL, is what carries the choice forward --
        // see `local-settings.ts`.
        applyRenderPreset(settings, id === 'faithful');
        for (const pair of FAITHFUL_QUERY.split('&')) {
          stripUrlParam(pair.split('=')[0]);
        }
      },
    ),
  );

  return new Promise((resolve) => {
    const finish = (choice: TitleChoice): void => {
      root.remove();
      style.remove();
      resolve(choice);
    };
    q<HTMLButtonElement>('[data-run]').addEventListener('click', () => finish('run'));
    q<HTMLButtonElement>('[data-settings]').addEventListener('click', () => finish('settings'));
  });
}
