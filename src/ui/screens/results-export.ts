/**
 * Taking something away from the results screen: the picture, and the ghost.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Both of these exist because a run that only ever lived on one screen is a
 * run nobody else can see. A time posted in a channel wants the picture; a
 * ghost somebody else can race wants the file.
 *
 * ## Why the screenshot is drawn rather than captured
 *
 * There is no API that hands a page a picture of itself. `getDisplayMedia`
 * asks the player to pick a window and share their screen, for a button that
 * should just work, and it captures the browser chrome along with it. So this
 * takes the other route: clone the screen into an `<svg><foreignObject>`,
 * point an `<img>` at that SVG, and draw the image to a canvas. The browser
 * does the layout and the text rendering; nothing here re-implements either.
 *
 * That route has exactly two hard rules, and this project happens to satisfy
 * both, which is what makes it viable at all:
 *
 *   1. **Nothing may reference an external URL.** An `<img>` rendering an SVG
 *      is not allowed to fetch, so a `blob:` levelshot or a `/fonts/*.ttf`
 *      would silently come out blank. Every levelshot here is already a
 *      `data:` URL (`decodeLevelshot` re-encodes to JPEG), the speed trace is
 *      inline SVG, and the fonts are same-origin files this module inlines
 *      as base64 below.
 *   2. **The CSS has to travel with the markup.** The clone is detached, so
 *      it matches no stylesheet; every sheet in the document is collected as
 *      text and carried inside the SVG. Read `collectCss`'s own comment
 *      before changing where that text comes from -- the obvious source is
 *      the wrong one.
 *
 * The footer is dropped from the clone -- a picture of a screen with a "Run
 * again" button in it is a picture of a UI, not of a run -- and a build stamp
 * is added in its place, because the picture will outlive the session.
 */

import type { GhostRun } from '../../game/ghost.js';
import { LocalSettingsStore } from '../local-settings.js';

/* -------------------------------------------------------------------------
 * Saving a file
 * ---------------------------------------------------------------------- */

/**
 * `showSaveFilePicker` is Chromium-only and not in this project's DOM lib, so
 * it is reached through a narrowed `window` rather than declared globally --
 * `any` is banned here and there is no reason to widen the global type for
 * one call site.
 */
interface WritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}
interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
}
type SaveFilePicker = (options: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileHandleLike>;

/**
 * Put a blob on disk, and say whether it actually landed there.
 *
 * The real dialog when the browser has one -- the player picks the folder and
 * the name, and a cancel is a cancel rather than a file appearing in
 * Downloads anyway. The anchor fallback cannot report a cancel (there is
 * nothing to report: the download starts the moment it is clicked), so it
 * answers true.
 */
async function saveBlob(
  blob: Blob,
  suggestedName: string,
  description: string,
  mime: string,
  extension: string,
): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [{ description, accept: { [mime]: [extension] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch {
      // The player cancelled the dialog, or the page lost the gesture that
      // allowed it. Neither is an error worth showing.
      return false;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  // Not revoked synchronously: the click starts the download asynchronously
  // and revoking under it cancels the download in some builds.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/** Filesystem-safe, and recognisably the map it came from. */
function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'overbounce';
}

/* -------------------------------------------------------------------------
 * The ghost file
 * ---------------------------------------------------------------------- */

/** `btoa` takes a binary string, not bytes, and blows the argument limit on a
 *  long run if the whole array is spread at once. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Write a ghost out as a file, and say whether it was saved.
 *
 * The file is the `GhostRun` JSON, base64 of its UTF-8 bytes, and nothing
 * else -- no header, no wrapper. A reader is therefore
 * `parseGhost(JSON.parse(atob(text)))`, which is the same `parseGhost` the
 * store already validates with, and a file that survives being pasted into a
 * chat window intact. The version field inside the JSON is what identifies
 * the format; this file does not add a second one to disagree with it.
 */
export async function saveGhostFile(ghost: GhostRun): Promise<boolean> {
  const text = toBase64(new TextEncoder().encode(JSON.stringify(ghost)));
  const name = `${safeName(ghost.map)}-${ghost.physics}-${Math.round(ghost.time)}ms.obghost`;
  return saveBlob(
    new Blob([text], { type: 'text/plain' }),
    name,
    'Overbounce ghost',
    'text/plain',
    '.obghost',
  );
}

/* -------------------------------------------------------------------------
 * The picture
 * ---------------------------------------------------------------------- */

/** The faces the screen actually draws in. Fetched once and kept, because a
 *  player who takes one screenshot usually takes several. */
const FONT_FACES: readonly { family: string; weight: number; file: string }[] = [
  { family: 'Barlow Condensed', weight: 400, file: 'BarlowCondensed-Regular.ttf' },
  { family: 'Barlow Condensed', weight: 500, file: 'BarlowCondensed-Medium.ttf' },
  { family: 'Barlow Condensed', weight: 600, file: 'BarlowCondensed-SemiBold.ttf' },
  { family: 'Barlow Condensed', weight: 700, file: 'BarlowCondensed-Bold.ttf' },
  { family: 'JetBrains Mono', weight: 400, file: 'JetBrainsMono-Variable.ttf' },
];

let embeddedFonts: Promise<string> | null = null;

/**
 * `@font-face` rules with the font bytes in them.
 *
 * A face that fails to fetch is simply left out: the picture then falls back
 * to a system font for that weight, which is worse than the real thing and
 * much better than nothing coming back at all.
 */
function fontCss(): Promise<string> {
  embeddedFonts ??= (async () => {
    const base = import.meta.env.BASE_URL;
    const parts = await Promise.all(
      FONT_FACES.map(async (face) => {
        try {
          const res = await fetch(`${base}fonts/${face.file}`);
          if (!res.ok) {
            return '';
          }
          const b64 = toBase64(new Uint8Array(await res.arrayBuffer()));
          return (
            `@font-face{font-family:'${face.family}';font-weight:${face.weight};` +
            `font-style:normal;src:url(data:font/ttf;base64,${b64}) format('truetype');}`
          );
        } catch {
          return '';
        }
      }),
    );
    return parts.join('');
  })();
  return embeddedFonts;
}

/**
 * Drop every `@rule` of one kind, block and all.
 *
 * Brace-matched rather than a regex, because `@media` nests: the rules inside
 * it have braces of their own and a `[^}]*` would stop at the first one. Two
 * kinds get dropped on the way into the picture:
 *
 *   - `@font-face`, because the originals point at `/fonts/*.ttf` and an
 *     `<img>` rendering an SVG is not allowed to go and fetch that.
 *     `fontCss`'s inlined faces replace them.
 *   - `@media`, because the picture is a fixed `SHOT_WIDTH` wide and the
 *     layout in it should not change with the window. The screen's own
 *     breakpoints stack the results columns below 1080, which would make
 *     every screenshot the narrow layout; worse, the measuring pass runs in
 *     the live document (where the real window decides which breakpoints
 *     match) and the render runs in a 1024-wide SVG, so leaving them in means
 *     measuring one layout and drawing another, and the picture comes out
 *     clipped.
 */
function dropAtRule(css: string, atRule: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const at = css.indexOf(atRule, i);
    if (at < 0) {
      return out + css.slice(i);
    }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    if (open < 0) {
      return out;
    }
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      const c = css[j];
      if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
      }
      j++;
    }
    i = j;
  }
}

/**
 * Every stylesheet in the document, as the text it was WRITTEN in.
 *
 * Read off the `<style>` elements and out of the `<link>` hrefs rather than
 * out of `document.styleSheets`, which looks like the obvious source and is a
 * trap: Chrome cannot round-trip a shorthand that contains a `var()`. Every
 * rule in this project is written as
 *
 *     font: 600 30px/1 var(--ob-font-display);
 *
 * and `CSSRule.cssText` gives that back as `font-style: ; font-variant-...: ;`
 * -- the longhands with EMPTY values, the size and the family simply gone. A
 * picture built from that has the right layout in the wrong type, at the
 * browser's default size, which is a subtle enough wrong that it survives a
 * glance. The authored text has no such problem.
 */
async function collectCss(): Promise<string> {
  const parts: string[] = [];
  for (const node of Array.from(
    document.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style, link[rel="stylesheet"]'),
  )) {
    if (node instanceof HTMLStyleElement) {
      parts.push(node.textContent ?? '');
      continue;
    }
    // A built bundle serves tokens.css as a real stylesheet link; the dev
    // server inlines it instead. Both have to work, and a sheet that will not
    // fetch (cross-origin) is skipped rather than fatal -- the picture loses
    // that sheet's rules, not the whole render.
    try {
      const res = await fetch(node.href);
      if (res.ok) {
        parts.push(await res.text());
      }
    } catch {
      // Skipped, as above.
    }
  }
  return dropAtRule(dropAtRule(parts.join('\n'), '@font-face'), '@media');
}

/**
 * The picture's width, whatever the window happens to be.
 *
 * A shot of a maximised 4K window is a 4000px image of a screen with half of
 * it empty, and a shot of a small window is a different picture of the same
 * run. One canonical width makes every screenshot of every run comparable and
 * pasteable, and 1024 is wide enough to keep the two-column layout the design
 * draws -- the breakpoint that would stack it goes out with the rest of the
 * `@media` rules, see `dropAtRule`.
 */
const SHOT_WIDTH = 1024;

/** The player's own name, as Settings' Player panel stores it. Empty when
 *  they have not set one, or when storage is unreadable -- a screenshot must
 *  not fail over a nameplate. */
function playerName(): string {
  try {
    const merged = new LocalSettingsStore().withDefaults(
      new URLSearchParams(window.location.search),
    );
    return (merged.get('playername') ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Draw `root` to a PNG, without its footer.
 *
 * Height comes from the content, not from the window. The clone is taken out
 * of `position:fixed` (inside a `<foreignObject>` there is no viewport for
 * `inset:0` to resolve against anyway), given `height:auto`, and measured
 * off-screen. `.ob-res-body`'s own 28px padding is then the whole of the gap
 * above the first row and below the last, so the picture is padded evenly at
 * top and bottom instead of trailing however much empty screen the window had
 * under the content.
 */
async function renderPng(root: HTMLElement): Promise<Blob> {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelector('.ob-res-foot')?.remove();
  // The pulse on "Run again" is in the footer that just went, but any
  // animation left mid-cycle would be captured at whatever frame it was on.
  for (const el of Array.from(clone.querySelectorAll<HTMLElement>('*'))) {
    el.style.animation = 'none';
    el.style.transition = 'none';
  }

  // Who took this and which build drew it. A screenshot outlives the session
  // it came from and gets pasted somewhere with no context; without this, a
  // picture taken before a physics or scoring change is indistinguishable
  // from one taken after it, and a time in a channel has no name on it.
  // Added to the CLONE only -- both are properties of the picture, not of the
  // screen, and nothing on screen needs to carry a version number.
  //
  // The name is read the way every other screen reads a setting: storage,
  // with a URL param allowed to override it for one load. Unset is the
  // ordinary case and simply leaves the stamp as the build alone.
  const stamp = document.createElement('div');
  stamp.textContent = [playerName(), `Overbounce · v${__APP_VERSION__}`]
    .filter((part) => part !== '')
    .join(' · ');
  stamp.style.cssText =
    'margin-top:22px;text-align:right;font:400 10px/1 var(--ob-font-mono);' +
    'letter-spacing:.14em;color:var(--ob-unavailable)';
  clone.querySelector('.ob-res-body')?.appendChild(stamp);

  // On screen the body is the scroller (`overflow:auto`, `flex:1`) and the
  // root clips it. In the picture there is nothing to scroll -- the height IS
  // the content -- and leaving it scrollable draws a scrollbar track down the
  // right edge of every screenshot, because a scroll container at exactly its
  // content height still counts as one. Opened up before measuring, so the
  // height that comes back is the full content either way.
  const body = clone.querySelector<HTMLElement>('.ob-res-body');
  if (body) {
    body.style.overflow = 'visible';
  }
  clone.style.overflow = 'visible';

  // Measured in the live document, because a detached node has no layout.
  // Parked off to the side rather than hidden: `visibility:hidden` lays out
  // just as well but has to be undone before serializing, and one forgotten
  // reset there is an entirely blank picture.
  clone.style.inset = 'auto';
  clone.style.position = 'absolute';
  clone.style.left = '-20000px';
  clone.style.top = '0';
  clone.style.width = `${SHOT_WIDTH}px`;
  clone.style.height = 'auto';
  document.body.appendChild(clone);
  const width = SHOT_WIDTH;
  const height = Math.max(1, Math.ceil(clone.getBoundingClientRect().height));
  clone.remove();

  clone.style.position = 'static';
  clone.style.left = 'auto';
  clone.style.height = `${height}px`;

  const [fonts, sheets] = await Promise.all([fontCss(), collectCss()]);
  const markup = new XMLSerializer().serializeToString(clone);
  // The SVG is parsed as XML, where `&` and `<` are markup. Escaping them here
  // is not a mangling of the CSS: the XML parser hands the CSS parser the
  // original characters back.
  const css = `${fonts}${sheets}`.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<style>${css}</style>` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml">${markup}</div>` +
    `</foreignObject></svg>`;

  const img = new Image();
  img.width = width;
  img.height = height;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('the screen did not render as an image'));
    // `encodeURIComponent`, not a blob URL: a blob URL is a fetch as far as
    // the SVG is concerned, and an SVG loaded into an <img> cannot make one.
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });

  // At device resolution, so the text in the picture is as sharp as the text
  // on the screen it was taken from.
  const scale = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('no 2d context');
  }
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('the picture would not encode'));
      }
    }, 'image/png');
  });
}

export type ExportImageOutcome = 'copied' | 'saved' | 'failed';

/**
 * The screenshot button: to the clipboard, or to a file when `save`.
 *
 * The clipboard path hands `ClipboardItem` the *promise* and never awaits the
 * render first. Chrome only allows a clipboard write while the click that
 * asked for it is still being handled, and rendering the picture takes long
 * enough (fonts, a full-page rasterise) to lose that window -- passing the
 * promise is what lets the write be issued immediately and resolve later.
 * The save path has no such rule and reads in the obvious order.
 */
export async function exportResultsImage(
  root: HTMLElement,
  options: { save: boolean; name?: string },
): Promise<ExportImageOutcome> {
  const suggested = `${safeName(options.name ?? 'overbounce')}-results.png`;

  if (options.save) {
    try {
      const blob = await renderPng(root);
      return (await saveBlob(blob, suggested, 'PNG image', 'image/png', '.png')) ? 'saved' : 'failed';
    } catch (err) {
      console.warn('[overbounce] screenshot failed:', err);
      return 'failed';
    }
  }

  const png = renderPng(root);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return 'copied';
  } catch (err) {
    // No clipboard permission, no clipboard image support, or the render
    // itself threw. Falling back to a file is more useful than a dead
    // button, and it is what the player was going to do with it anyway.
    console.warn('[overbounce] clipboard write failed, offering a file instead:', err);
    try {
      return (await saveBlob(await png, suggested, 'PNG image', 'image/png', '.png'))
        ? 'saved'
        : 'failed';
    } catch {
      return 'failed';
    }
  }
}
