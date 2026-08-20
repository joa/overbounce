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
 * Overbounce ships a small amount of its own game content now -- see below --
 * but still asks first, because a player's own Quake III or OpenArena
 * archives always take precedence over what's bundled. Nothing here uploads
 * a file: `File` objects are read locally through Blob slices, same as
 * `pak-ui.ts`.
 *
 * `ob_basics` (the tutorial course, `build-oapak.ts`) and `pak0.pk3` (a
 * player model, the three weapons Overbounce fires, and every pickup with
 * art in it, all OpenArena -- `build-startpak.ts`) are mounted automatically
 * at `PakGroup.Fallback`, the lowest priority. That gives course select at
 * least one playable course with an avatar, sounds and pickups before the
 * player loads anything, and -- because a mounted archive is ranked by
 * group before name (`Pk3FileSystem.reindex`) -- any path a player's own
 * archive also happens to provide wins automatically, with nothing here
 * checking whose file is whose. There used to be a "Use bundled test map"
 * button that skipped straight to a course, bypassing course select
 * entirely; that made the bundled map a special case instead of just
 * another row in the list it now is.
 */

import { Pk3FileSystem, PakGroup } from '../../assets/pk3.js';
import { createShell, createButton } from '../shell.js';
import type { Shell } from '../shell.js';

export interface LoaderResult {
  fs: Pk3FileSystem;
}

/**
 * Served from `public/ob_basics.pk3` (`npm run build-oapak`) and
 * `public/pak0.pk3` (`npm run build-startpak`) -- both OpenArena, both
 * `PakGroup.Fallback`. Their one overlapping path, `scripts/oasky.shader`,
 * comes from the same OA source either way, so it doesn't matter which
 * mounts last.
 */
const BUNDLED_PAKS = ['ob_basics.pk3', 'pak0.pk3'];

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

export function showLoaderScreen(parent: HTMLElement): Promise<LoaderResult> {
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
    <p>Overbounce starts with a small OpenArena kit built in — an avatar, the
    weapons it fires, and most pickups. Drop your own <code>.pk3</code> files here to
    use your own Quake&nbsp;III or OpenArena content instead — a <code>baseq3</code>
    folder, or a single downloaded map — or choose them below. Yours always wins.</p>
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

  const continueBtn = createButton('Continue', 'primary');
  continueBtn.style.display = 'none';
  shell.footerRight.appendChild(continueBtn);

  const fs = new Pk3FileSystem();

  return new Promise((resolve) => {
    const finish = (value: LoaderResult): void => {
      shell.dispose();
      resolve(value);
    };

    continueBtn.addEventListener('click', () => {
      if (fs.listMaps().length) {
        finish({ fs });
      }
    });

    const refresh = (): void => {
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
      status.textContent = maps.length
        ? `${fs.fileCount} files across ${fs.mounted.length} archive${fs.mounted.length === 1 ? '' : 's'}` +
          ` — ${maps.length} map${maps.length === 1 ? '' : 's'}.`
        : '';
      status.classList.remove('err');
      continueBtn.style.display = maps.length ? '' : 'none';
    };

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

      refresh();
      if (!fs.listMaps().length) {
        status.textContent =
          failed === files.length
            ? 'None of those could be read as .pk3 archives.'
            : 'Those archives contain no maps. Include the pak with maps/ in it.';
        status.classList.add('err');
      }
    };

    // Bundled content, so the list is never empty for a player who hasn't
    // loaded anything yet -- see the file header. Each mounts independently
    // and failure is silent per file (fetch 404, the build script that
    // produces it never run): the player still has their own archives to
    // fall back to, and one missing bundled pak shouldn't block the other.
    for (const pak of BUNDLED_PAKS) {
      void (async (): Promise<void> => {
        try {
          const res = await fetch(`/${pak}`);
          if (!res.ok) {
            return;
          }
          await fs.mount(pak, await res.blob(), PakGroup.Fallback);
          refresh();
        } catch (err) {
          console.warn(`[overbounce] ${pak}: ${(err as Error).message}`);
        }
      })();
    }

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
