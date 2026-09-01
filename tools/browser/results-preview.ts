/**
 * Render the results screen against fixture data, without playing a run.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run preview-results                       # every state into shots/
 *   npm run preview-results -- --state pb         # just one
 *   npm run preview-results -- --tab career       # the Career tab
 *   npm run preview-results -- --open             # serve it and stop, to look
 *   npm run preview-results -- --scale 4 --state pb   # a close-up
 *
 * WHY THIS EXISTS: the results screen is only reachable by finishing a timed
 * run, which needs a map, pointer lock, and a course crossed end to end. That
 * is not something the automation here can drive -- an automated tab is
 * `document.hidden`, so `requestAnimationFrame` never ticks and no trigger
 * ever fires. So every change to that screen used to be checked by writing a
 * throwaway page, and the sparse states (a map's first completion, a course
 * with no checkpoints) were the ones nobody checked twice.
 *
 * The states live in `preview/results-fixture.ts`, typed as `ResultsData` so
 * the compiler catches a drifted shape. Add one there, not here.
 *
 * Starts its own vite server and shuts it down after, so it needs no
 * `npm run dev` running alongside it -- and does not fight one that is:
 * `strictPort: false` steps past `vite.config.ts`'s 5173 to the next free
 * port, which is verified behaviour rather than an assumption (run this with
 * a dev server up and it lands on 5174).
 *
 * Exits non-zero if the page reported errors, matching `shot.ts` -- a screen
 * that renders but throws is a screen that is broken in a way a picture will
 * not show you.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';
import type { ConsoleMessage } from 'puppeteer';
import { createServer } from 'vite';
import { WEBGPU_ARGS } from './session.js';
import { RESULTS_STATES } from './preview/state-names.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const only = arg('state');
const tab = arg('tab');
const outDir = resolve(arg('out', 'shots'));
const width = Number(arg('width', '1280'));
const height = Number(arg('height', '720'));
const scale = Number(arg('scale', '2'));

const names: readonly string[] = only ? [only] : RESULTS_STATES;
for (const name of names) {
  if (!(RESULTS_STATES as readonly string[]).includes(name)) {
    console.error(`unknown state: ${name}`);
    console.error(`have: ${RESULTS_STATES.join(', ')}`);
    process.exit(2);
  }
}

// `strictPort: false` is the part that matters: the config file pins 5173 and
// wins the merge, so this steps up to the next free port when a dev server
// already holds it rather than failing to boot.
const server = await createServer({
  server: { strictPort: false },
  // The tool prints the one URL that matters; vite's own banner is noise.
  logLevel: 'warn',
});
await server.listen();
const base = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? '';
if (!base) {
  await server.close();
  throw new Error('vite did not report a local URL');
}

const pageUrl = (state: string): string => {
  const p = new URLSearchParams({ state });
  if (tab) {
    p.set('tab', tab);
  }
  return `${base}/tools/browser/preview/results.html?${p.toString()}`;
};

if (flag('open')) {
  // Serve and stay up, so the screen can be poked at by hand -- resizing it
  // is the only way to see the column layout collapse, which no screenshot
  // at a fixed width will ever show.
  console.log('serving the results preview. ctrl-c to stop.\n');
  for (const name of RESULTS_STATES) {
    console.log(`  ${name.padEnd(10)} ${pageUrl(name)}`);
  }
  console.log(`\n  (append &tab=career for Rc)`);
} else {
  mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, args: [...WEBGPU_ARGS] });
  let problems = 0;
  try {
    for (const name of names) {
      const page = await browser.newPage();
      const found: string[] = [];
      page.on('console', (m: ConsoleMessage) => {
        if (m.type() === 'error' || m.type() === 'warn') {
          found.push(`[${m.type()}] ${m.text()}`);
        }
      });
      // puppeteer types this handler's argument as `unknown`, so narrow it
      // rather than asserting: a page can reject with something that is not
      // an Error, and `.message` on that would read undefined.
      page.on('pageerror', (e: unknown) => {
        found.push(`[pageerror] ${e instanceof Error ? e.message : String(e)}`);
      });
      page.on('requestfailed', (r) => found.push(`[failed] ${r.url()}`));

      await page.setViewport({ width, height, deviceScaleFactor: scale });
      await page.goto(pageUrl(name), { waitUntil: 'networkidle0' });
      await page.waitForSelector('.ob-results', { timeout: 15000 });
      // Webfonts decide the metrics of every label on the screen; capturing
      // before they land measures the fallback stack instead.
      await page.evaluate(() => document.fonts.ready);
      await new Promise((r) => setTimeout(r, 300));

      const suffix = tab ? `-${tab}` : '';
      const file = resolve(outDir, `results-${name}${suffix}.png`);
      await page.screenshot({ path: file as `${string}.png` });
      console.log(`${name.padEnd(10)} ${file}`);
      for (const line of found) {
        console.log(`  ${line}`);
      }
      problems += found.length;
      await page.close();
    }
  } finally {
    await browser.close();
  }
  await server.close();
  if (problems) {
    console.error(`\n${problems} console problem(s)`);
    process.exit(1);
  }
}
