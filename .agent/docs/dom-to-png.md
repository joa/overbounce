# Turning a screen into a PNG, in the browser, with no library

Written 2026-09-01, while building the results screen's Screenshot button
(`src/ui/screens/results-export.ts`). Read this before touching that file, and
before writing anything else that serializes CSS.

## The route

There is no API that hands a page a picture of itself. `getDisplayMedia` asks
the player to pick a window and captures the browser chrome with it, which is
not what a button should do. The route that works is old and well known:

1. clone the element, drop what should not appear in the picture,
2. serialize it into `<svg><foreignObject>`,
3. point an `<img>` at that SVG as a `data:` URL,
4. `drawImage` it onto a canvas, `toBlob('image/png')`.

Two hard rules come with it, and this project happens to satisfy both:

- **An `<img>` rendering an SVG may not fetch anything.** No `blob:` image, no
  `/fonts/*.ttf`, no stylesheet link — they come out blank with no error.
  Levelshots here are already `data:` URLs (`decodeLevelshot` re-encodes to
  JPEG) and the fonts are same-origin files that get inlined as base64.
- **The clone matches no stylesheet**, so every rule has to travel inside the
  SVG as text.

## The trap: `CSSRule.cssText` cannot round-trip a shorthand with `var()`

The obvious way to collect the CSS is to walk `document.styleSheets` and
concatenate `rule.cssText`. **It silently destroys most of this project's
type.** Every rule here is written in the shorthand form

```css
font: 600 30px/1 var(--ob-font-display);
```

and Chrome gives that back from `cssText` as

```css
font-style: ; font-variant-ligatures: ; font-variant-caps: ; ...
```

— the longhands, with **empty values**. The size and the family are simply
gone. A shorthand containing a `var()` is stored as a "pending substitution
value" that the serializer has nothing to print for.

What this looks like in the output is the real danger: the layout is perfect,
every box is where it belongs, and only the type is wrong — headline numerals
rendering at the browser's default size instead of 30px and 76px. It reads as
"looks about right" in a thumbnail. It was caught by comparing the captured
PNG against a live screenshot of the same screen side by side, not by reading
the code.

**Collect the authored text instead**: `<style>` elements' `textContent`, plus
a `fetch` of each same-origin `<link rel=stylesheet>` href (a built bundle
serves tokens.css as a link; the dev server inlines it, so both paths have to
work). No parser round-trip, no lost shorthands.

## Smaller things worth keeping

- **The clipboard write must be issued inside the click.** Rendering the
  picture takes long enough (fonts, a full-page rasterise) that awaiting it
  first loses the user gesture and the write is rejected. `ClipboardItem`
  accepts a **promise** for the blob — hand it the unawaited render and the
  write is issued immediately.
- **`@font-face` from the document must be stripped** before the inlined
  faces are added, or the originals (pointing at `/fonts/...`) can win.
- **The SVG is parsed as XML**, so `&` and `<` inside the `<style>` text have
  to be escaped. That is not a mangling: the XML parser hands the CSS parser
  the original characters back.
- **A native file dialog blocks an automated tab completely.** When testing
  this from Chrome automation, stub `window.showSaveFilePicker` first — one
  that resolves with a fake handle capturing the blob is also the easiest way
  to assert on what would have been written.
