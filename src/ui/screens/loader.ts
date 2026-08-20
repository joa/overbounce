/**
 * The asset loader, as a screen -- not the modal `pak-ui.ts` still is.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `design/HANDOFF.md`: "The loader is a screen, not a modal, reached only
 * from *Load .pk3 assets*. Course select carries its own drop region so
 * adding a map never routes through it." This is that screen (`3a`/`3b`).
 *
 * Unlike `pak-ui.ts`, mounting and map-picking are separate steps: this
 * screen only mounts archives into a `Pk3FileSystem` and hands it off:
 * course select is where a map is actually chosen. That split is the
 * design's, not an accident of reuse -- `pak-ui.ts`'s modal combined both
 * because it had nowhere else to send a mounted filesystem.
 *
 * Overbounce ships no game content. Nothing here uploads a file: `File`
 * objects are read locally through Blob slices, same as `pak-ui.ts`.
 */

import { Pk3FileSystem } from '../../assets/pk3.js';
import { createShell, createButton } from '../shell.js';
import type { Shell } from '../shell.js';

export type LoaderResult = { fs: Pk3FileSystem } | { fallbackMap: string };

const STYLE = `
.ob-loader-drop { flex: 1; min-height: 0; display: flex; flex-direction: column;
  gap: 14px; }
.ob-loader-drop > .ob-btn { align-self: flex-start; }
.ob-loader-zone { flex: 1; min-height: 160px; border: 1px dashed var(--ob-control-hover);
  border-radius: 6px; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 10px; text-align: center; padding: 24px;
  transition: border-color 120ms, background 120ms; }
.ob-loader-zone.dragging { border-color: var(--ob-accent); background: rgba(232,98,42,.06); }
.ob-loader-zone p { max-width: 52ch; color: var(--ob-dim); font: 400 13px/1.6 var(--ob-font-display); }
.ob-loader-zone .note { font: 400 10px/1 var(--ob-font-mono); letter-spacing: .1em;
  color: var(--ob-unavailable); text-transform: uppercase; }
.ob-loader-status { font: 400 12px/1.5 var(--ob-font-mono); color: var(--ob-dim); min-height: 1.5em; }
.ob-loader-status.err { color: #ff6b6b; }
.ob-loader-list { display: flex; flex-direction: column; gap: 6px; max-height: 30vh;
  overflow: auto; }
.ob-loader-row { display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border: 1px solid var(--ob-seam); border-radius: 4px;
  background: var(--ob-panel-alt-2); font: 400 12px/1 var(--ob-font-mono); color: var(--ob-text-secondary); }
.ob-loader-row .name { color: var(--ob-text); }
.ob-loader-row .ok { color: #7ee081; }
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

export function showLoaderScreen(
  parent: HTMLElement,
  options: { fallbackMaps?: readonly string[] } = {},
): Promise<LoaderResult> {
  installStyle();

  const shell: Shell = createShell(parent, {
    sectionLabel: 'ASSETS',
    items: [
      { id: 'archives', label: 'Archives' },
      { id: 'maps', label: 'Maps' },
      { id: 'player', label: 'Player model' },
    ],
    activeId: 'archives',
    railNote: 'files are read locally in slices — nothing is uploaded or copied',
    title: 'Archives',
    status: 'NOTHING LEAVES YOUR MACHINE',
  });

  const zone = document.createElement('div');
  zone.className = 'ob-loader-zone';
  zone.innerHTML = `
    <p>Overbounce ships no game content. Drop your own <code>.pk3</code> files here —
    a Quake&nbsp;III <code>baseq3</code> folder, OpenArena, or a single downloaded map —
    or choose them below. Maps, models, textures and sounds are read directly from them.</p>
    <div class="note">.pk3 or .zip · several at once</div>`;

  const chooseBtn = createButton('Choose files', 'ghost');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.pk3,.zip';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  chooseBtn.addEventListener('click', () => fileInput.click());

  const status = document.createElement('div');
  status.className = 'ob-loader-status';

  const list = document.createElement('div');
  list.className = 'ob-loader-list';

  const dropCard = document.createElement('div');
  dropCard.className = 'ob-loader-drop';
  dropCard.append(zone, chooseBtn, fileInput, status, list);
  shell.body.appendChild(dropCard);

  const skipBtn = createButton('Use bundled test map', 'ghost');
  if (!options.fallbackMaps?.length) {
    skipBtn.style.display = 'none';
  }
  const continueBtn = createButton('Continue', 'primary');
  continueBtn.style.display = 'none';
  shell.footerLeft.appendChild(skipBtn);
  shell.footerRight.appendChild(continueBtn);

  const fs = new Pk3FileSystem();

  return new Promise((resolve) => {
    const finish = (value: LoaderResult): void => {
      shell.dispose();
      resolve(value);
    };

    skipBtn.addEventListener('click', () => {
      const first = options.fallbackMaps?.[0];
      if (first) {
        finish({ fallbackMap: first });
      }
    });

    continueBtn.addEventListener('click', () => {
      if (fs.listMaps().length) {
        finish({ fs });
      }
    });

    const mount = async (files: readonly File[]): Promise<void> => {
      if (!files.length) {
        return;
      }
      status.textContent = `Reading ${files.length} archive${files.length === 1 ? '' : 's'}...`;
      status.classList.remove('err');

      let failed = 0;
      for (const file of files) {
        try {
          await fs.mount(file.name, file);
        } catch (err) {
          failed++;
          console.warn(`[overbounce] ${file.name}: ${(err as Error).message}`);
        }
      }

      list.innerHTML = '';
      for (const pak of fs.mounted) {
        const row = document.createElement('div');
        row.className = 'ob-loader-row';
        const name = document.createElement('span');
        name.className = 'name';
        // Archive names come from the player's own File objects -- local
        // filenames, not map-embedded text, but textContent regardless.
        name.textContent = pak.name;
        const ok = document.createElement('span');
        ok.className = 'ok';
        ok.textContent = 'ok';
        row.append(name, ok);
        list.appendChild(row);
      }

      const maps = fs.listMaps();
      if (!maps.length) {
        status.textContent =
          failed === files.length
            ? 'None of those could be read as .pk3 archives.'
            : 'Those archives contain no maps. Include the pak with maps/ in it.';
        status.classList.add('err');
        continueBtn.style.display = 'none';
        return;
      }

      status.textContent =
        `${fs.fileCount} files across ${fs.mounted.length} archive${fs.mounted.length === 1 ? '' : 's'}` +
        ` — ${maps.length} map${maps.length === 1 ? '' : 's'}.`;
      continueBtn.style.display = '';
    };

    fileInput.addEventListener('change', () => {
      void mount(Array.from(fileInput.files ?? []));
    });

    // The design's own addition over pak-ui.ts's modal: the whole screen is
    // a drop target, not just a file-picker button.
    for (const ev of ['dragenter', 'dragover']) {
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.add('dragging');
      });
    }
    for (const ev of ['dragleave', 'dragend']) {
      zone.addEventListener(ev, () => zone.classList.remove('dragging'));
    }
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragging');
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      void mount(dropped);
    });
  });
}
