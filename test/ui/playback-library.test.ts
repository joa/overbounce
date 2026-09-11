/**
 * The playback library's row gesture: a click selects, a double-click plays.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * @vitest-environment happy-dom
 *
 * Two traps from `.agent/docs/playback-screens.md` meet on this one row, and
 * both of them typecheck, lint and pass every other test in the suite while
 * broken -- which is exactly why they are worth a test that drives the DOM:
 *
 *  - **Trap 10**: a detector must outlive what it detects on. The screen
 *    answers this twice over -- the handlers are delegated to the table,
 *    which is emptied rather than replaced, AND selecting a row no longer
 *    repaints the list at all, so the two presses of a double click land on
 *    one element. The second half is what the `toBe(first)` assertion in the
 *    first test below pins, by identity: a repaint there is what sends a
 *    browser's two clicks to two different nodes in the first place.
 *  - **Trap 13**: the first click must not do something the second one undoes.
 *    Selection is idempotent, so the row is still selected when playback
 *    starts, and the run that starts is the row that was clicked.
 *
 * A stub filesystem stands in for real paks: what the screen asks it is
 * `listMaps()`, and what a row does with the answer is the whole of
 * "is this playable". Mounting a genuine archive would test the zip reader
 * again and this gesture not at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showPlaybackLibrary } from '../../src/ui/screens/playback-library.js';
import type { LibraryChoice } from '../../src/ui/screens/playback-library.js';
import { encodeGhostShare } from '../../src/game/ghost-share.js';
import type { GhostRun } from '../../src/game/ghost.js';
import type { Pk3FileSystem } from '../../src/assets/pk3.js';
import { ENTITYNUM_NONE, PMOVE_MSEC } from '../../src/physics/constants.js';
import { Weapon } from '../../src/game/weapons.js';

/** The one map the stub filesystem admits to having. */
const MOUNTED = 'ob_testmap';

function ghostOn(map: string): GhostRun {
  return {
    version: 1,
    map,
    physics: 'vq3',
    camera: 'side',
    time: 4 * PMOVE_MSEC,
    msec: PMOVE_MSEC,
    start: {
      origin: [0, 0, 64],
      velocity: [0, 0, 0],
      viewangles: [0, 0, 0],
      deltaAngles: [0, 0, 0],
      pmFlags: 0,
      pmTime: 0,
      pmType: 0,
      groundEntityNum: ENTITYNUM_NONE,
      gravity: 800,
      speed: 320,
      jumppadFrame: 0,
      doubleJumpTime: 0,
      jumppadEnt: 0,
      health: 100,
      armor: 0,
      ammo: [0, 0, 0, 0, 0, 0],
      powerups: [],
    },
    ticks: Array.from({ length: 4 }, () => ({
      forward: 127,
      right: 0,
      up: 0,
      yaw: 0,
      pitch: 0,
      attack: false,
      weapon: Weapon.ROCKET_LAUNCHER,
    })),
    splits: [],
    date: '2026-09-11T00:00:00.000Z',
  };
}

/**
 * Only `listMaps` is reached, and `mount` only if something is dropped.
 * Duck-typed through `unknown` rather than constructed, because a real
 * `Pk3FileSystem` with a map in it means a real archive.
 */
function stubFs(): Pk3FileSystem {
  return {
    listMaps: (): string[] => [MOUNTED],
    mount: (): Promise<void> => Promise.resolve(),
  } as unknown as Pk3FileSystem;
}

/**
 * Paste a ghost in through the box, and wait for the screen to come to rest.
 *
 * Two things are being waited for and both matter. The row itself arrives
 * asynchronously (the codec inflates through a stream), and it is identified
 * by its MAP rather than by "a row exists" -- the screen's loaded list is
 * deliberately module scope, so the row a previous test pasted is still
 * there. And the bundled-archive count has to reach zero, because PLAY stays
 * disabled while any mount is in flight; asserting on the button before then
 * would be reading a state the screen is about to leave.
 */
async function pasteGhost(run: GhostRun): Promise<void> {
  const box = document.querySelector('.ob-lib-paste textarea');
  const buttons = Array.from(document.querySelectorAll('.ob-lib-paste-actions button'));
  const loadPasted = buttons.find((b) => b.textContent === 'LOAD PASTED');
  if (!(box instanceof HTMLTextAreaElement) || !(loadPasted instanceof HTMLButtonElement)) {
    throw new Error('the paste box is not where this test expects it');
  }
  box.value = await encodeGhostShare(run);
  loadPasted.click();
  for (let i = 0; i < 500; i++) {
    const newest = document.querySelector('.ob-lib-row .m')?.textContent;
    const status = document.querySelector('.ob-shell-status')?.textContent ?? '';
    if (newest === run.map && !status.startsWith('Loading')) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`no settled row for ${run.map}`);
}

/** The live row element, re-queried -- see trap 10 in the file header. */
function rowEl(): HTMLElement {
  const el = document.querySelector('.ob-lib-row');
  if (!(el instanceof HTMLElement)) {
    throw new Error('no row rendered');
  }
  return el;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/**
 * The three events a real double-click is: click, click, dblclick.
 *
 * happy-dom does not synthesise the third from the first two, so all three
 * are dispatched by hand -- and the target is RE-QUERIED before each one,
 * because that is what a browser does. A browser hit-tests every event
 * against whatever is under the cursor at the moment it sends it, so when the
 * first click repaints the list, events two and three go to the replacement.
 * Holding one element across all three sends the last two into a detached
 * node with no parent to bubble to, which is this test failing for the
 * component's reason rather than its own -- it happened, on the first run.
 */
function doubleClick(pick: () => Element): void {
  click(pick());
  click(pick());
  pick().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

describe('the playback library', () => {
  beforeEach(() => {
    // Nothing bundled is fetchable in Node, and `mountBundledPaks` treats a
    // failed fetch as "that pak is not there", which is the state this test
    // wants anyway. Answering rather than rejecting keeps the console clean.
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false } as Response));
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('starts a playable row on double-click, having selected it on the first click', async () => {
    const fs = stubFs();
    let resolved: LibraryChoice | null = null;
    const choice = showPlaybackLibrary(document.body, fs);
    void choice.then((c) => {
      resolved = c;
    });

    await pasteGhost(ghostOn(MOUNTED));

    const first = rowEl();
    expect(first.querySelector('.ob-lib-play')).toHaveProperty('disabled', false);

    click(first.querySelector('.n') as Element);
    expect(rowEl().classList.contains('active')).toBe(true);
    // Selecting highlights in place: same element, class toggled. This is the
    // assertion that keeps the double click landing on ONE node -- see trap
    // 10 in the file header -- and it is an identity check because that is
    // the only thing a rebuilt-but-identical-looking row would fail.
    expect(rowEl()).toBe(first);
    // And it arms nothing: the screen does not resolve on a single click.
    expect(resolved).toBe(null);

    doubleClick(() => rowEl());

    const got = await choice;
    expect(got.kind).toBe('play');
    expect(got.kind === 'play' && got.source.kind === 'ghost' && got.source.run.map).toBe(MOUNTED);
  });

  it('will not start a row whose map is missing, by either gesture', async () => {
    const fs = stubFs();
    let resolved: LibraryChoice | null = null;
    const choice = showPlaybackLibrary(document.body, fs);
    void choice.then((c) => {
      resolved = c;
    });

    await pasteGhost(ghostOn('a_map_nobody_has'));

    const play = rowEl().querySelector('.ob-lib-play');
    expect(play).toHaveProperty('disabled', true);
    expect(rowEl().querySelector('.ob-lib-status.missing')?.textContent).toContain('Map missing');

    doubleClick(() => rowEl());
    // The PLAY pill too: a disabled button dispatches nothing in a real
    // browser, but a hand-dispatched event still reaches the delegated
    // listener, which is the stricter case and the one worth asserting.
    doubleClick(() => rowEl().querySelector('.ob-lib-play') as Element);
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(null);

    // Leave through the header's Back so the screen tears itself down the
    // way it does in the app, rather than being orphaned in the document.
    const back = document.querySelector('.ob-shell-back button');
    (back as HTMLButtonElement).click();
    expect((await choice).kind).toBe('title');
  });
});
