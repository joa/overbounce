/**
 * Course select -- "Run a course" (`1g`).
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Lists every map in the mounted `Pk3FileSystem`, using `course-info.ts` and
 * `course-scan.ts` for the physics/timed/checkpoint facts `1g`'s card row
 * needs before any of them has been played. The header's LIST/TILES toggle
 * and the rail's BUILT FOR (ALL/VQ3/CPM) filter are both real, reading the
 * same `declaredPhysics` field the badges already showed.
 *
 * TILES loads real `levelshots/<mapname>.{tga,jpg,jpeg,png}` out of whichever
 * pak actually has one -- most community maps ship one, the bundled fallback
 * kit (`ob_basics.pk3`/`pak0.pk3`) does not. `1g`'s own striped placeholder is
 * the fallback for a map with no levelshot in any mounted pak, not a stand-in
 * for a feature that isn't built; `loadLevelshot`, below, decodes and caches
 * per map name so switching views or filters never re-reads a pak.
 *
 * The Tutorial/Strafe/Overbounce/Rocket rail collections are still not built
 * -- see `.agent/plans/UI.md`'s Phase 3 section for why (no *tag* source: a
 * levelshot says nothing about which of the four a map belongs in) -- so this
 * stays a single "All courses" list rather than four with three left empty.
 *
 * This screen owns its own `.pk3` mounting -- there is no separate loader
 * screen anymore (`loader.ts` is gone; `HANDOFF.md`'s "course select carries
 * its own drop region so adding a map never routes through it" is now simply
 * true instead of a documented gap, see `.agent/plans/UI.md`'s Phase 3
 * section). `appFlow` (`main.ts`) hands this an empty `Pk3FileSystem` on
 * first open; this file mounts `ob_basics.pk3`/`ob_rockets.pk3`/`pak0.pk3`
 * (the bundled OpenArena kit, `PakGroup.Fallback`) into it automatically,
 * once, and the drop/browse section below lets a player add their own
 * archives -- which outrank the bundled kit automatically, same guarantee
 * `loader.ts` used to carry (`Pk3FileSystem.reindex` ranks by group before
 * name). Because `appFlow` reuses one `fs` across course switches,
 * `bundledMounted` guards the auto-mount so returning to this screen after a
 * run doesn't refetch and remount the same archives.
 */

import { loadCourseMetadata } from '../../assets/course-info.js';
import { scanCourseSummary } from '../../game/course-scan.js';
import { PreferenceStore } from '../../game/preferences.js';
import { PakGroup } from '../../assets/pk3.js';
import type { Pk3FileSystem } from '../../assets/pk3.js';
import { decodeTga } from '../../assets/tga.js';
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
 * Served from `public/ob_basics.pk3`/`public/ob_rockets.pk3` (both
 * `npm run build-oapak`) and `public/pak0.pk3` (`npm run build-startpak`) --
 * all OpenArena, all mounted at `PakGroup.Fallback`. Their one overlapping
 * path, `scripts/oasky.shader`, comes from the same OA source either way, so
 * it doesn't matter which mounts last.
 */
const BUNDLED_PAKS = ['ob_basics.pk3', 'ob_rockets.pk3', 'pak0.pk3'];

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

.ob-course-loading { font: 400 11px/1 var(--ob-font-mono); letter-spacing: .06em;
  text-transform: uppercase; color: var(--ob-dim); margin-right: 12px; }

.ob-course-tiles { flex: 1; min-height: 0; overflow: auto; display: grid;
  grid-template-columns: repeat(3, 1fr); gap: 14px; align-content: start; }
.ob-course-tile { border: 1px solid var(--ob-seam); border-radius: 6px; background: var(--ob-panel);
  overflow: hidden; cursor: pointer; text-align: left; font: inherit; color: inherit; padding: 0; }
.ob-course-tile:hover { border-color: var(--ob-control-hover); }
.ob-course-tile.active { border-color: var(--ob-accent); }
/* design/'s own mockup hardcodes this box at a fixed 104px height, which
 * reads fine there because every mockup example only ever shows the striped
 * placeholder -- a pattern has no content to crop. A real background-size:
 * cover levelshot is a different story: at the mockup's own 1280px
 * reference width (roughly 320px per tile in a 3-column grid) that 104px
 * height crops a normal 16:9 or 4:3 screenshot down to well under a third of
 * its vertical extent, and it gets worse on wider screens since the box's
 * width grows with the column while its height stays pinned. aspect-ratio
 * instead of a fixed height keeps the crop proportional (and much less
 * severe) at every width -- a real fix, not a port of the mockup's number,
 * because the mockup's number was never actually checked against a real
 * image. */
.ob-course-tile-shot { aspect-ratio: 16 / 9; display: grid; place-items: center;
  background: repeating-linear-gradient(135deg, #1b1b23 0 8px, #20202a 8px 16px); }
.ob-course-tile-shot.loaded { background-size: cover; background-position: center; }
.ob-course-tile-shot span { font: 400 10px/1 var(--ob-font-mono); letter-spacing: .14em; color: var(--ob-unavailable); }
.ob-course-tile-body { padding: 12px 14px 14px; }
.ob-course-tile-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.ob-course-tile-head .name { font: 600 18px/1 var(--ob-font-display); letter-spacing: .02em; }
.ob-course-tile-head .cp { flex: none; font: 400 10px/1 var(--ob-font-mono); color: var(--ob-dim); }
.ob-course-tile-badges { margin-top: 9px; display: flex; gap: 6px; flex-wrap: wrap; }

.ob-course-filter-label { font: 400 10px/1 var(--ob-font-mono); letter-spacing: .22em; color: var(--ob-dim);
  margin-top: 4px; }
.ob-course-filter-explain { margin-top: 9px; font: 400 11px/1.45 var(--ob-font-display); letter-spacing: .03em;
  color: var(--ob-dim); }
.ob-course-rail-note { font: 400 11px/1.5 var(--ob-font-mono); color: var(--ob-unavailable); margin-top: 4px; }
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
 * The rail's BUILT FOR filter (`1g`). Same "prefers VQ3" rule as
 * `resolveAutoPhysics`: an undeclared map runs VQ3 by default, so VQ3 shows
 * it; CPM only shows a map that actually declares CPM (alone or alongside
 * VQ3 via `both`).
 */
function matchesPhysicsFilter(declared: CourseRow['declaredPhysics'], filter: 'all' | 'vq3' | 'cpm'): boolean {
  if (filter === 'all') {
    return true;
  }
  return filter === 'cpm' ? declared === 'cpm' || declared === 'both' : declared !== 'cpm';
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

/**
 * Decodes a `levelshots/` image already resolved by `Pk3FileSystem.findImage`
 * into a data URL a plain `<div>` background or `<img>` can use. `.tga` needs
 * `tga.ts` (browsers never decode it); `.jpg`/`.jpeg`/`.png` decode natively
 * via `createImageBitmap`. Both paths funnel through one canvas and
 * `toDataURL` -- a data: URL needs no `URL.revokeObjectURL` lifecycle to get
 * right, which a `createObjectURL` blob URL would have needed for as long as
 * this screen can be reopened per session.
 */
async function decodeLevelshot(fs: Pk3FileSystem, path: string): Promise<string | null> {
  const bytes = await fs.readFile(path);
  if (!bytes) {
    return null;
  }

  const canvas = document.createElement('canvas');
  if (path.endsWith('.tga')) {
    const img = decodeTga(bytes);
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.putImageData(new ImageData(Uint8ClampedArray.from(img.data), img.width, img.height), 0, 0);
  } else {
    const bitmap = await createImageBitmap(new Blob([bytes.slice() as unknown as BlobPart]));
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  }
  // A thumbnail on a card, not a texture -- re-encoding a decoded TGA as
  // JPEG too keeps every levelshot's data URL small regardless of source.
  return canvas.toDataURL('image/jpeg', 0.85);
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

  // `1g`'s two header-right axes: LIST/TILES is a pure display choice
  // (ephemeral, not persisted -- nothing else in this file persists UI-only
  // state either); BUILT FOR filters `rows` down before either view draws
  // them, using the same `declaredPhysics` field the card badges already
  // read (`matchesPhysicsFilter`, above).
  let view: 'list' | 'tiles' = 'tiles';
  let physicsFilter: 'all' | 'vq3' | 'cpm' = 'all';
  const visibleRows = (): CourseRow[] => rows.filter((r) => matchesPhysicsFilter(r.declaredPhysics, physicsFilter));

  /** Per-map-name, so switching views/filters never re-reads or re-decodes a pak. */
  const levelshotCache = new Map<string, Promise<string | null>>();
  const loadLevelshot = (mapName: string): Promise<string | null> => {
    let p = levelshotCache.get(mapName);
    if (!p) {
      const path = fs.findImage(`levelshots/${mapName}`);
      p = path ? decodeLevelshot(fs, path) : Promise.resolve(null);
      levelshotCache.set(mapName, p);
    }
    return p;
  };

  const shell: Shell = createShell(parent, {
    sectionLabel: 'COLLECTIONS',
    items: [{ id: 'all', label: 'All courses', count: String(rows.length) }],
    activeId: 'all',
    title: 'All courses',
    status: `${rows.length} map${rows.length === 1 ? '' : 's'}`,
  });

  // The rail note the mockup shows under Collections -- explaining why there
  // is only one collection, not four -- plus the BUILT FOR physics filter
  // below it, both in `railExtra` since `railNote`'s bottom-pinned slot
  // doesn't fit either (see `shell.ts`).
  const collectionsNote = document.createElement('div');
  collectionsNote.className = 'ob-course-rail-note';
  collectionsNote.textContent =
    "Tutorial / Strafe / Overbounce / Rocket collections aren't built — no tag source to sort a map into one.";
  shell.railExtra.appendChild(collectionsNote);

  const filterLabel = document.createElement('div');
  filterLabel.className = 'ob-course-filter-label';
  filterLabel.textContent = 'BUILT FOR';
  shell.railExtra.appendChild(filterLabel);

  const filterExplain = document.createElement('div');
  filterExplain.className = 'ob-course-filter-explain';
  filterExplain.textContent = "Filters the list by declared physics — undeclared maps count as VQ3, same rule Auto resolves to.";
  // `filterSeg` (below, once `renderRows`/`renderDetail` exist to call) is
  // inserted between `filterLabel` and this element -- appended here only
  // once that ordering is settled.

  const list = document.createElement('div');
  list.className = 'ob-course-list';
  const tiles = document.createElement('div');
  tiles.className = 'ob-course-tiles';
  shell.body.append(list, tiles);

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
  const loadingIndicator = document.createElement('div');
  loadingIndicator.className = 'ob-course-loading';
  loadingIndicator.style.display = 'none';
  shell.footerRight.appendChild(loadingIndicator);
  const startBtn = createButton('Start run', 'primary');
  shell.footerRight.appendChild(startBtn);

  /**
   * The bug this closes: the map list comes from `ob_basics.pk3` (862KB,
   * mounts almost instantly), but player/weapon/item models and every sound
   * live in the much larger `pak0.pk3` (~31MB) -- mounted in parallel, not
   * sequentially. On localhost both finish before a human can click
   * anything, so the race was invisible; over a real network the course list
   * (and "Start run") was ready long before pak0.pk3 was, and a run started
   * in the gap loaded with a world but no player, no weapon and no item
   * models at all. `pendingMounts` tracks every in-flight mount -- bundled
   * AND a player's own drop/browse -- and `startBtn` stays disabled for as
   * long as any of them are still running.
   */
  let pendingMounts = 0;
  const setPending = (delta: number): void => {
    pendingMounts += delta;
    startBtn.disabled = pendingMounts > 0;
    loadingIndicator.style.display = pendingMounts > 0 ? '' : 'none';
    loadingIndicator.textContent =
      pendingMounts > 0 ? `Loading ${pendingMounts} archive${pendingMounts === 1 ? '' : 's'}…` : '';
  };

  /** Clicking either a list row or a tile card -- same selection, same reset. */
  const selectRow = (row: CourseRow): void => {
    selected = row;
    ({ physics, camera } = overrideOf(row.mapName));
    renderRows();
    renderDetail();
  };

  /**
   * TIMED/FREERUN + declared-physics badges, shared by both views. Tiles
   * (`1g`) show the checkpoint count in the card's name row instead of
   * folded into the TIMED badge text -- `includeCheckpoints` is what the
   * list view's denser "TIMED · N cp" badge needs and tiles don't.
   */
  const buildBadges = (row: CourseRow, includeCheckpoints: boolean): HTMLElement => {
    const badges = document.createElement('div');
    badges.className = 'badges';
    if (row.timed) {
      const timed = document.createElement('span');
      timed.className = 'ob-course-badge timed';
      timed.textContent = includeCheckpoints ? `TIMED · ${row.checkpoints} cp` : 'TIMED';
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
    return badges;
  };

  const renderListRows = (items: readonly CourseRow[]): void => {
    for (const row of items) {
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

      el.append(left, buildBadges(row, true));
      el.addEventListener('click', () => selectRow(row));
      list.appendChild(el);
    }
  };

  const renderTileRows = (items: readonly CourseRow[]): void => {
    for (const row of items) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'ob-course-tile';
      el.classList.toggle('active', row === selected);

      const shot = document.createElement('div');
      shot.className = 'ob-course-tile-shot';
      const shotLabel = document.createElement('span');
      // `1g`'s own striped placeholder -- swapped for a real image below if
      // this map's pak actually has one; left in place if not (or on decode
      // failure), same fallback the mockup itself draws.
      shotLabel.textContent = `LEVELSHOT · ${row.mapName}`;
      shot.appendChild(shotLabel);
      void loadLevelshot(row.mapName).then((url) => {
        // The tile may already be gone -- a filter or view change while this
        // was still decoding -- in which case there is nothing left to do.
        if (!url || !shot.isConnected) {
          return;
        }
        shot.classList.add('loaded');
        shot.style.backgroundImage = `url("${url}")`;
        shotLabel.remove();
      });

      const body = document.createElement('div');
      body.className = 'ob-course-tile-body';
      const head = document.createElement('div');
      head.className = 'ob-course-tile-head';
      const name = document.createElement('span');
      name.className = 'name';
      renderQ3Text(name, row.longname ?? row.mapName);
      head.appendChild(name);
      if (row.timed) {
        const cp = document.createElement('span');
        cp.className = 'cp';
        cp.textContent = `${row.checkpoints} cp`;
        head.appendChild(cp);
      }
      const badges = buildBadges(row, false);
      badges.className = 'ob-course-tile-badges';
      body.append(head, badges);

      el.append(shot, body);
      el.addEventListener('click', () => selectRow(row));
      tiles.appendChild(el);
    }
  };

  const renderRows = (): void => {
    const items = visibleRows();
    shell.setStatus(`${items.length} map${items.length === 1 ? '' : 's'}`);

    list.style.display = view === 'list' ? '' : 'none';
    tiles.style.display = view === 'tiles' ? '' : 'none';
    list.innerHTML = '';
    tiles.innerHTML = '';

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'ob-course-empty';
      empty.textContent = rows.length
        ? 'No courses built for this physics mode in the mounted archives.'
        : 'No maps in the mounted archives yet.';
      (view === 'list' ? list : tiles).appendChild(empty);
      return;
    }

    if (view === 'list') {
      renderListRows(items);
    } else {
      renderTileRows(items);
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

  /** Drops the current selection back to the first still-visible row when a
   *  filter change (or a rescan) hides whatever was selected. */
  const dropSelectionIfFiltered = (): void => {
    if (selected && !matchesPhysicsFilter(selected.declaredPhysics, physicsFilter)) {
      selected = visibleRows()[0] ?? null;
      ({ physics, camera } = selected ? overrideOf(selected.mapName) : { physics: 'auto', camera: 'auto' });
    }
  };

  const filterSeg = createSegmentedControl(
    [
      { id: 'all', label: 'ALL' },
      { id: 'vq3', label: 'VQ3' },
      { id: 'cpm', label: 'CPM' },
    ],
    physicsFilter,
    (id) => {
      physicsFilter = id as 'all' | 'vq3' | 'cpm';
      dropSelectionIfFiltered();
      renderRows();
      renderDetail();
    },
  );
  filterSeg.style.marginTop = '8px';
  shell.railExtra.append(filterSeg, filterExplain);

  const viewSeg = createSegmentedControl(
    [
      { id: 'list', label: 'LIST' },
      { id: 'tiles', label: 'TILES' },
    ],
    view,
    (id) => {
      view = id as 'list' | 'tiles';
      renderRows();
    },
  );
  shell.headerExtra.appendChild(viewSeg);

  /** Re-scan and re-render after a mount -- bundled kit arriving or a player's own drop/browse. */
  const refresh = async (): Promise<void> => {
    rows = await scanRows();
    shell.setItems([{ id: 'all', label: 'All courses', count: String(rows.length) }]);
    const prevMapName = selected?.mapName;
    const keep = prevMapName ? rows.find((r) => r.mapName === prevMapName) : undefined;
    selected = keep ?? rows[0] ?? null;
    if (!keep) {
      ({ physics, camera } = selected ? overrideOf(selected.mapName) : { physics: 'auto', camera: 'auto' });
    }
    dropSelectionIfFiltered();
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
    setPending(1);

    let failed = 0;
    try {
      for (const file of files) {
        try {
          await fs.mount(file.name, file);
        } catch (err) {
          failed++;
          console.warn(`[overbounce] ${file.name}: ${(err as Error).message}`);
        }
      }
    } finally {
      setPending(-1);
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
      setPending(1);
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
        } finally {
          setPending(-1);
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
