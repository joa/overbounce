/**
 * Take a screenshot of the game, in an isolated browser.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run shot -- --map q3dm6 --at -576,-256,40 --out shots/quad.png
 *   npm run shot -- --url ... --click            # grab pointer lock first
 *   npm run shot -- --map q3dm7 --at 100,200,300,90 --params "post=off"
 *   npm run shot -- --map q3dm6 --params camera=fpv --press Digit1 --hold  # MID-shot
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

const { problems, hud, console: consoleLines, evaluated } = await withPage(
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
    let locked = false;
    const ensureLocked = async (): Promise<void> => {
      if (!locked) {
        locked = true;
        await grabPointerLock(session.page);
      }
    };
    if (flag('click')) {
      await ensureLocked();
    }

    /*
     * `--press <keys>` -- key presses before the shot, comma separated.
     *
     * Key CODES, the ones `input.ts` reads: `Digit1` arms the machine gun,
     * `Digit2` the rocket launcher, and so on down `WEAPON_SLOTS`. Which gun
     * is held is not a URL parameter and is not going to be one, but it
     * decides things a screenshot is taken to answer -- the muzzle flash is
     * the plain case, since a 20ms flash behind an 800ms rocket refire is
     * visible in one frame in forty and behind the machine gun's 100ms in one
     * in five.
     *
     * Implies pointer lock, like `--fire`: the game ignores every key it is
     * not locked for.
     */
    const press = arg('press');
    if (press) {
      await ensureLocked();
      for (const key of press.split(',').map((k) => k.trim()).filter(Boolean)) {
        // Cast because puppeteer types `press` against its own union of every
        // known key name, and this one comes off a command line. A typo is
        // rejected at runtime by puppeteer with the name in the message, which
        // is a better error than anything a narrowing here would produce.
        await session.page.keyboard.press(key as Parameters<typeof session.page.keyboard.press>[0]);
        // A beat between presses. `consumePressed` is drained once per FRAME,
        // so two presses inside one frame are one press as far as the game is
        // concerned -- which silently drops whichever came second.
        await new Promise((r) => setTimeout(r, 60));
      }
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
      await ensureLocked();
      // HELD for 150ms, not clicked: `input.attack` is sampled once per frame
      // and a press+release in the same instant can fall between two samples
      // and fire nothing at all. See `light-pool.ts` for the hour that cost.
      await session.page.mouse.down();
      await new Promise((r) => setTimeout(r, 150));
      await session.page.mouse.up();
      await new Promise((r) => setTimeout(r, Math.max(0, Number(fire) - 150)));
    }

    /*
     * `--hold` -- keep the trigger DOWN through the settle and the capture.
     *
     * `--fire` above answers "what did the shot leave behind": a rocket in
     * flight, a scorch on a wall, a light that outlives the frame it was born
     * in. It cannot answer anything about the act of firing itself, because it
     * releases the button and then waits. The muzzle flash is the case that
     * forced this: `MUZZLE_FLASH_TIME` is 20ms, and by the time `--fire`'s
     * wait is over the flash has been gone for a hundred of them.
     *
     * Held instead, a weapon with a 100ms refire (the machine gun, the plasma
     * gun -- which is what a fresh spawn is holding) keeps a 20ms flash on
     * screen about a fifth of the time, so the shot is a coin flip rather than
     * a certainty. TAKE SEVERAL. That is a real limitation of this flag and
     * not a bug in whatever you are looking at: a single dark frame proves
     * nothing either way, which is the mistake this comment exists to stop.
     */
    if (flag('hold')) {
      await ensureLocked();
      await session.page.mouse.down();
    }

    await new Promise((r) => setTimeout(r, Number(arg('settle', '2000'))));
    await hideHud(session.page);

    /*
     * `--eval <expression>` -- read page state alongside the picture.
     *
     * A screenshot answers "does this look right", and a surprising amount of
     * the time the question is "is it drawing at all", which a picture answers
     * badly: an effect can be present and subtle, or absent and replaced by
     * something that moved. This prints whatever the expression evaluates to,
     * so the two questions stop being conflated.
     */
    const expression = arg('eval');
    const evaluated = expression
      ? await session.page.evaluate(
          // AWAITED before stringifying. An expression that returns a promise
          // -- which is how you ask a question about a LATER frame, such as
          // "is this still alive in 600ms" -- otherwise stringifies to `{}`
          // and reads as an empty answer rather than as a pending one.
          async (src: string) =>
            JSON.stringify(
              (await (0, eval)(src)) as unknown,
              (_k, v: unknown) => (typeof v === 'number' ? Number(v.toFixed(3)) : v),
            ),
          expression,
        )
      : null;

    const hudText = await readHud(session.page);
    mkdirSync(dirname(out), { recursive: true });
    const png = await session.page.screenshot({ type: 'png' });
    writeFileSync(out, png);

    return {
      problems: session.problems,
      hud: hudText,
      console: session.console,
      evaluated,
    };
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
if (evaluated !== null) {
  console.log(`eval ${evaluated}`);
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
