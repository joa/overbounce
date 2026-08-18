/**
 * The .pk3 picker: how a player brings their own Quake 3 assets.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Overbounce ships no game content, so the first thing it asks for is the
 * player's own paks. Point it at a Quake III `baseq3` folder, an OpenArena
 * install, or a single downloaded defrag map, and it reads the maps, models,
 * textures and sounds straight out of the archives.
 *
 * Nothing is uploaded. `File` objects are read locally through Blob slices, so
 * even a 457MB pak0.pk3 is only ever touched a few hundred KB at a time.
 */

import { Pk3FileSystem } from '../assets/pk3.js';

export interface PakSelection {
  fs: Pk3FileSystem;
  mapName: string;
}

const STYLE = `
.ob-pak { position:fixed; inset:0; display:grid; place-items:center;
  background:rgba(12,12,16,.92); z-index:10;
  font: 500 13px/1.6 ui-monospace,"Cascadia Mono",Menlo,Consolas,monospace;
  color:#c8c8d2; }
.ob-pak-box { width:min(560px,92vw); max-height:86vh; display:flex;
  flex-direction:column; gap:14px; padding:26px 28px; border:1px solid #2a2a34;
  border-radius:10px; background:#15151b; }
.ob-pak h1 { font-size:16px; color:#e8e8ec; font-weight:600; }
.ob-pak p { color:#8a8a96; font-size:12px; }
.ob-pak .row { display:flex; gap:10px; flex-wrap:wrap; }
.ob-pak button, .ob-pak label.file { cursor:pointer; padding:9px 15px;
  border:1px solid #33333f; border-radius:6px; background:#1e1e26; color:#e8e8ec;
  font:inherit; }
.ob-pak button:hover, .ob-pak label.file:hover { background:#262630; }
.ob-pak button.ghost { background:transparent; color:#8a8a96; }
.ob-pak input[type=file] { display:none; }
.ob-pak .status { font-size:12px; color:#7ee081; min-height:1.6em; }
.ob-pak .status.err { color:#ff6b6b; }
.ob-pak .maps { overflow:auto; border:1px solid #24242e; border-radius:6px;
  max-height:44vh; }
.ob-pak .maps button { display:block; width:100%; text-align:left; border:0;
  border-radius:0; background:transparent; padding:7px 12px; }
.ob-pak .maps button:hover { background:#23232c; }
.ob-pak .hidden { display:none; }
`;

export function showPakPicker(
  parent: HTMLElement,
  options: { fallbackMaps?: string[] } = {},
): Promise<PakSelection | { fallbackMap: string }> {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'ob-pak';
  root.innerHTML = `
    <div class="ob-pak-box">
      <h1>Load your Quake&nbsp;III assets</h1>
      <p>
        Overbounce ships no game content. Choose your own <code>.pk3</code>
        files &mdash; a Quake&nbsp;III <code>baseq3</code> folder, OpenArena, or a
        single downloaded map. Maps, models, textures and sounds are read
        directly from them. Nothing leaves your machine.
      </p>
      <div class="row">
        <label class="file">
          Choose .pk3 files
          <input type="file" accept=".pk3,.zip" multiple data-files />
        </label>
        <button class="ghost" data-skip>Use bundled test map</button>
      </div>
      <div class="status" data-status></div>
      <div class="maps hidden" data-maps></div>
    </div>`;
  parent.appendChild(root);

  const q = <T extends HTMLElement>(s: string): T => root.querySelector(s) as T;
  const input = q<HTMLInputElement>('[data-files]');
  const status = q<HTMLElement>('[data-status]');
  const mapList = q<HTMLElement>('[data-maps]');
  const skip = q<HTMLButtonElement>('[data-skip]');

  if (!options.fallbackMaps?.length) {
    skip.classList.add('hidden');
  }

  return new Promise((resolve) => {
    const finish = (value: PakSelection | { fallbackMap: string }): void => {
      root.remove();
      style.remove();
      resolve(value);
    };

    const say = (text: string, isError = false): void => {
      status.textContent = text;
      status.classList.toggle('err', isError);
    };

    skip.addEventListener('click', () => {
      const first = options.fallbackMaps?.[0];
      if (first) {
        finish({ fallbackMap: first });
      }
    });

    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) {
        return;
      }

      void (async () => {
        const fs = new Pk3FileSystem();
        say(`Reading ${files.length} archive${files.length === 1 ? '' : 's'}...`);

        let failed = 0;
        for (const file of files) {
          try {
            await fs.mount(file.name, file);
          } catch (err) {
            failed++;
            console.warn(`[overbounce] ${file.name}: ${(err as Error).message}`);
          }
        }

        const maps = fs.listMaps();
        if (!maps.length) {
          say(
            failed === files.length
              ? 'None of those could be read as .pk3 archives.'
              : 'Those archives contain no maps. Include the pak with maps/ in it.',
            true,
          );
          return;
        }

        say(
          `${fs.fileCount} files across ${fs.mounted.length} archive${
            fs.mounted.length === 1 ? '' : 's'
          } — ${maps.length} map${maps.length === 1 ? '' : 's'}. Pick one:`,
        );

        mapList.innerHTML = '';
        mapList.classList.remove('hidden');
        for (const name of maps) {
          const b = document.createElement('button');
          b.textContent = name;
          b.addEventListener('click', () => finish({ fs, mapName: name }));
          mapList.appendChild(b);
        }
      })();
    });
  });
}
