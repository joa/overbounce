/**
 * Q3's `^N` in-string colour codes, for text that comes out of a `.bsp` or a
 * map's own `.arena`/`.defi` metadata -- `target_print`'s centerprint
 * message, and a course's author-supplied long name.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `^0`-`^7` are `g_color_table` (`refs/quake3/game/q_math.c`) exactly --
 * black/red/green/yellow/blue/cyan/magenta/white, verified straight from
 * that array, not from memory or a community chart. `^8`/`^9` (orange,
 * medium grey) are a DeFRaG/OSP UI extension with no entry in id's own
 * `g_color_table` -- `refs/quake3` does not carry the client/cgame text-draw
 * code that would show how (or whether) a real DeFRaG build renders them, so
 * these two are community-documented only, the same standing this project
 * already gives CPM and `target_init`'s spawnflags. `#ff8000` and `#808080`
 * are the two values every such chart agrees on; `#808080` also happens to
 * be `q_math.c`'s own unused `colorMdGrey`, which is at least suggestive.
 *
 * Vanilla `q_shared.h` computes the index as `((c) - '0') & 7` -- literally
 * ANY character after `^`, not just a digit, produces some colour by that
 * arithmetic, and `^8`/`^9` in a vanilla client wrap to black/red rather than
 * a ninth and tenth colour. That calling convention lives in `cg_draw.c`/
 * `cl_console.c`, neither of which `refs/quake3` includes, so it is not
 * verified here either. This parser deliberately only recognises `^0`-`^9`
 * digits -- the set actually documented for map authors -- rather than
 * extending to arbitrary characters on unverified authority.
 *
 * `^^` is not a colour code: `Q_IsColorString` (`q_shared.h`) requires the
 * character after `^` to exist AND not be another `^`. The first `^` of a
 * pair fails that test and is emitted as a literal caret; the SECOND `^` is
 * then re-examined on its own, against whatever follows IT. `^^7` therefore
 * prints one literal caret and then switches to white (the second `^` forms
 * a real code with the `7`), while `^^x` prints two literal carets (the
 * second `^` also fails, since `x` is not a digit) -- "doubling a caret
 * escapes it" is only true when a colour code follows the pair.
 */

/** Index 0-9. 0-7 verified against `g_color_table`; 8-9 are the OSP/DeFRaG
 *  extension -- see file header. */
export const Q3_COLORS: readonly string[] = [
  '#000000', // 0 black
  '#ff0000', // 1 red
  '#00ff00', // 2 green
  '#ffff00', // 3 yellow
  '#0000ff', // 4 blue
  '#00ffff', // 5 cyan
  '#ff00ff', // 6 magenta ("purple" in most community charts)
  '#ffffff', // 7 white
  '#ff8000', // 8 orange (OSP/DeFRaG, unverified)
  '#808080', // 9 medium grey (OSP/DeFRaG, unverified)
];

/** `^7` (white) is what a string with no leading colour code renders as --
 *  `CG_DrawStringExt`'s own default, and the shade every one of this
 *  project's own HUD text already assumes as its base colour. */
const DEFAULT_COLOR_INDEX = 7;

export interface Q3ColorSegment {
  text: string;
  /** A `Q3_COLORS` entry. Never empty even for a segment with no explicit code. */
  color: string;
}

/**
 * Splits `raw` into runs of one colour each. Empty segments are never
 * produced -- a leading colour code with no text before the next one, or a
 * trailing code with nothing after it, contributes nothing to the output.
 */
export function splitQ3Colors(raw: string): Q3ColorSegment[] {
  const segments: Q3ColorSegment[] = [];
  let color = Q3_COLORS[DEFAULT_COLOR_INDEX];
  let buffer = '';

  const flush = (): void => {
    if (buffer) {
      segments.push({ text: buffer, color });
      buffer = '';
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1];
    if (c === '^' && next !== undefined && next !== '^' && next >= '0' && next <= '9') {
      flush();
      color = Q3_COLORS[Number(next)];
      i++; // consume the digit too
      continue;
    }
    buffer += c;
  }
  flush();
  return segments;
}

/**
 * Renders `raw` into `target` as colour-coded `<span>` children -- never
 * `innerHTML`. `raw` is untrusted map/course-author data (a BSP's own
 * `target_print` message, or a `.arena`/`.defi` long name), the same
 * standing `hud.ts`'s own `centerPrint` and `course-select.ts`'s name
 * rendering already give it; building DOM nodes per segment and setting
 * `textContent` on each is what keeps that guarantee while still honouring
 * `^N`.
 */
export function renderQ3Text(target: HTMLElement, raw: string): void {
  target.textContent = '';
  for (const segment of splitQ3Colors(raw)) {
    if (segment.color === Q3_COLORS[DEFAULT_COLOR_INDEX]) {
      // The common case (no colour codes at all, or explicit ^7) needs no
      // wrapper -- a bare text node inherits the element's own colour.
      target.appendChild(document.createTextNode(segment.text));
      continue;
    }
    const span = document.createElement('span');
    span.style.color = segment.color;
    span.textContent = segment.text;
    target.appendChild(span);
  }
}
