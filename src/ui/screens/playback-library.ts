/**
 * The playback library (`Pa`): pick a demo or a ghost, warn if its map is missing.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The same shell every other menu screen uses (`shell.ts`), with a rail
 * that names both destinations -- LIBRARY: Courses / Playback -- because from
 * here "Courses" is somewhere you can actually go, which is not true of any
 * other screen's rail.
 *
 * ## Loading mirrors course select, and it has to
 *
 * A demo is a recording of a map, not a recording of a picture: it names an
 * entity number and a server time and nothing else, so without the map
 * mounted there is nothing to draw. That is the same constraint course select
 * lives under, so the drop region is the same one, extended to route by
 * extension: `.pk3`/`.zip` mount, `.dm_68` decodes, `.obghost` and a pasted
 * `OBG1.` string decode to a `GhostRun`.
 *
 * `mountBundledPaks` is shared with course select rather than repeated,
 * including its once-per-filesystem guard -- a player who goes straight from
 * the title to Playback needs the bundled maps just as much, and re-fetching
 * 30MB of `pak0.pk3` because they arrived from a different door would be a
 * silly way to spend a minute.
 *
 * ## Paste is the primary path for a ghost
 *
 * Not the file drop. Sharing an Overbounce ghost happens as a copied string
 * in a Discord message (the owner's brief, and the whole reason
 * `ghost-share.ts` exists), so the paste box is the widest control in its
 * row and "LOAD FROM CLIPBOARD" is the accent button. `decodeGhostShare`
 * tolerates the line breaks a round trip through a chat client adds.
 *
 * ## Nothing here refuses to LIST a recording it cannot play
 *
 * A demo whose map is missing still parses, still shows its map name, its
 * time and its physics, and still says exactly what is wrong -- it just
 * cannot start. Hiding it would leave the player wondering whether the file
 * was even read.
 *
 * ## The row IS the action, so this screen has no footer
 *
 * Every other menu screen ends in a commit bar: secondary actions left, one
 * accent CTA right. This one does not, and the Pa frame draws it that way on
 * purpose -- there is nothing to do with a selected demo except watch it, so
 * a SELECT that arms a "Start playback" button is two gestures spent
 * expressing one intent. The row's own action is PLAY and it starts that row
 * immediately; a double-click on the row does the same thing.
 *
 * Two things used to live in the footer and had to go somewhere:
 *
 *  - The **loading line** folded into the header's status slot, which already
 *    said "6 loaded" -- one mono line about the state of the library, not two
 *    in different corners.
 *  - The **Settings button** is simply gone, as it is in the frame. It is one
 *    hop away in both directions a viewer can travel from here: Back lands on
 *    the title, which has Settings, and a running playback's Esc menu (`Pd`)
 *    offers it directly over the recording. Course select keeps its own
 *    because course select still HAS a footer to keep it in.
 *
 * With both gone the footer is empty, and an empty commit bar is not nothing
 * on screen: it is a seam and 32px of padding under a list that should reach
 * the bottom of the frame. It is hidden outright rather than left blank.
 */

import '../tokens.css';
import { createShell } from '../shell.js';
import type { Shell } from '../shell.js';
import { mountBundledPaks } from './course-select.js';
import { PakGroup } from '../../assets/pk3.js';
import type { Pk3FileSystem } from '../../assets/pk3.js';
import { parseDm68 } from '../../demo/dm68.js';
import { demoMeta } from '../../demo/meta.js';
import type { DemoMeta } from '../../demo/meta.js';
import { decodeGhostShare, looksLikeGhostShare, SHARE_PREFIX } from '../../game/ghost-share.js';
import { GhostStore } from '../../game/ghost.js';
import type { GhostRun } from '../../game/ghost.js';
import { RecordBook } from '../../game/records.js';
import type { PlaybackSource } from '../../playback-session.js';
import { formatTime } from '../../render/hud.js';

/** What the screen resolves to: something to play, or a door out. */
export type LibraryChoice =
  | { kind: 'play'; source: PlaybackSource }
  | { kind: 'courses' }
  /** The header's Back: wherever this screen was opened from, which is the title. */
  | { kind: 'title' };

/** One listable recording. */
interface Row {
  id: string;
  /** The filename, or a ghost's own description. */
  name: string;
  map: string;
  /** Run time in ms when the source claims one, else the whole duration. */
  timeMs: number;
  /** True when `timeMs` is a duration rather than a claimed run time. */
  timeIsDuration: boolean;
  physics: string;
  camera: string;
  source: PlaybackSource;
  /** Filled by `restatus()` against the live filesystem. */
  mapPresent: boolean;
}

const STYLE = `
.ob-lib-drop { flex:none; border:1px dashed var(--ob-control-hover); border-radius:6px;
  padding:14px 16px; display:flex; align-items:center; justify-content:space-between;
  gap:16px; cursor:pointer; }
.ob-lib-drop:hover, .ob-lib-drop.dragging { border-color:var(--ob-accent);
  background:rgba(232,98,42,.05); }
.ob-lib-drop p { margin:0; font:400 13px/1.5 var(--ob-font-display); color:var(--ob-dim);
  max-width:76ch; }
.ob-lib-drop p b { color:var(--ob-text-secondary); font-weight:500; }
.ob-lib-browse { flex:none; padding:9px 16px; border:1px solid var(--ob-control-hover);
  border-radius:5px; background:transparent; font:400 12px/1 var(--ob-font-display);
  letter-spacing:.08em; text-transform:uppercase; color:var(--ob-text-secondary);
  white-space:nowrap; cursor:pointer; }
.ob-lib-browse:hover { color:var(--ob-text); border-color:var(--ob-dim); }

.ob-lib-section { font:400 10px/1 var(--ob-font-mono); letter-spacing:.2em;
  color:var(--ob-dim); margin-bottom:8px; }
.ob-lib-table { display:flex; flex-direction:column; border:1px solid var(--ob-seam);
  border-radius:6px; overflow:hidden; }
.ob-lib-head, .ob-lib-row { display:grid;
  grid-template-columns:minmax(0,1fr) 160px 90px 70px 70px 110px 90px; gap:12px;
  align-items:center; padding:11px 14px; }
.ob-lib-head { padding:9px 14px; background:var(--ob-panel);
  font:400 10px/1 var(--ob-font-mono); letter-spacing:.1em; color:#5a5a66; }
/* A row is a click target and a double-click target, so it must not behave
   like prose: without this the second press of a double-click selects the
   word under the pointer, and on a row that cannot play -- where the screen
   does not go away and take the highlight with it -- that stray blue smear
   is the only thing that visibly happened. */
.ob-lib-row { background:var(--ob-background); border-top:1px solid #1c1c24;
  cursor:pointer; user-select:none; }
.ob-lib-row:hover { background:var(--ob-panel-alt-2); }
.ob-lib-row.active { background:rgba(232,98,42,.08); }
.ob-lib-row .n { font:500 14px/1.2 var(--ob-font-display); letter-spacing:.02em;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ob-lib-row .m { font:400 12px/1 var(--ob-font-mono); color:var(--ob-text-secondary);
  overflow:hidden; text-overflow:ellipsis; }
.ob-lib-row .t { font:600 13px/1 var(--ob-font-mono); color:var(--ob-text);
  font-variant-numeric:tabular-nums; }
.ob-lib-row .t.dur { font-weight:400; color:var(--ob-dim); }
.ob-lib-row .k { font:400 11px/1 var(--ob-font-mono); color:var(--ob-text-secondary); }
.ob-lib-status { display:flex; align-items:center; gap:6px;
  font:400 11px/1 var(--ob-font-mono); }
.ob-lib-status .dot { width:6px; height:6px; border-radius:50%; flex:none; }
.ob-lib-status.ok { color:#7ee081; }
.ob-lib-status.ok .dot { background:#7ee081; }
.ob-lib-status.missing { color:#ff6b6b; }
.ob-lib-status.missing .dot { background:#ff6b6b; }
/* PLAY, filled, the one light thing in the row -- and, disabled, the bordered
   dim pill the frame draws beside a red "Map missing": --ob-unavailable on a
   transparent ground, which in this design system means unavailable and
   means nothing else. */
.ob-lib-play { padding:6px 12px; border-radius:4px; border:0; background:var(--ob-text);
  color:var(--ob-background); font:600 11px/1 var(--ob-font-mono); letter-spacing:.06em;
  text-align:center; cursor:pointer; }
.ob-lib-play:hover { background:#fff; }
.ob-lib-play:disabled { background:transparent; border:1px solid var(--ob-control-hover);
  color:var(--ob-unavailable); cursor:default; }

.ob-lib-ghosts { display:grid; grid-template-columns:1.4fr 1fr; gap:14px; }
.ob-lib-paste { border:1px solid var(--ob-seam); border-radius:6px; background:var(--ob-panel);
  padding:14px; }
.ob-lib-paste textarea { width:100%; height:62px; resize:none; border:1px solid var(--ob-control);
  border-radius:4px; background:var(--ob-rail); color:var(--ob-text-secondary);
  padding:10px 12px; font:400 11px/1.5 var(--ob-font-mono); word-break:break-all; }
.ob-lib-paste textarea::placeholder { color:var(--ob-unavailable); }
.ob-lib-paste-actions { margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; }
.ob-lib-btn { padding:8px 14px; border-radius:4px; border:0; background:var(--ob-accent);
  color:#fff; font:600 11px/1 var(--ob-font-mono); letter-spacing:.06em; cursor:pointer; }
.ob-lib-btn:hover { background:#ff7c45; }
.ob-lib-btn.ghost { background:transparent; border:1px solid var(--ob-control-hover);
  color:var(--ob-text-secondary); font-weight:400; }
.ob-lib-btn.ghost:hover { color:var(--ob-text); border-color:var(--ob-dim); }
.ob-lib-ghostdrop { border:1px dashed var(--ob-control-hover); border-radius:6px;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:6px; padding:14px; text-align:center;
  font:400 13px/1.4 var(--ob-font-display); color:var(--ob-dim); }
.ob-lib-ghostdrop b { color:var(--ob-text-secondary); font-weight:500; }

.ob-lib-note { font:400 11px/1.5 var(--ob-font-mono); color:var(--ob-dim); min-height:1.4em; }
.ob-lib-note.err { color:#ff6b6b; }
.ob-lib-empty { padding:26px; text-align:center; color:var(--ob-dim);
  font:400 14px/1.5 var(--ob-font-display); }

/* The commit bar this screen does not have -- see the file header for why it
   went. The shell's own class is named in the selector deliberately: the two
   stylesheets are installed by whichever screen runs first, so their ORDER is
   not fixed, and a lone class would lose the tie against
   .ob-shell-footer's display:flex about half the time. Two classes beat one
   whatever the order is. */
.ob-shell-footer.ob-lib-no-footer { display:none; }
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

/** `1:02.410`, the frame's own format for a run time. */
function rowTime(ms: number): string {
  return formatTime(ms);
}

function rowFromDemo(bytes: Uint8Array, filename: string): Row {
  const demo = parseDm68(bytes);
  const meta: DemoMeta = demoMeta(demo, filename);
  return {
    id: `demo:${filename}`,
    name: filename,
    map: meta.map,
    // A demo's filename time is a claim by whoever named the file, and its
    // duration includes the walk to the start line -- `demoMeta` keeps them
    // apart and so does this. The claim wins when there is one, flagged so
    // the column can say which it is showing.
    timeMs: meta.filenameTimeMs ?? meta.durationMs,
    timeIsDuration: meta.filenameTimeMs === null,
    physics: meta.physics.toUpperCase(),
    // Fixed, and not a choice: a `.dm_68` is a first-person recording and
    // there is no other view in it.
    camera: 'FPV',
    source: { kind: 'demo', demo, filename, map: meta.map },
    mapPresent: false,
  };
}

function rowFromGhost(run: GhostRun, name: string): Row {
  return {
    id: `ghost:${name}:${run.map}:${run.time}`,
    name,
    map: run.map,
    timeMs: run.time,
    timeIsDuration: false,
    physics: run.physics.toUpperCase(),
    camera: run.camera.toUpperCase(),
    source: { kind: 'ghost', run, name },
    mapPresent: false,
  };
}

/**
 * Everything dropped, pasted or read since the page loaded.
 *
 * MODULE scope, not per-call, and that is the whole point: the screen is
 * shown again every time a playback session ends, and the ✕ in `Pb`/`Pc`
 * exists precisely to come back here. A per-call array meant dropping a
 * demo, watching it, and returning to an empty library -- the one journey
 * the button was built for was the one that threw the work away.
 *
 * Mounted paks already persist for the same reason (`bundledMounted` in
 * `course-select.ts`), so this only brings the recordings into line with
 * them. Not persisted across a RELOAD: a `File` handle does not survive one
 * (see `pak-ui.ts`'s note), so a demo would come back as a name with no
 * bytes behind it.
 */
const loadedRows: Row[] = [];

export async function showPlaybackLibrary(
  parent: HTMLElement,
  fs: Pk3FileSystem,
): Promise<LibraryChoice> {
  installStyle();

  const rows: Row[] = loadedRows;
  let selected: Row | null = null;
  let resolveChoice!: (choice: LibraryChoice) => void;

  /**
   * The player's own personal bests, listed automatically.
   *
   * `RecordBook.entries()` is the index -- see its own doc for why a record
   * key and a stored ghost are the same thing. A record whose ghost predates
   * the store, or was dropped, simply does not appear.
   *
   * Re-read on every visit rather than cached with the rest: a run finished
   * since the last visit is a new personal best and should be here. `addRow`
   * dedupes on the row id, so re-reading the same PB replaces it instead of
   * listing it twice.
   */
  const ghosts = new GhostStore();
  for (const entry of new RecordBook().entries()) {
    const run = ghosts.load(entry.map, entry.physics, entry.msec, entry.camera);
    if (run) {
      const row = rowFromGhost(run, `${entry.map} — personal best`);
      const at = rows.findIndex((r) => r.id === row.id);
      if (at >= 0) {
        rows[at] = row;
      } else {
        rows.push(row);
      }
    }
  }

  const shell: Shell = createShell(parent, {
    sectionLabel: 'LIBRARY',
    items: [
      { id: 'courses', label: 'Courses' },
      { id: 'playback', label: 'Playback', count: String(rows.length) },
    ],
    activeId: 'playback',
    title: 'Playback',
    status: `${rows.length} loaded`,
    onNavigate: (id) => {
      if (id === 'courses') {
        resolveChoice({ kind: 'courses' });
      }
    },
    // `resolveChoice` is assigned by the Promise executor at the bottom of
    // this function, which runs synchronously before anything can be clicked.
    onBack: () => resolveChoice({ kind: 'title' }),
  });

  // Nothing is appended to either footer group on this screen, so the shell's
  // commit bar is hidden rather than left as an empty seam. `footerLeft` and
  // `footerRight` are the only handles the shell hands out, and they are both
  // children of it.
  shell.footerLeft.parentElement?.classList.add('ob-lib-no-footer');

  // ---- drop / browse ------------------------------------------------------

  const drop = document.createElement('div');
  drop.className = 'ob-lib-drop';
  const dropText = document.createElement('p');
  dropText.append('Drop a ');
  const b1 = document.createElement('b');
  b1.textContent = '.dm_68';
  const b2 = document.createElement('b');
  b2.textContent = '.pk3';
  const b3 = document.createElement('b');
  b3.textContent = '.obghost';
  dropText.append(b1, ' demo, a ', b2, ' to mount its map, or an ', b3);
  dropText.append(
    ' — or click to browse. A demo without its map indexed can’t start playback.',
  );
  const browse = document.createElement('button');
  browse.type = 'button';
  browse.className = 'ob-lib-browse';
  browse.textContent = 'Browse files';
  drop.append(dropText, browse);
  shell.body.appendChild(drop);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.pk3,.zip,.dm_68,.obghost,.json';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  drop.appendChild(fileInput);

  const note = document.createElement('div');
  note.className = 'ob-lib-note';
  shell.body.appendChild(note);

  const say = (text: string, error = false): void => {
    note.textContent = text;
    note.classList.toggle('err', error);
  };

  // ---- the demo table -----------------------------------------------------

  const demoSection = document.createElement('div');
  const demoLabel = document.createElement('div');
  demoLabel.className = 'ob-lib-section';
  demoLabel.textContent = 'DEMOS AND GHOSTS';
  const table = document.createElement('div');
  table.className = 'ob-lib-table';
  demoSection.append(demoLabel, table);
  shell.body.appendChild(demoSection);

  // ---- the ghost row ------------------------------------------------------

  const ghostSection = document.createElement('div');
  const ghostLabel = document.createElement('div');
  ghostLabel.className = 'ob-lib-section';
  ghostLabel.textContent = 'OVERBOUNCE GHOSTS';
  const ghostGrid = document.createElement('div');
  ghostGrid.className = 'ob-lib-ghosts';

  const paste = document.createElement('div');
  paste.className = 'ob-lib-paste';
  const pasteLabel = document.createElement('div');
  pasteLabel.className = 'ob-lib-section';
  pasteLabel.style.letterSpacing = '.14em';
  pasteLabel.textContent = 'PASTE A GHOST STRING';
  const pasteBox = document.createElement('textarea');
  pasteBox.placeholder = `${SHARE_PREFIX}eJx7cGDh4uJi…`;
  pasteBox.spellcheck = false;
  const pasteActions = document.createElement('div');
  pasteActions.className = 'ob-lib-paste-actions';
  const clipboardBtn = document.createElement('button');
  clipboardBtn.type = 'button';
  clipboardBtn.className = 'ob-lib-btn';
  clipboardBtn.textContent = 'LOAD FROM CLIPBOARD';
  const pasteBtn = document.createElement('button');
  pasteBtn.type = 'button';
  pasteBtn.className = 'ob-lib-btn ghost';
  pasteBtn.textContent = 'LOAD PASTED';
  const ghostFileBtn = document.createElement('button');
  ghostFileBtn.type = 'button';
  ghostFileBtn.className = 'ob-lib-btn ghost';
  ghostFileBtn.textContent = 'BROWSE FILE';
  pasteActions.append(clipboardBtn, pasteBtn, ghostFileBtn);
  paste.append(pasteLabel, pasteBox, pasteActions);

  const ghostDrop = document.createElement('div');
  ghostDrop.className = 'ob-lib-ghostdrop';
  const gdText = document.createElement('span');
  gdText.append('Or drop a ');
  const gdB = document.createElement('b');
  gdB.textContent = '.obghost';
  gdText.append(gdB, ' file here');
  ghostDrop.appendChild(gdText);

  ghostGrid.append(paste, ghostDrop);
  ghostSection.append(ghostLabel, ghostGrid);
  shell.body.appendChild(ghostSection);

  // ---- playing ------------------------------------------------------------

  /**
   * Bundled archives still in flight.
   *
   * Every PLAY stays disabled while any are: the map list is served by a
   * small pak that mounts almost instantly while every player and weapon
   * model lives in a ~31MB one, so a playback started in the gap would load
   * with a world and no avatar. Course select carries the same guard for the
   * same reason and its comment has the full story.
   *
   * There is no header status for it in the frame, because the frame draws a
   * library that has finished loading. It goes in the status slot rather than
   * beside the list: it describes the whole screen, and "6 loaded" -- which it
   * replaces while it shows -- is not true yet anyway.
   */
  let pendingMounts = 0;
  const setPending = (delta: number): void => {
    pendingMounts += delta;
    render();
  };

  /**
   * Both conditions that stop a row starting, in one place.
   *
   * Two callers need exactly this predicate and a third would be easy to
   * forget: the PLAY button's `disabled`, the row's double-click, and `play`
   * itself. A native `disabled` button dispatches no click at all, which
   * covers the first two by accident -- and "by accident" is the reason the
   * double-click path asks again rather than trusting it.
   */
  const canPlay = (row: Row): boolean => row.mapPresent && pendingMounts === 0;

  /**
   * Start `row`, once.
   *
   * The guard is not paranoia. A double-click on the PLAY button itself is a
   * click that resolves and disposes the shell, followed by a `dblclick` that
   * still dispatches -- the detached tree keeps its listeners, and the table's
   * delegated handler is on it -- so without `started` the same gesture
   * resolves the choice twice and disposes a shell that is already gone.
   */
  let started = false;
  const play = (row: Row): void => {
    if (started || !canPlay(row)) {
      return;
    }
    started = true;
    resolveChoice({ kind: 'play', source: row.source });
  };

  // ---- rendering ----------------------------------------------------------

  function restatus(): void {
    const maps = new Set(fs.listMaps());
    for (const row of rows) {
      row.mapPresent = row.map !== '' && maps.has(row.map.toLowerCase());
    }
  }

  function render(): void {
    restatus();

    // A selection outlives a repaint but not the row it points at. Nothing
    // removes a row today; this costs one scan and is one fewer invariant to
    // hold by hand. It does NOT clear a selection whose map went away --
    // selection is a highlight now, not an armed action, so a row that cannot
    // play can still be the one the player is looking at.
    if (selected && !rows.some((r) => r.id === selected?.id)) {
      selected = null;
    }

    table.innerHTML = '';

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ob-lib-empty';
      empty.textContent =
        'No demos or ghosts yet. Drop a .dm_68 above, paste a ghost string, ' +
        'or set a personal best on a course and it will appear here.';
      table.appendChild(empty);
    } else {
      const head = document.createElement('div');
      head.className = 'ob-lib-head';
      for (const label of ['DEMO', 'MAP', 'TIME', 'PHYS', 'CAM', 'STATUS', '']) {
        const span = document.createElement('span');
        span.textContent = label;
        head.appendChild(span);
      }
      table.appendChild(head);

      for (const row of rows) {
        const el = document.createElement('div');
        el.className = 'ob-lib-row';
        el.classList.toggle('active', selected?.id === row.id);
        // How the delegated click and double-click handlers below find their
        // row: they run long after this element was built, and possibly on an
        // element built by a LATER render than the one they started in.
        el.dataset.rowId = row.id;

        const cell = (cls: string, text: string): HTMLElement => {
          const span = document.createElement('span');
          span.className = cls;
          span.textContent = text;
          return span;
        };
        const time = cell('t', rowTime(row.timeMs));
        if (row.timeIsDuration) {
          // A duration is not a run time, and a column that showed one as the
          // other would be quietly lying about somebody's record. Dimmed and
          // titled rather than blank, because the number is still useful.
          time.classList.add('dur');
          time.title = 'Full demo length — this file does not claim a run time';
        }

        const status = document.createElement('span');
        status.className = `ob-lib-status ${row.mapPresent ? 'ok' : 'missing'}`;
        const dot = document.createElement('span');
        dot.className = 'dot';
        status.append(dot, row.mapPresent ? 'Map loaded' : 'Map missing');
        if (!row.mapPresent) {
          status.title = `Drop a .pk3 containing maps/${row.map}.bsp to play this`;
        }

        // No listener of its own: the click that starts a row is caught by
        // the table's delegated handler, along with the double-click that
        // means the same thing. See the handlers below for why.
        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'ob-lib-play';
        playBtn.textContent = 'PLAY';
        playBtn.disabled = !canPlay(row);
        if (!row.mapPresent) {
          playBtn.title = status.title;
        } else if (pendingMounts > 0) {
          // The one case where a green "Map loaded" sits beside a dim PLAY,
          // which without this reads as a contradiction: the MAP is there and
          // the player models are not.
          playBtn.title = 'Still loading the bundled archives…';
        }

        el.append(
          cell('n', row.name),
          cell('m', row.map || '—'),
          time,
          cell('k', row.physics),
          cell('k', row.camera),
          status,
          playBtn,
        );
        table.appendChild(el);
      }
    }

    shell.setStatus(
      pendingMounts > 0
        ? `Loading ${pendingMounts} archive${pendingMounts === 1 ? '' : 's'}…`
        : `${rows.length} loaded`,
    );
    shell.setItems([
      { id: 'courses', label: 'Courses' },
      { id: 'playback', label: 'Playback', count: String(rows.length) },
    ]);
  }

  // ---- row gestures -------------------------------------------------------

  /**
   * Which row an event happened in, resolved at HANDLE time.
   *
   * Both handlers below are on the table rather than on a row, because a row
   * element does not survive a repaint: `render` empties the table and builds
   * every row again, so a listener bound to the element a gesture STARTED on
   * would be watching a detached node by the time the gesture finished. The
   * table itself is created once per screen and only ever emptied, so it
   * outlives every row it holds -- which is the whole requirement for a
   * detector (`.agent/docs/playback-screens.md`, trap 10, where a keyframe
   * lane learned this the expensive way).
   *
   * That leaves the row's IDENTITY to recover, which is what `data-row-id` is
   * for. A row object is looked up fresh rather than captured, so the click
   * acts on the row as it is now, not as it was when it was drawn.
   */
  const rowAt = (target: EventTarget | null): Row | null => {
    if (!(target instanceof Element)) {
      return null;
    }
    const el = target.closest('.ob-lib-row');
    const id = el instanceof HTMLElement ? el.dataset.rowId : undefined;
    return id === undefined ? null : (rows.find((r) => r.id === id) ?? null);
  };

  /**
   * Move the highlight without rebuilding the list.
   *
   * Selection is the one thing that changes on the FIRST click of a double
   * click, and a full `render` there would replace the row element between
   * the two presses -- which is how a browser ends up sending the pair to two
   * different nodes, and a `dblclick` to whatever ancestor they have in
   * common. The delegated handler below survives that either way; not causing
   * it in the first place is simply cheaper and does not flicker. Everything
   * else the list draws is a function of the recordings and the filesystem,
   * neither of which a click changes.
   */
  const paintSelection = (): void => {
    for (const el of table.querySelectorAll<HTMLElement>('.ob-lib-row')) {
      el.classList.toggle('active', el.dataset.rowId === selected?.id);
    }
  };

  /*
   * A single click selects; PLAY, and a double-click anywhere in the row,
   * starts it.
   *
   * A double-click IS two single clicks -- the first one always fires -- so
   * the two gestures cannot both be actions or they fight each other (trap
   * 13: a lane that created on click and destroyed on double-click ended a
   * double-click exactly where it started, with nothing on screen to say
   * why). Selection is the safe half of that pair: it is idempotent, so
   * firing it once on the way to a double-click changes nothing, and the row
   * the second press lands in is by definition the row the first press just
   * selected. "Select, then play" is therefore one continuous reading of the
   * gesture rather than two contradictory ones.
   *
   * Selection no longer arms anything -- the footer's "Start playback" is
   * gone -- so it is purely the highlight that says which row the pointer
   * settled on. Any row can have it, including one that cannot play: a click
   * that visibly does nothing reads as a click that was not received.
   */
  table.addEventListener('click', (e) => {
    const row = rowAt(e.target);
    if (!row) {
      return;
    }
    if (e.target instanceof Element && e.target.closest('.ob-lib-play')) {
      play(row);
      return;
    }
    selected = row;
    paintSelection();
  });
  table.addEventListener('dblclick', (e) => {
    const row = rowAt(e.target);
    if (row) {
      // `play` re-checks `canPlay` itself. A disabled button dispatches no
      // events at all, so the PLAY pill of an unplayable row cannot get here
      // -- but the rest of its row can, and a double-click there must not
      // start a recording whose map is missing either.
      play(row);
    }
  });

  // ---- ingesting ----------------------------------------------------------

  function addRow(row: Row): void {
    const existing = rows.findIndex((r) => r.id === row.id);
    if (existing >= 0) {
      rows[existing] = row;
    } else {
      rows.unshift(row);
    }
    restatus();
    // Highlight what was just added, whether or not it can play. It is the
    // answer to "did my file land?", which is a question a dropped demo with
    // a missing map has just as much as a playable one -- and the highlight
    // commits the player to nothing now that it does not arm a button.
    const added = rows.find((r) => r.id === row.id);
    if (added) {
      selected = added;
    }
    render();
  }

  async function ingestGhostText(text: string, label: string): Promise<void> {
    if (!looksLikeGhostShare(text)) {
      say(`That does not look like an Overbounce ghost (it should start "${SHARE_PREFIX}").`, true);
      return;
    }
    const run = await decodeGhostShare(text);
    if (!run) {
      say('That ghost string could not be decoded — it may be truncated.', true);
      return;
    }
    addRow(rowFromGhost(run, label));
    say(`Loaded a ${(run.time / 1000).toFixed(3)}s ghost on ${run.map}.`);
  }

  async function ingestFile(file: File): Promise<void> {
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith('.pk3') || lower.endsWith('.zip')) {
        setPending(1);
        try {
          // A player's own archive outranks the bundled kit, exactly as
          // course select's drop region says it does.
          await fs.mount(file.name, file, PakGroup.Addon);
          say(`Mounted ${file.name}.`);
        } finally {
          setPending(-1);
        }
        render();
        return;
      }
      if (lower.endsWith('.dm_68')) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        addRow(rowFromDemo(bytes, file.name));
        say(`Read ${file.name}.`);
        return;
      }
      if (lower.endsWith('.obghost') || lower.endsWith('.json') || lower.endsWith('.txt')) {
        await ingestGhostText(await file.text(), file.name);
        return;
      }
      say(`${file.name}: not a .pk3, a .dm_68 or a .obghost.`, true);
    } catch (err) {
      // A hand-supplied file is untrusted input, and a corrupt demo throwing
      // must not take the screen down with it -- same standing course select
      // gives a malformed `.pk3`.
      say(`${file.name}: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  const ingestAll = async (files: FileList | readonly File[]): Promise<void> => {
    for (const file of Array.from(files)) {
      await ingestFile(file);
    }
  };

  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) {
      void ingestAll(fileInput.files);
    }
    fileInput.value = '';
  });
  ghostFileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  for (const zone of [drop, ghostDrop]) {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragging');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragging');
      if (e.dataTransfer?.files) {
        void ingestAll(e.dataTransfer.files);
      }
    });
  }

  /*
   * A drop ANYWHERE else on the screen is also accepted, and the default is
   * suppressed everywhere -- without this, a near-miss on the drop zone makes
   * the browser NAVIGATE to the file, which throws away the whole session and
   * looks exactly like a crash.
   */
  shell.body.addEventListener('dragover', (e) => e.preventDefault());
  shell.body.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) {
      void ingestAll(e.dataTransfer.files);
    }
  });

  pasteBtn.addEventListener('click', () => {
    void ingestGhostText(pasteBox.value, 'Pasted ghost');
  });
  // A paste INTO the box loads immediately: that is the whole gesture, and
  // making someone paste and then press a button is a step for nothing.
  pasteBox.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (text) {
      e.preventDefault();
      pasteBox.value = text;
      void ingestGhostText(text, 'Pasted ghost');
    }
  });
  clipboardBtn.addEventListener('click', () => {
    void (async (): Promise<void> => {
      try {
        const text = await navigator.clipboard.readText();
        pasteBox.value = text;
        await ingestGhostText(text, 'Pasted ghost');
      } catch {
        // Reading the clipboard needs permission and a user gesture, and
        // Firefox refuses it outright. The textarea is the fallback and it
        // is right there, so say so rather than failing silently.
        say('Could not read the clipboard — paste into the box instead.', true);
      }
    })();
  });

  mountBundledPaks(fs, setPending, render);
  render();

  return new Promise<LibraryChoice>((resolve) => {
    resolveChoice = (choice): void => {
      shell.dispose();
      resolve(choice);
    };
  });
}
