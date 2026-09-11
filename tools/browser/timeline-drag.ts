/**
 * Press, move, release -- on every handle the playback timeline has.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run timeline-drag            # assert every gesture, exit non-zero on a miss
 *   npm run timeline-drag -- --open  # serve the fixture and stop, to drag it by hand
 *
 * WHY THIS EXISTS, and why it is puppeteer rather than a vitest file.
 *
 * The in/out markers were reported unusable three times, and each fix was
 * "verified" without a real drag ever having happened. The reasons are worth
 * writing down, because they rule out the two cheaper options:
 *
 *  - A SYNTHETIC `PointerEvent` cannot test this. `setPointerCapture` either
 *    throws or silently declines to capture for a pointer that is not
 *    actually down -- which one depends on the engine version -- so the exact
 *    line this file exists to exercise is the one a dispatched event cannot
 *    reach. happy-dom does not implement capture retargeting at all.
 *  - The browser automation this repo usually drives has a `left_click_drag`
 *    that emits move-then-press and never releases (probed:
 *    `[["pointermove",25],["pointerdown",25]]`), so it cannot express a drag.
 *
 * Puppeteer's mouse goes through CDP `Input.dispatchMouseEvent`, which is
 * trusted input: a real pointer id, real capture, real retargeting. That is
 * the only path that tells the truth here.
 *
 * THE BUG THIS PINS. The markers are children of the ruler, and the ruler is
 * draggable too. Both handlers ran on one press and both called
 * `setPointerCapture`; the last call of a dispatch wins, so capture landed on
 * the RULER. Every move and the release went there -- the ruler scrubbed, the
 * marker never moved, and its `dragging` flag stayed true forever because its
 * own `pointerup` had been delivered somewhere else. So the discriminating
 * assertion is not "the in point changed": it is **the in point changed AND
 * the playhead did not**. A test that only checks the first passes on the
 * broken build, because the broken build moves the in point on the press.
 */

import puppeteer from 'puppeteer';
import type { ConsoleMessage, Page } from 'puppeteer';
import { createServer } from 'vite';
import { WEBGPU_ARGS } from './session.js';

/** The fixture's clip length. Shared so a pixel can be turned back into a time. */
const DURATION = 20_000;

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

interface Snapshot {
  playhead: number;
  inPoint: number;
  outPoint: number;
  keys: number[];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) {
    failures.push(name);
  }
}

/** What the fixture is publishing right now. */
async function read(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const d = document.body.dataset;
    return {
      playhead: Number(d.playhead),
      inPoint: Number(d.in),
      outPoint: Number(d.out),
      keys: (d.keys ?? '').split(',').filter(Boolean).map(Number),
    };
  });
}

async function rect(page: Page, selector: string): Promise<Rect> {
  const found = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) {
      return null;
    }
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
  if (!found) {
    throw new Error(`no element matched ${selector}`);
  }
  return found;
}

/**
 * A real press, a real move, a real release.
 *
 * `steps` matters: a single jump to the destination is one `pointermove`, and
 * the drag-slop logic wants to see a press that travels. Ten steps is what a
 * hand does.
 */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 10 });
  await page.mouse.up();
}

async function inOutMarkers(page: Page): Promise<void> {
  const ruler = await rect(page, '.ob-pb-ruler');
  const y = ruler.y + ruler.height / 2;
  const before = await read(page);

  // The in marker sits at 0%, so its 12px grip straddles the ruler's left
  // edge -- aim inside it, not at the middle of a handle that is half off.
  await drag(page, [ruler.x + 3, y], [ruler.x + ruler.width * 0.25, y]);
  const afterIn = await read(page);
  check(
    'in marker follows the pointer',
    afterIn.inPoint > before.inPoint + 1000,
    `in ${before.inPoint} -> ${afterIn.inPoint}`,
  );
  check(
    'in marker does not hand the drag to the scrubber',
    afterIn.playhead === before.playhead,
    `playhead ${before.playhead} -> ${afterIn.playhead}`,
  );
  check(
    'in marker leaves the keyframes alone',
    afterIn.keys.join() === before.keys.join(),
    `keys ${afterIn.keys.join(' ')}`,
  );

  await drag(page, [ruler.x + ruler.width - 3, y], [ruler.x + ruler.width * 0.75, y]);
  const afterOut = await read(page);
  check(
    'out marker follows the pointer',
    afterOut.outPoint < afterIn.outPoint - 1000,
    `out ${afterIn.outPoint} -> ${afterOut.outPoint}`,
  );
  check(
    'out marker does not hand the drag to the scrubber',
    afterOut.playhead === afterIn.playhead,
    `playhead ${afterIn.playhead} -> ${afterOut.playhead}`,
  );
}

/*
 * There is no `rulerCue` check any more, and its absence is deliberate.
 *
 * The ruler carried a diamond per keyframe, with press-to-seek,
 * drag-to-retime and double-press-to-remove hung off hit-testing them. They
 * were removed as redundant with the per-property keyframes on the lanes
 * below and confusing beside them, so the gestures went with them: the ruler
 * scrubs, and the lane checks below are where retiming is proved now.
 */
async function bareRuler(page: Page): Promise<void> {
  const ruler = await rect(page, '.ob-pb-ruler');
  const y = ruler.y + ruler.height / 2;
  const before = await read(page);
  const from = ruler.x + ruler.width * 0.55;
  await drag(page, [from, y], [from + 120, y]);
  const after = await read(page);

  check(
    'bare ruler still scrubs',
    after.playhead > before.playhead + 500,
    `playhead ${before.playhead} -> ${after.playhead}`,
  );
  check(
    'bare ruler moves no keyframe',
    after.keys.join() === before.keys.join(),
    `keys ${after.keys.join(' ')}`,
  );
}

/*
 * The track rows, in `Pc`'s order, as `:nth-child` of the track list.
 *
 * CAMERA MODE is row 1 and is a segment bar rather than a lane, so the first
 * `.ob-pb-lane` on the page belongs to CAMERA POS -- which is why
 * `laneKeyframe` above can use the bare selector and the value checks below
 * cannot. FOV is the first row that HAS a value.
 */
const FOV_ROW = 3;
const rowSel = (row: number, part: string): string => `.ob-pb-track:nth-child(${row}) ${part}`;

/** What the 64px value cell of a row is printing right now. */
async function valueText(page: Page, row: number): Promise<string> {
  return page.evaluate(
    (sel: string) => document.querySelector(sel)?.textContent ?? '',
    rowSel(row, '.ob-pb-track-value'),
  );
}

/**
 * The vertical half of a lane: drag it to set the row's value at the playhead.
 *
 * Read straight out of the DOM rather than through the fixture's `data-*`
 * mirror, because the cell's own text is what a user actually sees -- and
 * because a readout that is correct in the model and not on screen is exactly
 * the failure this whole file exists to catch.
 *
 * The discriminating assertion is not "the number changed". A build that
 * mistook this for a retime would change the number too, by dragging the
 * keyframe under the playhead somewhere else. It is **the number changed AND
 * no keyframe moved AND the playhead did not** -- one gesture, one effect.
 */
async function laneValueDrag(page: Page): Promise<void> {
  const lane = await rect(page, rowSel(FOV_ROW, '.ob-pb-lane'));
  const before = await read(page);
  const wasText = await valueText(page, FOV_ROW);

  // 60% across, which is bare lane: the only FOV key is the seeded one at
  // 0:00, hard against the left edge. Then 60px UP, which is more.
  const x = lane.x + lane.width * 0.6;
  const y = lane.y + lane.height / 2;
  await drag(page, [x, y], [x, y - 60]);
  const after = await read(page);
  const nowText = await valueText(page, FOV_ROW);

  check('a vertical drag sets the track value', nowText !== wasText, `FOV ${wasText} -> ${nowText}`);
  check(
    'a vertical drag retimes nothing',
    after.keys.join() === before.keys.join(),
    `keys ${before.keys.join(' ')} -> ${after.keys.join(' ')}`,
  );
  check(
    'a vertical drag does not scrub',
    after.playhead === before.playhead,
    `playhead ${before.playhead} -> ${after.playhead}`,
  );

  // ...and the whole gesture is ONE undo entry, so one Ctrl+Z puts it back.
  // Not several: the drag took ten moves and each one wrote a value.
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyZ');
  await page.keyboard.up('Control');
  const undone = await valueText(page, FOV_ROW);
  check('ctrl+z undoes the whole drag at once', undone === wasText, `FOV ${nowText} -> ${undone}`);
}

/**
 * Click the readout, type a value, commit it.
 *
 * On VIGNETTE rather than FOV, because it is the row nothing else in this
 * file touches -- and because it is the one with a UNIT conversion in it: the
 * cell prints a percent and the track holds 0..1, so typing 35 and reading
 * back `35%` proves the two halves of that agree. A field that showed
 * percent and wrote 35.0 into the track would print `3500%` here.
 *
 * Real keystrokes through CDP, like the drags: `el.value = ...` would not run
 * a single line of the commit path.
 */
const VIGNETTE_ROW = 4;

async function typedValue(page: Page): Promise<void> {
  const cell = rowSel(VIGNETTE_ROW, '.ob-pb-track-value');
  const type = async (text: string, key: 'Enter' | 'Escape'): Promise<void> => {
    const box = await rect(page, cell);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // Select-all first: the field opens with the current value in it, and a
    // cell showing `off` opens EMPTY, so appending would be right once and
    // wrong once.
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type(text);
    await page.keyboard.press(key);
  };

  const was = await valueText(page, VIGNETTE_ROW);
  await type('35', 'Enter');
  const committed = await valueText(page, VIGNETTE_ROW);
  check('typing a value commits it', committed === '35%', `vignette ${was} -> ${committed}`);

  await type('80', 'Escape');
  check(
    'escape cancels rather than committing',
    (await valueText(page, VIGNETTE_ROW)) === '35%',
    `vignette ${await valueText(page, VIGNETTE_ROW)}`,
  );

  // The one that matters most: a NaN written into a track propagates through
  // the interpolation and blanks a whole span of the shot.
  await type('banana', 'Enter');
  check(
    'unparseable input reverts instead of writing NaN',
    (await valueText(page, VIGNETTE_ROW)) === '35%',
    `vignette ${await valueText(page, VIGNETTE_ROW)}`,
  );

  await page.keyboard.down('Control');
  await page.keyboard.press('KeyZ');
  await page.keyboard.up('Control');
  const undone = await valueText(page, VIGNETTE_ROW);
  check('ctrl+z undoes a typed value', undone === was, `vignette 35% -> ${undone}`);
}

/**
 * A press ON a diamond is a retime, even on a lane that is also a fader.
 *
 * The two gestures share one lane and the discriminator is what is under the
 * pointer at the press, not which way the hand later travels -- so this is
 * the check that the horizontal half still wins where it should. A build that
 * armed the fader here would leave the keyframes where they are and change
 * the number, which is exactly the opposite of both assertions.
 */
async function diamondBeatsFader(page: Page): Promise<void> {
  const lane = await rect(page, rowSel(FOV_ROW, '.ob-pb-lane'));
  const y = lane.y + lane.height / 2;
  const before = await read(page);
  const wasText = await valueText(page, FOV_ROW);

  // FOV's only key is at 0:00, so its diamond straddles the left edge -- aim
  // just inside, the way `inOutMarkers` does with the in grip.
  await drag(page, [lane.x + 2, y], [lane.x + 200, y]);
  const after = await read(page);
  const nowText = await valueText(page, FOV_ROW);

  check(
    'a press on a diamond retimes rather than setting a value',
    after.keys.length > before.keys.length,
    `keys ${before.keys.join(' ')} -> ${after.keys.join(' ')}`,
  );
  check(
    'retiming leaves the value alone',
    nowText === wasText,
    `FOV ${wasText} -> ${nowText}`,
  );
}

async function laneKeyframe(page: Page): Promise<void> {
  const lane = await rect(page, '.ob-pb-lane');
  const y = lane.y + lane.height / 2;
  const before = await read(page);
  const key = before.keys.find((t) => t > 0);
  if (key === undefined) {
    check('a lane keyframe to drag', false, 'none past zero');
    return;
  }
  const at = lane.x + (key / DURATION) * lane.width;
  await drag(page, [at, y], [at - 140, y]);
  const after = await read(page);

  check(
    'lane diamond retimes',
    after.keys.some((t) => t < key - 500 && t > 0),
    `keys ${before.keys.join(' ')} -> ${after.keys.join(' ')}`,
  );
  // The whole CAMERA POS pose moves as one. Six tracks keyed at six different
  // times would show up here as extra entries in the ruler's key list.
  check(
    'the whole pose moves together',
    after.keys.length === before.keys.length,
    `${before.keys.length} -> ${after.keys.length}`,
  );
}

// `strictPort: false` steps past `vite.config.ts`'s 5173 when a dev server
// already holds it, rather than failing to boot. Same as `results-preview.ts`.
const server = await createServer({ server: { strictPort: false }, logLevel: 'warn' });
await server.listen();
const base = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? '';
if (!base) {
  await server.close();
  throw new Error('vite did not report a local URL');
}
const pageUrl = `${base}/tools/browser/preview/timeline.html`;

if (flag('open')) {
  console.log('serving the timeline fixture. ctrl-c to stop.\n');
  console.log(`  ${pageUrl}`);
} else {
  const browser = await puppeteer.launch({ headless: true, args: [...WEBGPU_ARGS] });
  const problems: string[] = [];
  try {
    const page = await browser.newPage();
    page.on('console', (m: ConsoleMessage) => {
      if (m.type() === 'error') {
        problems.push(`[error] ${m.text()}`);
      }
    });
    page.on('pageerror', (e: unknown) => {
      problems.push(`[pageerror] ${e instanceof Error ? e.message : String(e)}`);
    });

    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(pageUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 });

    // The value checks go BEFORE the scrub, deliberately: they assert that a
    // vertical drag creates no keyframe, and that is only a clean statement
    // while the playhead is still at 0:00 where FOV's seeded key already is.
    // Scrub first and the drag legitimately adds a key at the new playhead,
    // so the check would have to be weakened to something that passes on a
    // build that retimed instead.
    await inOutMarkers(page);
    await laneValueDrag(page);
    await typedValue(page);
    await bareRuler(page);
    await laneKeyframe(page);
    await diamondBeatsFader(page);

    await page.close();
  } finally {
    await browser.close();
  }
  await server.close();

  for (const line of problems) {
    console.log(`  ${line}`);
  }
  if (failures.length || problems.length) {
    console.error(`\n${failures.length} failed, ${problems.length} console problem(s)`);
    process.exit(1);
  }
  console.log('\nevery handle drags.');
}
