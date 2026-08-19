/**
 * An isolated browser for looking at the game.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Every call launches its OWN Chrome and closes it again. That is the entire
 * point, and it is worth stating plainly because the alternative was tried
 * first and failed: driving one shared Chrome from several agents at once meant
 * pages were navigated and closed out from under each other, GPU timing runs
 * were invalidated mid-measurement, and a prototype was destroyed. Ownership
 * conventions did not save it, because the tool acts on whatever page is
 * *selected* and that selection drifts whenever anyone opens or closes a tab.
 *
 * A process boundary fixes what a naming convention could not.
 *
 * WEBGPU FLAGS, determined empirically as CLAUDE.md requires
 *
 * `--enable-unsafe-webgpu` alone is NOT enough on this setup: `navigator.gpu`
 * is absent entirely, headless and headful alike. The one that matters is
 * `--enable-features=WebGPU`. With both, headless Chrome reports a real
 * hardware adapter -- vendor `nvidia` on the machine this was written on, not
 * SwiftShader -- so headless numbers are about the real GPU.
 *
 * Do not trust this list on a different machine without re-running
 * `tools/browser/probe-flags.ts`. That is why the probe is kept.
 */

import puppeteer from 'puppeteer';
import type { Browser, ConsoleMessage, Page } from 'puppeteer';

/** The flags that actually produce a WebGPU adapter. See the file header. */
export const WEBGPU_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-unsafe-webgpu',
  '--enable-features=WebGPU,Vulkan',
];

export interface SessionOptions {
  /** Show the window. Headless gets a real adapter, so this is for debugging. */
  headful?: boolean;
  width?: number;
  height?: number;
  /**
   * How long to wait for the game to report itself running, in ms.
   *
   * Loading a map means fetching a multi-megabyte pak over HTTP, parsing a BSP
   * and compiling shaders, so this is seconds rather than milliseconds.
   */
  readyTimeoutMs?: number;
}

export interface PageSession {
  page: Page;
  /** Everything the page logged, in order. */
  console: string[];
  /** Just the errors and warnings, which is what usually matters. */
  problems: string[];
}

/**
 * Open `url` in a fresh browser, hand it to `fn`, then close everything.
 *
 * Console output is captured from before the first navigation, so startup
 * errors are not missed -- which matters here, because a WGSL compile failure
 * happens during the first frame and leaves no trace in the picture beyond a
 * surface that quietly does not draw.
 */
export async function withPage<T>(
  url: string,
  fn: (session: PageSession) => Promise<T>,
  options: SessionOptions = {},
): Promise<T> {
  const browser: Browser = await puppeteer.launch({
    headless: !options.headful,
    args: WEBGPU_ARGS,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: options.width ?? 1280,
      height: options.height ?? 720,
      deviceScaleFactor: 1,
    });

    const log: string[] = [];
    const problems: string[] = [];
    page.on('console', (m: ConsoleMessage) => {
      const line = `[${m.type()}] ${m.text()}`;
      log.push(line);
      // puppeteer's type is 'warn', not 'warning' -- getting this wrong meant
      // warnings were captured but never surfaced as problems.
      if (m.type() === 'error' || m.type() === 'warn') {
        problems.push(line);
      }
    });
    /*
     * Failed requests, with the URL.
     *
     * `page.on('console')` gets Chrome's own "Failed to load resource: 404"
     * line, and that line does NOT say which resource -- so every shot this
     * project has ever taken reported one anonymous 404 and exited non-zero
     * through the tool's own error gate, which made the gate worthless. The
     * request object knows the URL; the console message does not.
     */
    page.on('requestfailed', (req) => {
      const line = `[requestfailed] ${req.url()} — ${req.failure()?.errorText ?? 'unknown'}`;
      log.push(line);
      problems.push(line);
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        const line = `[http ${res.status()}] ${res.url()}`;
        log.push(line);
        problems.push(line);
      }
    });
    page.on('pageerror', (e: unknown) => {
      const line = `[pageerror] ${e instanceof Error ? e.message : String(e)}`;
      log.push(line);
      problems.push(line);
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // `main.ts` sets this once the first frame has been rendered, which is a
    // real readiness signal rather than a guessed sleep.
    await page
      .waitForSelector('body[data-status="running"]', {
        timeout: options.readyTimeoutMs ?? 60_000,
      })
      .catch(() => {
        throw new Error(
          `page never reported running within the timeout.\n` +
            problems.slice(0, 10).join('\n'),
        );
      });

    return await fn({ page, console: log, problems });
  } finally {
    await browser.close();
  }
}

/** Hide the click-to-play overlay, which otherwise covers the middle of every shot. */
export async function hideHud(page: Page): Promise<void> {
  await page.evaluate(() => {
    const hint = document.querySelector('.ob-hint');
    if (hint instanceof HTMLElement) {
      hint.style.display = 'none';
    }
  });
}

/** The HUD's text, handy for asserting position and state in a shot. */
export async function readHud(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('.ob-stats');
    return el instanceof HTMLElement ? el.innerText : '';
  });
}
