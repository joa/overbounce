/**
 * Quake III .skin files.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A .skin maps each surface of a model to the shader it should be drawn with,
 * which is how one set of MD3s becomes sarge/default, sarge/krusade and so on.
 * The shader names baked into the MD3 itself are only a fallback.
 *
 * The format is one `surface,shader` pair per line. Lines naming a tag rather
 * than a surface, and lines with an empty shader, mean "draw nothing".
 */

export interface Skin {
  /** Surface name -> shader/texture path. */
  surfaces: Map<string, string>;
}

export function parseSkin(text: string): Skin {
  const surfaces = new Map<string, string>();

  for (const rawLine of text.split(/\r?\n/)) {
    // Strip comments and whitespace.
    const line = rawLine.split('//')[0].trim();
    if (!line) {
      continue;
    }

    const comma = line.indexOf(',');
    if (comma === -1) {
      continue;
    }

    const surface = line.slice(0, comma).trim();
    const shader = line.slice(comma + 1).trim();

    if (!surface || !shader) {
      continue; // "draw nothing" entries, including tag_ lines
    }
    if (surface.startsWith('tag_')) {
      continue;
    }

    surfaces.set(surface.toLowerCase(), shader);
  }

  return { surfaces };
}

/**
 * The shader a surface should use: the skin's choice if it has one, otherwise
 * whatever the MD3 itself named.
 */
export function shaderForSurface(
  skin: Skin | null,
  surfaceName: string,
  md3Shader: string | undefined,
): string | null {
  const fromSkin = skin?.surfaces.get(surfaceName.toLowerCase());
  return fromSkin ?? md3Shader ?? null;
}
