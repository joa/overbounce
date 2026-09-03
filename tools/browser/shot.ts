/**
 * Take a screenshot of the game, in an isolated browser.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run shot -- --map q3dm6 --at -576,-256,40 --out shots/quad.png
 *   npm run shot -- --url ... --click            # grab pointer lock first
 *   npm run shot -- --map q3dm7 --at 100,200,300,90 --params "post=off"
 *   npm run shot -- --url "http://localhost:5180/?devpak=..." --out a.png
 *
 * Prints the HUD text and any console errors alongside the file it wrote.
 * The errors are not decoration: a WGSL compile failure produces a surface
 * that silently does not draw, which is invisible in a picture and obvious in
 * the log. Several hours were spent on a bug that this would have surfaced in
 * one command.
 *
 * Exits non-zero if the page reported errors, so it can gate a check.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { grabPointerLock, hideHud, readHud, withPage } from './session.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const port = arg('port', '5180');
const map = arg('map', 'q3dm6');
const out = resolve(arg('out', `shots/${map}.png`));

let url = arg('url');
if (!url) {
  const p = new URLSearchParams({
    devpak: arg('devpak', `dev-${map}.pk3`),
    map,
    player: arg('player', 'doom'),
  });
  const at = arg('at');
  if (at) {
    p.set('at', at);
  }
  // Free-form extras, e.g. --params "post=off&ssao=off".
  for (const [k, v] of new URLSearchParams(arg('params'))) {
    p.set(k, v);
  }
  url = `http://localhost:${port}/?${p.toString()}`;
}

console.log(`url  ${url}`);

const { problems, hud, console: consoleLines } = await withPage(
  url,
  async (session) => {
    // A couple of seconds of settling: items bob, shaders animate, and the
    // first frame is not representative of anything.
    /*
     * `--click` grabs pointer lock before settling.
     *
     * Anything gated on `input.locked` is invisible without it, and that is not
     * a small set: the aim laser, the crosshair, and every input the game only
     * accepts while playing. A first-person shot taken WITHOUT this looked
     * perfect while the laser was in fact still being drawn -- the harness was
     * hiding the bug rather than the code being right.
     */
    if (flag('click')) {
      await grabPointerLock(session.page);
    }

    /*
     * `--fire <ms>` -- one rocket, then wait that long before the shot.
     *
     * A DYNAMIC light only exists while something is in flight, so every
     * question about one ("does its shadow cast?", "does `?lightscale` do
     * anything?") is unanswerable from a still of a standing player: the pool
     * is parked at intensity 0. Implies `--click`, because firing is a click
     * and the first one is spent on pointer lock.
     */
    const fire = arg('fire');
    if (fire) {
      if (!flag('click')) {
        await grabPointerLock(session.page);
      }
      // HELD for 150ms, not clicked: `input.attack` is sampled once per frame
      // and a press+release in the same instant can fall between two samples
      // and fire nothing at all. See `light-pool.ts` for the hour that cost.
      await session.page.mouse.down();
      await new Promise((r) => setTimeout(r, 150));
      await session.page.mouse.up();
      await new Promise((r) => setTimeout(r, Math.max(0, Number(fire) - 150)));
    }

    await new Promise((r) => setTimeout(r, Number(arg('settle', '2000'))));
    await hideHud(session.page);

    const hudText = await readHud(session.page);
    mkdirSync(dirname(out), { recursive: true });
    const png = await session.page.screenshot({ type: 'png' });
    writeFileSync(out, png);

    return { problems: session.problems, hud: hudText, console: session.console };
  },
  { headful: flag('headful'), width: Number(arg('width', '1280')), height: Number(arg('height', '720')) },
);

console.log(`shot ${out}`);

// `--log <substring>` prints matching console output. The tool otherwise shows
// only problems, which is right for routine use and useless when you are
// deliberately instrumenting something.
const filter = arg('log');
if (filter) {
  const hits = consoleLines.filter((l) => l.includes(filter));
  console.log(`
${hits.length} console line(s) matching "${filter}":`);
  for (const l of hits.slice(0, Number(arg('logmax', '40')))) {
    console.log(`  ${l.slice(0, 300)}`);
  }
}
if (hud) {
  console.log(hud.split('\n').map((l) => `hud  ${l}`).join('\n'));
}

if (problems.length) {
  // Deduplicated: a failing pipeline logs the same message once per frame, and
  // fifty identical lines hide the second distinct problem.
  const seen = new Map<string, number>();
  for (const p of problems) {
    seen.set(p, (seen.get(p) ?? 0) + 1);
  }
  console.log(`\n${seen.size} distinct problem(s):`);
  for (const [line, n] of seen) {
    console.log(`  ${n > 1 ? `(x${n}) ` : ''}${line.slice(0, 300)}`);
  }
  process.exit(1);
}

console.log('\nno console errors');
