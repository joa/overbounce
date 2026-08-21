/**
 * The course-load loading screen.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `course-select.ts` already gates its own "Start run" button on the bundled
 * kit finishing (R8's fix for the actual bug this was built to close: a run
 * starting before pak0.pk3 finished mounting loaded a world with no player,
 * weapon or item models at all). This covers the gap AFTER that click --
 * `runCourse` (`main.ts`) still has to parse the BSP, build the world mesh
 * and compile shaders before the first frame renders, which for a large real
 * map is not instant, and until now nothing was shown for it at all.
 *
 * Not a `Promise`-returning screen like its siblings in this directory --
 * nothing here waits on user input. The caller shows it right before calling
 * `runCourse` and disposes it once that call resolves, which is the exact
 * point this project's own doc comment on `runCourse` already calls
 * "the game is playing and rendering it".
 */

import '../tokens.css';

const STYLE = `
.ob-loading { position: fixed; inset: 0; z-index: 6; background: var(--ob-background);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 20px; }
.ob-loading-spinner { width: 36px; height: 36px; border-radius: 50%;
  border: 3px solid var(--ob-control); border-top-color: var(--ob-accent);
  animation: ob-loading-spin 800ms linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .ob-loading-spinner { animation: none; border-top-color: var(--ob-control); }
}
@keyframes ob-loading-spin { to { transform: rotate(360deg); } }
.ob-loading-text { font: 400 13px/1 var(--ob-font-mono); letter-spacing: .1em;
  text-transform: uppercase; color: var(--ob-dim); }
.ob-loading-text b { color: var(--ob-text-secondary); font-weight: 500; }
`;

let styleInstalled = false;
function installStyle(): void {
  if (styleInstalled) {
    return;
  }
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  styleInstalled = true;
}

export interface LoadingScreen {
  dispose(): void;
}

/**
 * `mapName` is a `.bsp` basename (course-select's own `row.mapName`), not
 * map-author free text -- but it still comes out of a mounted pak's file
 * listing, so it goes through `textContent`, not template-string `innerHTML`,
 * on the same "untrusted until proven otherwise" footing every other piece
 * of pak-derived text on this screen already stands on.
 */
export function showLoadingScreen(mapName: string): LoadingScreen {
  installStyle();

  const root = document.createElement('div');
  root.className = 'ob-loading';

  const spinner = document.createElement('div');
  spinner.className = 'ob-loading-spinner';

  const text = document.createElement('div');
  text.className = 'ob-loading-text';
  text.append('Loading ');
  const name = document.createElement('b');
  name.textContent = mapName;
  text.append(name, '…');

  root.append(spinner, text);
  document.body.appendChild(root);

  return {
    dispose(): void {
      root.remove();
    },
  };
}
