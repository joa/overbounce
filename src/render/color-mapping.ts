/**
 * `R_SetColorMappings` and the overbright interlock. Quake's ONLY tone control.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from `tr_image.c :: R_SetColorMappings` (id Software, GPLv2) and the
 * cvar defaults in `tr_init.c`. This file is a PORT, not an addition: it is the
 * faithful half of VISUALS.md's B3, and it is the reason the tone-mapping work
 * has a fidelity argument in its favour at all. The filmic curve lives in
 * `post.ts` and is layered on top of this; the two are deliberately separable.
 *
 * Three cvars, and they are not independent:
 *
 * | cvar                   | default | what it does                          |
 * | ---------------------- | ------- | ------------------------------------- |
 * | `r_overBrightBits`     | 1       | doubles the FRAMEBUFFER via hw gamma  |
 * | `r_mapOverBrightBits`  | 2       | scales the LIGHTMAP bytes at load     |
 * | `r_gamma`              | 1       | the gamma ramp                        |
 *
 * `R_ColorShiftLightingBytes` shifts lightmap and light-grid bytes by
 * `r_mapOverBrightBits - tr.overbrightBits`, and `R_SetColorMappings` then
 * shifts the gamma ramp back up by `tr.overbrightBits`. The two halves cancel:
 * moving brightness from the lightmap into the framebuffer is what "overbright"
 * IS. Change one without the other and the map is either four times too dark or
 * blown out.
 *
 * ## Why the default here is `overbrightBits = 0` and that is the faithful value
 *
 * `R_SetColorMappings` forces `tr.overbrightBits = 0` in three cases, and two of
 * them apply to a browser canvas unconditionally:
 *
 * ```c
 * if ( !glConfig.deviceSupportsGamma )  tr.overbrightBits = 0; // need hw gamma
 * if ( !glConfig.isFullscreen )         tr.overbrightBits = 0; // never in a window
 * ```
 *
 * A canvas has no hardware gamma ramp and is a window. So `tr.overbrightBits`
 * is 0, `identityLight` is 1, the lightmap shift is `2 - 0 = 2`, and the gamma
 * ramp's own `inf <<= shift` is a no-op. That is exactly what this renderer has
 * always done — the hardcoded `OVERBRIGHT_SHIFT = 2` was the right number, it
 * just was not spelled as a value anybody could change.
 *
 * `?overbright=1` therefore reproduces Quake's FULLSCREEN look, which is a
 * different picture from Quake in a window. Both are Quake.
 *
 * ## Deviation to know about before setting `?overbright` above 0
 *
 * `tr.identityLight` is `1 / (1 << tr.overbrightBits)` and it multiplies every
 * `rgbGen identity` stage, the fog colour (`fog.ts`) and the model colour path
 * (`md3-mesh.ts`). Both of those files hardcode `identityLight = 1` — correct
 * for the 0 default, and WRONG for any other value: shaders and fog would come
 * out `1 << overbrightBits` times too bright relative to the world. Wiring
 * `identityLight()` through them is a separate job in files this change does not
 * own. Until then, `?overbright` above 0 is a development knob, not a mode.
 */

/** `r_gamma`, `tr_init.c:935`. 1.2 on __MACOS__, 1 everywhere else. */
export const R_GAMMA_DEFAULT = 1;

/**
 * `r_overBrightBits`, `tr_init.c:886`. The cvar default is 1, but see the file
 * header: a windowed, gamma-ramp-less context forces the EFFECTIVE value to 0,
 * and a canvas is both.
 */
export const R_OVERBRIGHT_BITS_CVAR_DEFAULT = 1;

/** What `R_SetColorMappings` leaves `tr.overbrightBits` at, in a window. */
export const OVERBRIGHT_BITS_DEFAULT = 0;

/** `r_mapOverBrightBits`, `tr_init.c:911`. */
export const R_MAP_OVERBRIGHT_BITS_DEFAULT = 2;

/** `R_SetColorMappings` clamps `r_gamma` into this range with `Cvar_Set`. */
export const GAMMA_MIN = 0.5;
export const GAMMA_MAX = 3.0;

/**
 * `tr.overbrightBits` is clamped to 2 in a 24-bit mode and to 1 in 16-bit.
 * A canvas is 8 bits per channel, so 2 is the ceiling here.
 */
export const OVERBRIGHT_BITS_MAX = 2;

export interface ColorMapping {
  /** `r_gamma`. 1 is identity. */
  gamma: number;
  /** `tr.overbrightBits`, AFTER the windowed/hardware-gamma forcing. */
  overbrightBits: number;
  /** `r_mapOverBrightBits`. */
  mapOverBrightBits: number;
}

export const DEFAULT_COLOR_MAPPING: Readonly<ColorMapping> = Object.freeze({
  gamma: R_GAMMA_DEFAULT,
  overbrightBits: OVERBRIGHT_BITS_DEFAULT,
  mapOverBrightBits: R_MAP_OVERBRIGHT_BITS_DEFAULT,
});

let current: ColorMapping = { ...DEFAULT_COLOR_MAPPING };

/**
 * Clamp exactly the way `R_SetColorMappings` does, which is by rewriting the
 * cvar rather than by using a clamped local — so the clamped value is what
 * everything downstream sees.
 */
export function clampColorMapping(m: ColorMapping): ColorMapping {
  let gamma = m.gamma;
  if (!Number.isFinite(gamma) || gamma < GAMMA_MIN) {
    gamma = GAMMA_MIN;
  } else if (gamma > GAMMA_MAX) {
    gamma = GAMMA_MAX;
  }

  let overbrightBits = Math.trunc(m.overbrightBits);
  if (!Number.isFinite(overbrightBits) || overbrightBits < 0) {
    overbrightBits = 0;
  } else if (overbrightBits > OVERBRIGHT_BITS_MAX) {
    overbrightBits = OVERBRIGHT_BITS_MAX;
  }

  let mapOverBrightBits = Math.trunc(m.mapOverBrightBits);
  if (!Number.isFinite(mapOverBrightBits) || mapOverBrightBits < 0) {
    mapOverBrightBits = 0;
  }

  return { gamma, overbrightBits, mapOverBrightBits };
}

/**
 * Install a colour mapping.
 *
 * ORDERING MATTERS. `lightingShift()` is read when the lightmaps and the light
 * grid are decoded, which happens once at map load. `createRenderer` is the
 * first render call `main.ts` makes and configures this before any of that, so
 * a `?mapoverbright=` on the URL is in force by the time `buildWorldSurfaces`
 * runs. Setting it later changes only the gamma ramp, not the lightmaps.
 */
export function setColorMapping(m: Partial<ColorMapping>): ColorMapping {
  current = clampColorMapping({ ...current, ...m });
  return current;
}

export function getColorMapping(): Readonly<ColorMapping> {
  return current;
}

/** Back to Quake-in-a-window. Tests use this; nothing else should need it. */
export function resetColorMapping(): void {
  current = { ...DEFAULT_COLOR_MAPPING };
}

/**
 * `shift = r_mapOverBrightBits->integer - tr.overbrightBits` from
 * `R_ColorShiftLightingBytes` (`tr_bsp.c:104`).
 *
 * id does not guard the negative case and C's `<<` by a negative count is
 * undefined; JavaScript's would silently shift by `32 + shift`, which is a
 * different kind of wrong. Clamped to 0 here, which is the only sane reading of
 * "shift the data based on overbright range" when there is no range to shift.
 */
export function lightingShift(m: Readonly<ColorMapping> = current): number {
  const shift = m.mapOverBrightBits - m.overbrightBits;
  return shift > 0 ? shift : 0;
}

/**
 * `tr.identityLight = 1.0f / ( 1 << tr.overbrightBits )`.
 *
 * Read the file header before wiring this anywhere: `fog.ts` and `md3-mesh.ts`
 * currently assume it is 1.
 */
export function identityLight(m: Readonly<ColorMapping> = current): number {
  return 1 / (1 << m.overbrightBits);
}

/**
 * `s_gammatable`, byte for byte.
 *
 * ```c
 * for ( i = 0; i < 256; i++ ) {
 *     if ( g == 1 ) {
 *         inf = i;
 *     } else {
 *         inf = 255 * pow ( i/255.0f, 1.0f / g ) + 0.5f;
 *     }
 *     inf <<= shift;
 *     if (inf < 0) inf = 0;
 *     if (inf > 255) inf = 255;
 *     s_gammatable[i] = inf;
 * }
 * ```
 *
 * The `g == 1` branch is not an optimisation: `pow(x, 1)` is not bit-exactly
 * `x`, and this table is the identity when gamma is 1. The `+ 0.5f` followed by
 * an assignment to `int` is round-half-up, NOT round-to-nearest-even — the
 * truncation is part of the behaviour.
 *
 * Quake hands this table to `GLimp_SetGamma`, i.e. it is applied to the
 * FRAMEBUFFER, after everything else. That is why `post.ts` applies its
 * continuous analogue at the very end of the chain and in the sRGB domain
 * rather than in linear light.
 */
export function gammaTable(m: Readonly<ColorMapping> = current): Uint8Array {
  const { gamma: g, overbrightBits: shift } = clampColorMapping({ ...m });
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let inf = g === 1 ? i : Math.trunc(255 * Math.pow(i / 255, 1 / g) + 0.5);
    inf <<= shift;
    if (inf < 0) {
      inf = 0;
    }
    if (inf > 255) {
      inf = 255;
    }
    table[i] = inf;
  }
  return table;
}

/**
 * The continuous form of `s_gammatable`, on 0..1 rather than 0..255.
 *
 * This is what the shader evaluates. A 256-entry lookup would be exact, but it
 * would also need a texture upload and a sampler for a curve that agrees with
 * the table to within one 255th everywhere — which is what
 * `test/render/color-mapping.test.ts` asserts rather than assumes.
 */
export function gammaRamp(x: number, m: Readonly<ColorMapping> = current): number {
  const { gamma: g, overbrightBits } = clampColorMapping({ ...m });
  const y = (g === 1 ? x : Math.pow(x, 1 / g)) * (1 << overbrightBits);
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/** True when the ramp is the identity and the shader stage can be skipped. */
export function gammaRampIsIdentity(m: Readonly<ColorMapping> = current): boolean {
  const c = clampColorMapping({ ...m });
  return c.gamma === 1 && c.overbrightBits === 0;
}
