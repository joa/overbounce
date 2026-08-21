/**
 * Course select -- "Run a course" (`1g`).
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Lists every map in the mounted `Pk3FileSystem`, using `course-info.ts` and
 * `course-scan.ts` for the physics/timed/checkpoint facts `1g`'s card row
 * needs before any of them has been played. Levelshot previews and the
 * Tutorial/Strafe/Overbounce/Rocket rail collections are not built -- see
 * `.agent/plans/UI.md`'s Phase 3 section for why (no source for either yet).
 * This is a single "All courses" list, matching the data that IS available
 * rather than a fuller layout with placeholders standing in for what isn't.
 *
 * This screen owns its own `.pk3` mounting -- there is no separate loader
 * screen anymore (`loader.ts` is gone; `HANDOFF.md`'s "course select carries
 * its own drop region so adding a map never routes through it" is now simply
 * true instead of a documented gap, see `.agent/plans/UI.md`'s Phase 3
 * section). `appFlow` (`main.ts`) hands this an empty `Pk3FileSystem` on
 * first open; this file mounts `ob_basics.pk3`/`pak0.pk3` (the bundled
 * OpenArena kit, `PakGroup.Fallback`) into it automatically, once, and the
 * drop/browse section below lets a player add their own archives -- which
 * outrank the bundled kit automatically, same guarantee `loader.ts` used to
 * carry (`Pk3FileSystem.reindex` ranks by group before name). Because
 * `appFlow` reuses one `fs` across course switches, `bundledMounted` guards
 * the auto-mount so returning to this screen after a run doesn't refetch and
 * remount the same two archives.
 */

import { loadCourseMetadata } from '../../assets/course-info.js';
import { scanCourseSummary } from '../../game/course-scan.js';
import { PreferenceStore } from '../../game/preferences.js';
import { PakGroup } from '../../assets/pk3.js';
import type { Pk3FileSystem } from '../../assets/pk3.js';
import { createShell, createButton, createSegmentedControl } from '../shell.js';
import type { Shell } from '../shell.js';
import { showSettingsScreen } from './settings.js';
import { renderQ3Text } from '../../render/q3-colors.js';

export interface CourseChoice {
  mapName: string;
  physics: 'vq3' | 'cpm';
  camera: 'auto' | 'chase' | 'side' | 'fpv';
}

interface CourseRow {
  mapName: string;
  longname: string | null;
  declaredPhysics: 'vq3' | 'cpm' | 'both' | null;
  timed: boolean;
  checkpoints: number;
  /** Whether `scripts/<mapName>.cam` exists -- see `resolveAutoCamera`. */
  hasCameraScript: boolean;
}

/**
 * Served from `public/ob_basics.pk3` (`npm run build-oapak`) and
 * `public/pak0.pk3` (`npm run build-startpak`) -- both OpenArena, both
 * mounted at `PakGroup.Fallback`. Their one overlapping path,
 * `scripts/oasky.shader`, comes from the same OA source either way, so it
 * doesn't matter which mounts last.
 */
const BUNDLED_PAKS = ['ob_basics.pk3', 'pak0.pk3'];

/**
 * One entry per `Pk3FileSystem` that has already had the bundled kit mounted
 * into it -- `appFlow` (`main.ts`) reuses the same instance across course
 * switches, and this screen is shown again every time a run ends, so without
 * this the bundled archives would be re-fetched and re-mounted on every
 * return to course select.
 */
const bundledMounted = new WeakSet<Pk3FileSystem>();

const STYLE = `
.ob-course-list { flex: 1; min-height: 0; overflow: auto; display: flex;
  flex-direction: column; gap: 8px; }
.ob-course-row { display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 14px 16px; border: 1px solid var(--ob-seam); border-radius: 5px;
  background: var(--ob-panel); cursor: pointer; text-align: left; width: 100%;
  font: inherit; color: inherit; }
.ob-course-row:hover { border-color: var(--ob-control-hover); }
.ob-course-row.active { border-color: var(--ob-accent); background: rgba(232,98,42,.08); }
.ob-course-row .name { font: 600 17px/1 var(--ob-font-display); letter-spacing: .02em; }
.ob-course-row .sub { margin-top: 4px; font: 400 11px/1 var(--ob-font-mono); letter-spacing: .04em;
  color: var(--ob-dim); }
.ob-course-row .badges { display: flex; gap: 8px; align-items: center; flex: none; }
.ob-course-badge { padding: 3px 8px; border-radius: 3px; font: 400 10px/1 var(--ob-font-mono);
  letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--ob-control); color: var(--ob-dim); }
.ob-course-badge.timed { border-color: rgba(232,98,42,.5); color: var(--ob-accent); }
.ob-course-empty { padding: 40px; text-align: center; color: var(--ob-dim);
  font: 400 14px/1.5 var(--ob-font-display); }

.ob-course-detail { display: flex; align-items: center; justify-content: space-between;
  gap: 20px; }
.ob-course-detail .picks { display: flex; gap: 20px; align-items: center; }
.ob-course-detail .pick { display: flex; align-items: center; gap: 10px; }
.ob-course-detail .pick span { font: 400 12px/1 var(--ob-font-mono); letter-spacing: .08em;
  color: var(--ob-dim); text-transform: uppercase; }

.ob-course-drop { flex: none; border: 1px dashed var(--ob-control-hover); border-radius: 6px;
  padding: 14px 16px; display: flex; align-items: center; justify-content: space-between;
  gap: 16px; cursor: pointer; transition: border-color 120ms, background 120ms; }
.ob-course-drop:hover, .ob-course-drop.dragging { border-color: var(--ob-accent);
  background: rgba(232,98,42,.06); }
.ob-course-drop p { font: 400 13px/1.5 var(--ob-font-display); color: var(--ob-dim); }
.ob-course-drop p b { color: var(--ob-text-secondary); font-weight: 500; }
.ob-course-drop-status { flex: none; font: 400 11px/1.5 var(--ob-font-mono); color: var(--ob-dim);
  text-align: right; max-width: 26ch; }
.ob-course-drop-status.err { color: #ff6b6b; }
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

/** AUTO resolves to the map's own declaration; `both` prefers VQ3, which carries the fidelity guarantee. */
function resolveAutoPhysics(declared: CourseRow['declaredPhysics']): 'vq3' | 'cpm' {
  return declared === 'cpm' ? 'cpm' : 'vq3';
}

/**
 * AUTO resolves to `side` when the map ships its own `scripts/<mapName>.cam` --
 * see `.agent/plans/SIDE-CAMERA.md`. A map declaring a camera script is a map
 * declaring itself side-view; a map without one keeps today's `auto` (which
 * `main.ts` defaults to `chase`), same as a physics-undeclared map keeps VQ3
 * only through `resolveAutoPhysics`, never through this function reaching in.
 */
function resolveAutoCamera(hasCameraScript: boolean): CourseChoice['camera'] {
  return hasCameraScript ? 'side' : 'auto';
}

export async function showCourseSelectScreen(
  parent: HTMLElement,
  fs: Pk3FileSystem,
): Promise<CourseChoice> {
  installStyle();

  /** Re-run after every mount so a newly-added archive's maps show up. */
  const scanRows = async (): Promise<CourseRow[]> => {
    const mapNames = fs.listMaps();
    return Promise.all(
      mapNames.map(async (mapName) => {
        const [meta, summary, camScript] = await Promise.all([
          loadCourseMetadata(fs, mapName),
          scanCourseSummary(fs, mapName),
          fs.readText(`scripts/${mapName}.cam`),
        ]);
        return {
          mapName,
          longname: meta.longname,
          declaredPhysics: meta.physics,
          timed: summary?.timed ?? false,
          checkpoints: summary?.checkpoints ?? 0,
          hasCameraScript: camScript !== null,
        };
      }),
    );
  };

  let rows: CourseRow[] = await scanRows();

  const shell: Shell = createShell(parent, {
    sectionLabel: 'COLLECTIONS',
    items: [{ id: 'all', label: 'All courses', count: String(rows.length) }],
    activeId: 'all',
    title: 'All courses',
    status: `${rows.length} map${rows.length === 1 ? '' : 's'}`,
  });

  const list = document.createElement('div');
  list.className = 'ob-course-list';
  shell.body.appendChild(list);

  // The drop/browse section -- see the file header. A persistent element,
  // never rebuilt by renderRows(), so a drag in progress across a refresh
  // isn't yanked out from under the pointer.
  const drop = document.createElement('div');
  drop.className = 'ob-course-drop';
  const dropText = document.createElement('p');
  dropText.append('Drop a ');
  const dropEmphasis = document.createElement('b');
  dropEmphasis.textContent = '.pk3';
  dropText.append(
    dropEmphasis,
    ' here to add courses — a Quake III baseq3 folder, OpenArena, or a single ' +
      'downloaded map — or click to browse. Your own archives always outrank the bundled kit.',
  );
  const dropStatus = document.createElement('div');
  dropStatus.className = 'ob-course-drop-status';
  drop.append(dropText, dropStatus);
  shell.body.appendChild(drop);

  const dropInput = document.createElement('input');
  dropInput.type = 'file';
  dropInput.accept = '.pk3,.zip';
  dropInput.multiple = true;
  dropInput.style.display = 'none';
  drop.appendChild(dropInput);

  // R7: "the override is remembered per map, not globally" -- the same
  // store Settings' Movement panel reads and writes. AUTO/VQ3/CPM below
  // aren't a fresh choice every visit; a map opened before comes back with
  // whatever it was left on.
  const prefs = new PreferenceStore();
  const overrideOf = (
    mapName: string,
  ): { physics: 'auto' | 'vq3' | 'cpm'; camera: 'auto' | 'chase' | 'side' | 'fpv' } => {
    const o = prefs.get(mapName);
    return { physics: o.physics ?? 'auto', camera: o.camera ?? 'auto' };
  };

  let selected: CourseRow | null = rows[0] ?? null;
  let { physics, camera } = selected ? overrideOf(selected.mapName) : { physics: 'auto' as const, camera: 'auto' as const };

  const detail = document.createElement('div');
  detail.className = 'ob-course-detail';
  shell.body.appendChild(detail);

  const settingsBtn = createButton('Settings', 'ghost');
  shell.footerLeft.appendChild(settingsBtn);
  const startBtn = createButton('Start run', 'primary');
  shell.footerRight.appendChild(startBtn);

  const renderRows = (): void => {
    list.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'ob-course-empty';
      empty.textContent = 'No maps in the mounted archives yet.';
      list.appendChild(empty);
    }
    for (const row of rows) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'ob-course-row';
      el.classList.toggle('active', row === selected);

      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      // Map/author-supplied text (.arena/.defi longname) -- authors
      // routinely colour these (`^1Q3DM6^7: Campgrounds`), and `renderQ3Text`
      // still never touches `innerHTML`: one text node/span per colour run.
      renderQ3Text(name, row.longname ?? row.mapName);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = row.mapName;
      left.append(name, sub);

      const badges = document.createElement('div');
      badges.className = 'badges';
      if (row.timed) {
        const timed = document.createElement('span');
        timed.className = 'ob-course-badge timed';
        timed.textContent = `TIMED · ${row.checkpoints} cp`;
        badges.appendChild(timed);
      } else {
        const freerun = document.createElement('span');
        freerun.className = 'ob-course-badge';
        freerun.textContent = 'FREERUN';
        badges.appendChild(freerun);
      }
      if (row.declaredPhysics) {
        const phys = document.createElement('span');
        phys.className = 'ob-course-badge';
        phys.textContent = row.declaredPhysics.toUpperCase();
        badges.appendChild(phys);
      }

      el.append(left, badges);
      el.addEventListener('click', () => {
        selected = row;
        ({ physics, camera } = overrideOf(row.mapName));
        renderRows();
        renderDetail();
      });
      list.appendChild(el);
    }
  };

  const renderDetail = (): void => {
    detail.innerHTML = '';
    if (!selected) {
      startBtn.style.display = 'none';
      return;
    }
    startBtn.style.display = '';
    // Captured once, as a `const` -- `selected` is a `let` a later row click
    // could reassign, and the segmented controls below close over this
    // instead of over `selected` itself so a stale click can't write to the
    // wrong map's override.
    const mapName = selected.mapName;

    const label = document.createElement('div');
    label.innerHTML = ''; // built with real nodes below, not innerHTML on map text
    const nameEl = document.createElement('div');
    nameEl.style.cssText = "font:600 20px/1 var(--ob-font-display);letter-spacing:.04em";
    renderQ3Text(nameEl, selected.longname ?? selected.mapName);
    const modeEl = document.createElement('div');
    modeEl.style.cssText =
      'margin-top:6px;font:400 10px/1 var(--ob-font-mono);letter-spacing:.06em;color:var(--ob-dim)';
    modeEl.textContent = selected.declaredPhysics
      ? `${selected.declaredPhysics.toUpperCase()} — declared by the map`
      : 'physics not declared';
    label.append(nameEl, modeEl);

    const picks = document.createElement('div');
    picks.className = 'picks';

    const physicsPick = document.createElement('div');
    physicsPick.className = 'pick';
    const physicsLabel = document.createElement('span');
    physicsLabel.textContent = 'Physics';
    const physicsSeg = createSegmentedControl(
      [
        { id: 'auto', label: 'AUTO' },
        { id: 'vq3', label: 'VQ3' },
        { id: 'cpm', label: 'CPM' },
      ],
      physics,
      (id) => {
        physics = id as 'auto' | 'vq3' | 'cpm';
        prefs.set(mapName, { physics: physics === 'auto' ? null : physics, camera: camera === 'auto' ? null : camera });
      },
    );
    physicsPick.append(physicsLabel, physicsSeg);

    const cameraPick = document.createElement('div');
    cameraPick.className = 'pick';
    const cameraLabel = document.createElement('span');
    cameraLabel.textContent = 'Camera';
    const cameraSeg = createSegmentedControl(
      [
        { id: 'auto', label: 'AUTO' },
        { id: 'chase', label: 'CHASE' },
        { id: 'side', label: 'SIDE' },
        { id: 'fpv', label: 'FPV' },
      ],
      camera,
      (id) => {
        camera = id as 'auto' | 'chase' | 'side' | 'fpv';
        prefs.set(mapName, { physics: physics === 'auto' ? null : physics, camera: camera === 'auto' ? null : camera });
      },
    );
    cameraPick.append(cameraLabel, cameraSeg);

    picks.append(physicsPick, cameraPick);
    detail.append(label, picks);
  };

  /** Re-scan and re-render after a mount -- bundled kit arriving or a player's own drop/browse. */
  const refresh = async (): Promise<void> => {
    rows = await scanRows();
    shell.setStatus(`${rows.length} map${rows.length === 1 ? '' : 's'}`);
    shell.setItems([{ id: 'all', label: 'All courses', count: String(rows.length) }]);
    const prevMapName = selected?.mapName;
    const keep = prevMapName ? rows.find((r) => r.mapName === prevMapName) : undefined;
    selected = keep ?? rows[0] ?? null;
    if (!keep) {
      ({ physics, camera } = selected ? overrideOf(selected.mapName) : { physics: 'auto', camera: 'auto' });
    }
    renderRows();
    renderDetail();
  };

  renderRows();
  renderDetail();

  const mountFiles = async (files: readonly File[]): Promise<void> => {
    if (!files.length) {
      return;
    }
    dropStatus.textContent = `Reading ${files.length} archive${files.length === 1 ? '' : 's'}...`;
    dropStatus.classList.remove('err');

    let failed = 0;
    for (const file of files) {
      try {
        await fs.mount(file.name, file);
      } catch (err) {
        failed++;
        console.warn(`[overbounce] ${file.name}: ${(err as Error).message}`);
      }
    }

    await refresh();
    if (failed === files.length) {
      dropStatus.textContent = 'None of those could be read as .pk3 archives.';
      dropStatus.classList.add('err');
    } else {
      dropStatus.textContent =
        failed > 0
          ? `${files.length - failed} of ${files.length} archives mounted.`
          : `${files.length} archive${files.length === 1 ? '' : 's'} mounted.`;
    }
  };

  drop.addEventListener('click', () => dropInput.click());
  dropInput.addEventListener('click', (e) => e.stopPropagation());
  dropInput.addEventListener('change', () => {
    void mountFiles(Array.from(dropInput.files ?? []));
  });
  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('dragging');
    });
  }
  for (const ev of ['dragleave', 'dragend']) {
    drop.addEventListener(ev, () => drop.classList.remove('dragging'));
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    void mountFiles(Array.from(e.dataTransfer?.files ?? []));
  });

  // The bundled OpenArena kit -- see the file header. Each mounts
  // independently and failure is silent per file (fetch 404, or the build
  // script that produces it never run): the player still has their own
  // archives to fall back to, and one missing bundled pak shouldn't block
  // the other. Guarded so returning to this screen after a run never
  // refetches archives already mounted into this `fs`.
  if (!bundledMounted.has(fs)) {
    bundledMounted.add(fs);
    for (const pak of BUNDLED_PAKS) {
      void (async (): Promise<void> => {
        try {
          // BASE_URL, not a bare `/` -- a GitHub Pages project site serves
          // from a subpath, and this runtime fetch is outside Vite's own
          // index.html asset rewriting. See vite.config.ts.
          const res = await fetch(`${import.meta.env.BASE_URL}${pak}`);
          if (!res.ok) {
            return;
          }
          await fs.mount(pak, await res.blob(), PakGroup.Fallback);
          await refresh();
        } catch (err) {
          console.warn(`[overbounce] ${pak}: ${(err as Error).message}`);
        }
      })();
    }
  }

  settingsBtn.addEventListener('click', () => {
    // No course is active here -- Settings gets no context, and its Movement
    // panel falls back to explaining the override rather than showing one
    // course's current values. `showCourseSelectScreen`'s own promise is
    // untouched: this just sits in front of it until Settings resolves.
    //
    // Disabled for the duration of the trip -- without this, a second click
    // before the first Settings instance unmounts stacks a second full-screen
    // instance on top of it, each with its own Escape listener, so a single
    // Escape afterwards resolves and unmounts both at once.
    settingsBtn.disabled = true;
    void showSettingsScreen(document.body).finally(() => {
      settingsBtn.disabled = false;
    });
  });

  return new Promise((resolve) => {
    startBtn.addEventListener('click', () => {
      if (!selected) {
        return;
      }
      const resolvedPhysics = physics === 'auto' ? resolveAutoPhysics(selected.declaredPhysics) : physics;
      const resolvedCamera = camera === 'auto' ? resolveAutoCamera(selected.hasCameraScript) : camera;
      shell.dispose();
      resolve({ mapName: selected.mapName, physics: resolvedPhysics, camera: resolvedCamera });
    });
  });
}
