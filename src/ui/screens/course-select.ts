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
 */

import { loadCourseMetadata } from '../../assets/course-info.js';
import { scanCourseSummary } from '../../game/course-scan.js';
import { PreferenceStore } from '../../game/preferences.js';
import type { Pk3FileSystem } from '../../assets/pk3.js';
import { createShell, createButton, createSegmentedControl } from '../shell.js';
import type { Shell } from '../shell.js';
import { showSettingsScreen } from './settings.js';

export interface CourseChoice {
  mapName: string;
  physics: 'vq3' | 'cpm';
  camera: 'auto' | 'chase' | 'side';
}

interface CourseRow {
  mapName: string;
  longname: string | null;
  declaredPhysics: 'vq3' | 'cpm' | 'both' | null;
  timed: boolean;
  checkpoints: number;
}

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

export async function showCourseSelectScreen(
  parent: HTMLElement,
  fs: Pk3FileSystem,
): Promise<CourseChoice> {
  installStyle();

  const mapNames = fs.listMaps();

  const shell: Shell = createShell(parent, {
    sectionLabel: 'COLLECTIONS',
    items: [{ id: 'all', label: 'All courses', count: String(mapNames.length) }],
    activeId: 'all',
    title: 'All courses',
    status: `${mapNames.length} map${mapNames.length === 1 ? '' : 's'}`,
  });

  const list = document.createElement('div');
  list.className = 'ob-course-list';
  shell.body.appendChild(list);

  if (!mapNames.length) {
    const empty = document.createElement('div');
    empty.className = 'ob-course-empty';
    empty.textContent = 'No maps in the mounted archives.';
    list.appendChild(empty);
  }

  const rows: CourseRow[] = await Promise.all(
    mapNames.map(async (mapName) => {
      const [meta, summary] = await Promise.all([
        loadCourseMetadata(fs, mapName),
        scanCourseSummary(fs, mapName),
      ]);
      return {
        mapName,
        longname: meta.longname,
        declaredPhysics: meta.physics,
        timed: summary?.timed ?? false,
        checkpoints: summary?.checkpoints ?? 0,
      };
    }),
  );

  // R7: "the override is remembered per map, not globally" -- the same
  // store Settings' Movement panel reads and writes. AUTO/VQ3/CPM below
  // aren't a fresh choice every visit; a map opened before comes back with
  // whatever it was left on.
  const prefs = new PreferenceStore();
  const overrideOf = (mapName: string): { physics: 'auto' | 'vq3' | 'cpm'; camera: 'auto' | 'chase' | 'side' } => {
    const o = prefs.get(mapName);
    return { physics: o.physics ?? 'auto', camera: o.camera === 'fpv' ? 'auto' : (o.camera ?? 'auto') };
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
    for (const row of rows) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'ob-course-row';
      el.classList.toggle('active', row === selected);

      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      // Map/author-supplied text (.arena/.defi longname) -- textContent, never innerHTML.
      name.textContent = row.longname ?? row.mapName;
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
    nameEl.textContent = selected.longname ?? selected.mapName;
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
      ],
      camera,
      (id) => {
        camera = id as 'auto' | 'chase' | 'side';
        prefs.set(mapName, { physics: physics === 'auto' ? null : physics, camera: camera === 'auto' ? null : camera });
      },
    );
    cameraPick.append(cameraLabel, cameraSeg);

    picks.append(physicsPick, cameraPick);
    detail.append(label, picks);
  };

  renderRows();
  renderDetail();

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
      shell.dispose();
      resolve({ mapName: selected.mapName, physics: resolvedPhysics, camera });
    });
  });
}
