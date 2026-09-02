/**
 * Photo mode must be a still picture. This proves it, or shows what moved.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run photo-still -- --map q3dm6
 *   npm run photo-still -- --map q3ctf2 --out shots/photo-still --wait 3000
 *   npm run photo-still -- --map q3dm6 --paused        # the pause dialog alone
 *
 * Loads the map, takes pointer lock, releases it (which opens PAUSED), presses
 * the Photo mode button unless `--paused`, and then captures the canvas twice
 * `--wait` ms apart. The two captures must be byte-identical: the visual clock
 * is frozen whenever the simulation is (see `.agent/plans/PHOTO-MODE.md`,
 * "Nothing moves"), so anything that differs is something still running on a
 * clock of its own. Exits non-zero if they differ, and writes both files so
 * the difference can be looked at.
 *
 * The HUD, the dialog and the photo panel are hidden for the captures. A
 * canvas screenshot includes whatever DOM sits over the canvas, and two of
 * those are meant to keep moving: the debug panel's cpu/fps/draws readouts
 * and the resume button's glow. Leaving them in measures the chrome instead
 * of the world.
 *
 * One headless-Chrome detail this depends on: Escape does not reach the
 * browser's own pointer-lock handling there, so the lock is released from the
 * page with `document.exitPointerLock()`. The game sees the same event.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withPage } from './session.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = arg('port', '5180');
const map = arg('map', 'q3dm6');
const pausedOnly = process.argv.includes('--paused');
const wait = Number(arg('wait', '3000'));
const outDir = resolve(arg('out', 'shots/photo-still'));

const p = new URLSearchParams({
  devpak: arg('devpak', `dev-${map}.pk3`),
  map,
  player: arg('player', 'doom'),
});
const at = arg('at');
if (at) {
  p.set('at', at);
}
for (const [k, v] of new URLSearchParams(arg('params'))) {
  p.set(k, v);
}
const url = `http://localhost:${port}/?${p.toString()}`;
console.log(`url  ${url}`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const result = await withPage(
  url,
  async (session) => {
    const { page } = session;
    await sleep(2000);
    await page.click('canvas');
    await sleep(800);
    const locked = await page.evaluate(() => document.pointerLockElement !== null);
    await page.evaluate(() => document.exitPointerLock());
    await sleep(800);
    await page.waitForSelector('[data-paused-photo]', { visible: true, timeout: 5000 });
    if (!pausedOnly) {
      await page.evaluate(() => {
        (document.querySelector('[data-paused-photo]') as HTMLButtonElement).click();
      });
    }
    await sleep(1500);
    const inPhoto = pausedOnly
      ? true
      : await page.evaluate(() => document.querySelector('.ob-photo') !== null);

    /*
     * EVERY DOM OVERLAY OFF before the two captures, and this is not
     * cosmetic: `canvas.screenshot()` grabs the canvas's bounding box out of
     * a PAGE screenshot, so anything drawn over the canvas is in the picture.
     * With the chrome left up, PAUSED "differed" on two things that are
     * supposed to differ -- the debug panel's cpu/fps/draws readouts, which
     * measure real frames, and the ESC RESUME button's CSS glow -- and the
     * rendered world underneath was already still. Hiding the chrome changes
     * no game state (`photo-hidden` is the class photo mode itself uses), and
     * makes the comparison about the thing being asserted.
     */
    await page.evaluate(() => {
      document.querySelector('.ob-hud')?.classList.add('photo-hidden');
      for (const el of document.querySelectorAll('.ob-photo, .ob-hint')) {
        (el as HTMLElement).style.display = 'none';
      }
    });
    await sleep(300);

    const canvas = await page.$('canvas');
    if (!canvas) {
      throw new Error('no canvas');
    }
    const a = await canvas.screenshot({ type: 'png' });
    await sleep(wait);
    const b = await canvas.screenshot({ type: 'png' });
    mkdirSync(outDir, { recursive: true });
    const stem = `${map}${pausedOnly ? '-paused' : ''}`;
    writeFileSync(resolve(outDir, `${stem}-a.png`), a);
    writeFileSync(resolve(outDir, `${stem}-b.png`), b);
    return {
      locked,
      inPhoto,
      same: Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0,
      problems: session.problems,
    };
  },
  { width: Number(arg('width', '1280')), height: Number(arg('height', '720')) },
);

console.log(
  `lock ${result.locked ? 'taken' : 'NOT taken'}, ` +
    (pausedOnly ? 'PAUSED' : `photo mode ${result.inPhoto ? 'open' : 'NOT open'}`) +
    `, captures ${wait}ms apart ${result.same ? 'identical' : 'DIFFER'} -> ${outDir}`,
);
if (!result.locked || !result.inPhoto) {
  console.log('the harness did not reach photo mode; the comparison means nothing');
  process.exit(2);
}
process.exit(result.same ? 0 : 1);
