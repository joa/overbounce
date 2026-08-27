/**
 * Course select -- "Run a course" (`1g`).
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Lists every map in the mounted `Pk3FileSystem`, using `course-info.ts` and
 * `course-scan.ts` for the physics/timed/checkpoint facts `1g`'s card row
 * needs before any of them has been played. The header's LIST/TILES toggle
 * is real, and the rail's own nav rows ARE the filter -- All courses / VQ3 /
 * CPM / Side / Freerun, each a real category (`matchesFilter`, below), not a
 * decorative "Collections" list with a separate BUILT FOR control bolted on
 * beneath it the way an earlier version of this screen had it. VQ3/CPM read
 * `declaredPhysics`, the same field the badges already show; Side/Freerun
 * read `hasCameraScript`/`timed`.
 *
 * TILES loads real `levelshots/<mapname>.{tga,jpg,jpeg,png}` out of whichever
 * pak actually has one -- most community maps ship one, the bundled fallback
 * kit (`ob_basics.pk3`/`pak0.pk3`) does not. `1g`'s own striped placeholder is
 * the fallback for a map with no levelshot in any mounted pak, not a stand-in
 * for a feature that isn't built; `loadLevelshot`, below, decodes and caches
 * per map name so switching views or filters never re-reads a pak. A tile
 * also shows the player's own PR and its gap against sum-of-best when
 * `RecordBook` actually has one for that map/physics/camera -- reusing
 * `records.ts`'s `mapRecord` and `hud.ts`'s `formatTime`/`formatDelta` rather
 * than a second implementation of either.
 *
 * The Tutorial/Strafe/Overbounce/Rocket rail collections named in an earlier
 * mockup are still not built -- see `.agent/plans/UI.md`'s Phase 3 section
 * for why (no *tag* source: a levelshot says nothing about which of the four
 * a map belongs in) -- unrelated to the five real categories above, which
 * come from fields this screen already reads for the badges.
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
import { RecordBook } from '../../game/records.js';
import { PMOVE_MSEC } from '../../physics/constants.js';
import { PakGroup } from '../../assets/pk3.js';
import type { Pk3FileSystem } from '../../assets/pk3.js';
import { decodeTga } from '../../assets/tga.js';
import { createShell, createButton, createSegmentedControl } from '../shell.js';
import type { Shell, ShellNavItem } from '../shell.js';
import { showSettingsScreen } from './settings.js';
import { renderQ3Text } from '../../render/q3-colors.js';
import { formatTime, formatDelta } from '../../render/hud.js';

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

/* grid-auto-rows is NOT redundant with the tile's own auto default here --
 * see the long comment on .ob-course-tile-shot below for why overflow:
 * hidden is on .ob-course-tile at all. That property has a second effect
 * beyond clipping: per the CSS Sizing spec, a grid item's automatic (content-
 * based) MINIMUM size contribution to its row track collapses to zero once
 * the item's own overflow is anything but visible -- so with more rows
 * than fit in the flex-resolved height this container gets from
 * .ob-shell-body, nothing stopped the implicit auto row tracks from
 * shrinking every tile down to a sliver instead of overflowing (which is what
 * this container's own overflow: auto is FOR). Reproduced by cloning tiles
 * past a page's height in a real browser: rows compressed to a few pixels
 * each rather than scrolling. minmax(min-content, auto) restores an
 * explicit, non-"automatic" minimum on the row tracks themselves, which is
 * not subject to that collapse -- tiles keep their real height and the
 * container scrolls past them instead of flattening them. */
.ob-course-tiles { flex: 1; min-height: 0; overflow: auto; display: grid;
  grid-template-columns: repeat(3, 1fr); grid-auto-rows: minmax(min-content, auto);
  gap: 14px; align-content: start; }
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
/* Only present when RecordBook actually has a PB for this map/physics --
 * most tiles never grow this row at all. */
.ob-course-tile-pb { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--ob-seam);
  display: flex; gap: 14px; font: 400 11px/1 var(--ob-font-mono); color: var(--ob-dim); }
.ob-course-tile-pb .value { color: var(--ob-text); }
/* Matches .ob-card-text code's gold (shell.ts) -- this project's one
 * "you could still be faster" colour, not a token because nothing else
 * needs a third accent yet. */
.ob-course-tile-pb .sob-value { color: #ffd166; }

.ob-course-filter-explain { margin-top: 9px; font: 400 11px/1.45 var(--ob-font-display); letter-spacing: .03em;
  color: var(--ob-dim); }
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

export type CourseFilter = 'all' | 'vq3' | 'cpm' | 'side' | 'freerun';

/** The rail's own label for each filter category, in display order. */
const FILTER_LABEL: Record<CourseFilter, string> = {
  all: 'All courses',
  vq3: 'VQ3',
  cpm: 'CPM',
  side: 'Side',
  freerun: 'Freerun',
};

/**
 * The rail's nav rows ARE the filter (`1g`) -- one flat list, not a
 * "Collections" section with a separate BUILT FOR control underneath it.
 * VQ3/CPM use the same "prefers VQ3" rule as `resolveAutoPhysics`: an
 * undeclared map runs VQ3 by default, so VQ3 shows it; CPM only shows a map
 * that actually declares CPM (alone or alongside VQ3 via `both`). Side/
 * Freerun are course-type filters, not physics ones -- a map can be both
 * (or neither).
 */
function matchesFilter(row: CourseRow, filter: CourseFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'vq3':
      return row.declaredPhysics !== 'cpm';
    case 'cpm':
      return row.declaredPhysics === 'cpm' || row.declaredPhysics === 'both';
    case 'side':
      return row.hasCameraScript;
    case 'freerun':
      return !row.timed;
  }
}

/** Nav rows for the rail, counts computed fresh against the full (unfiltered) row set. */
function navItemsFor(rows: readonly CourseRow[]): ShellNavItem[] {
  return (Object.keys(FILTER_LABEL) as CourseFilter[]).map((id) => ({
    id,
    label: FILTER_LABEL[id],
    count: String(rows.filter((r) => matchesFilter(r, id)).length),
  }));
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
 *
 * Exported: `loading.ts`'s course-load screen reuses this exact function for
 * its own backdrop rather than a second TGA/PNG/JPEG decoder -- there is
 * nothing course-select-specific in it, only in `loadLevelshot`'s caching
 * below, which stays local to this screen.
 */
export async function decodeLevelshot(fs: Pk3FileSystem, path: string): Promise<string | null> {
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

  // LIST/TILES (header) is a pure display choice, ephemeral like every other
  // UI-only state in this file. The rail's active category filters `rows`
  // down before either view draws them (`matchesFilter`, above).
  let view: 'list' | 'tiles' = 'tiles';
  let filter: CourseFilter = 'all';
  const visibleRows = (): CourseRow[] => rows.filter((r) => matchesFilter(r, filter));

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
    sectionLabel: 'COURSES',
    items: navItemsFor(rows),
    activeId: filter,
    title: FILTER_LABEL[filter],
    status: `${rows.length} map${rows.length === 1 ? '' : 's'}`,
    // The rail rows ARE the filter now -- picking one both narrows `rows`
    // and renames the header, the same "selecting a section retitles the
    // header" rule `settings.ts` already follows for its own rail.
    // `dropSelectionIfFiltered`/`renderRows`/`renderDetail` are defined
    // further down this function; referencing them here is fine because
    // this callback only runs on a later click, well after they exist --
    // JS closures resolve free variables at call time, not at the time this
    // object literal is built.
    onNavigate: (id) => {
      filter = id as CourseFilter;
      shell.setTitle(FILTER_LABEL[filter]);
      dropSelectionIfFiltered();
      renderRows();
      renderDetail();
    },
  });

  // The rail note under the filter -- what VQ3/CPM/Side/Freerun actually key
  // off, since none of the four is self-explanatory from its label alone.
  // `railExtra`, not `railNote`: `railNote`'s bottom-pinned slot doesn't fit
  // here either (see `shell.ts`).
  const filterExplain = document.createElement('div');
  filterExplain.className = 'ob-course-filter-explain';
  filterExplain.textContent =
    "VQ3/CPM filter by declared physics, a real field on course-info.ts's row. Side/Freerun filter by course type.";
  shell.railExtra.appendChild(filterExplain);

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

  // A tile's PB is read for the physics AND camera it would actually run
  // under right now -- the player's own per-map override if they set one,
  // else whatever AUTO resolves to -- so the shown time is always the record
  // that combination belongs to, the same one "Start run" would race
  // against. See `records.ts`'s file header for why camera is in the key at
  // all: a `side` or `fpv` PR was set with a different information budget
  // than `chase`, so showing one under the wrong camera's tile would credit
  // a time the player never actually set in that view.
  const records = new RecordBook();
  const physicsKeyFor = (row: CourseRow): 'vq3' | 'cpm' => {
    const { physics: override } = overrideOf(row.mapName);
    return override === 'auto' ? resolveAutoPhysics(row.declaredPhysics) : override;
  };
  const cameraKeyFor = (row: CourseRow): 'chase' | 'side' | 'fpv' => {
    const { camera: override } = overrideOf(row.mapName);
    const resolved = override === 'auto' ? resolveAutoCamera(row.hasCameraScript) : override;
    // `resolveAutoCamera` can itself still say 'auto' (no camera script --
    // see its own doc comment); `main.ts`'s own resolution collapses that to
    // `chase`, and this has to match it exactly or the PR shown here would
    // not be the one "Start run" actually races against.
    return resolved === 'auto' ? 'chase' : resolved;
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
  startBtn.classList.add('ob-cta-pulse');
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

      // PR + vs-SoB, only when a record actually exists for this map under
      // the physics it would run under right now -- most tiles never grow
      // this row at all (see `.ob-course-tile-pb`'s CSS comment).
      const rec = records.mapRecord(row.mapName, physicsKeyFor(row), PMOVE_MSEC, cameraKeyFor(row));
      if (rec?.best) {
        const pb = document.createElement('div');
        pb.className = 'ob-course-tile-pb';

        const pr = document.createElement('span');
        pr.append('PR ');
        const prValue = document.createElement('span');
        prValue.className = 'value';
        prValue.textContent = formatTime(rec.best.time);
        pr.appendChild(prValue);
        pb.appendChild(pr);

        // Sum-of-best only means anything once there are checkpoints to
        // segment the run with, and once a second completion has actually
        // diverged from the run that seeded it -- the same two gates
        // `results.ts`'s own SUM OF BEST SEGMENTS row uses.
        if (row.checkpoints > 0 && rec.sumOfBest.length && rec.counters.completed > 1) {
          const sumOfBest = rec.sumOfBest.reduce((a, b) => a + b, 0);
          const sob = document.createElement('span');
          sob.append('vs SoB ');
          const sobValue = document.createElement('span');
          sobValue.className = 'sob-value';
          sobValue.textContent = formatDelta(rec.best.time - sumOfBest);
          sob.appendChild(sobValue);
          pb.appendChild(sob);
        }

        body.appendChild(pb);
      }

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
        ? 'No courses match this filter in the mounted archives.'
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
    if (selected && !matchesFilter(selected, filter)) {
      selected = visibleRows()[0] ?? null;
      ({ physics, camera } = selected ? overrideOf(selected.mapName) : { physics: 'auto', camera: 'auto' });
    }
  };

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
    shell.setItems(navItemsFor(rows));
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
