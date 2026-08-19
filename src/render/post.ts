/**
 * The post-processing layer. NONE of this is Quake III, except the gamma ramp.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `.agent/plans/VISUALS.md` Track B: SSAO (B1), the filmic tone curve (B3's
 * second half) and chromatic aberration (B4). Quake has no ambient occlusion,
 * no lens simulation and no tone curve beyond `r_gamma` and the overbright
 * shift, so everything here is a deliberate aesthetic addition. The faithful
 * half of B3 — `r_gamma` / `r_overBrightBits` / `r_mapOverBrightBits` — is a
 * port and lives in `color-mapping.ts`; this file only evaluates its ramp.
 *
 * Two risks the plan names, and the two rules that fall out of them:
 *
 * 1. **Legibility.** Overbounce spots are decided by sub-unit geometry and a
 *    player judges a ledge height by eye. SSAO darkens exactly the floor/wall
 *    junction that reading depends on, so the darkening is CAPPED
 *    (`ssaomax`) rather than merely scaled — a cap is a floor on how dark a
 *    corner can get, which is the property that matters.
 * 2. **Comparability.** A picture that stops matching Quake stops being
 *    comparable with defrag footage. So every effect has an off switch, the
 *    whole layer has one, and `?post=off` does not build the chain at all —
 *    `Renderer.render` falls back to the bare `renderer.render(scene, camera)`
 *    this project had before. That is what keeps the layer from quietly
 *    becoming load-bearing.
 *
 * ## URL parameters
 *
 * | parameter        | default | meaning                                        |
 * | ---------------- | ------- | ---------------------------------------------- |
 * | `post`           | `on`    | `off` skips the chain entirely                 |
 * | `fxaa`           | `on`    | `off` disables antialiasing                    |
 * | `tonemap`        | `agx`   | `off`, `neutral`, `aces`, `cineon`, `reinhard` |
 * | `exposure`       | `1.6`   | linear exposure into the tone curve, `0.1..8`  |
 * | `ssao`           | `world` | `off`, `world`, `all`, or a strength `0..1`    |
 * | `ssaostrength`   | `1`     | how much of the occlusion to apply, `0..1`     |
 * | `ssaoradius`     | `24`    | occlusion radius in Q3 units (~inches)         |
 * | `ssaomax`        | `0.35`  | hard cap on how much SSAO may darken a pixel   |
 * | `ssaoresolution` | `0.5`   | fraction of the backbuffer the AO runs at      |
 * | `ssaosamples`    | `16`    | GTAO samples per pixel                         |
 * | `ssaodebug`      | `off`   | `ao`, `depth`, `normal`, `mask` — see below    |
 * | `aberration`     | `0.1`   | radial chromatic aberration strength; 0 = off  |
 * | `gamma`          | `1`     | `r_gamma` (faithful; clamped to 0.5..3)        |
 * | `overbright`     | `0`     | `r_overBrightBits` (see `color-mapping.ts`)    |
 * | `mapoverbright`  | `2`     | `r_mapOverBrightBits`                          |
 *
 * `?tonemap=off&ssao=off&aberration=0` is the faithful configuration: it leaves
 * FXAA and nothing else, and is what any screenshot meant to be compared with
 * Quake or with defrag footage should use. `?post=off` is stricter still.
 *
 * `?post=off` also disables `?gamma` and `?overbright`'s framebuffer half,
 * because the ramp is a post stage — `?mapoverbright` still applies, since that
 * one is baked into the lightmaps at load. A warning is logged rather than
 * silently ignoring the request.
 *
 * ## Why the chain is in this order
 *
 * ```
 *   scenePass            linear, HDR-capable render target
 *     x SSAO             linear: occlusion is a light term, not a colour term
 *     x exposure         linear, and ONLY when a tone curve follows
 *     -> tone curve      linear -> display, only if ?tonemap is set
 *     -> renderOutput()  sRGB encode; outputColorTransform is turned OFF so
 *                        this is explicit rather than appended after FXAA
 *     -> r_gamma ramp    sRGB domain, because s_gammatable maps FRAMEBUFFER
 *                        BYTES — Quake handed it to GLimp_SetGamma
 *     -> FXAA            wants sRGB input; this is why the encode comes first
 *     -> aberration      last, so it displaces final pixels
 * ```
 *
 * ## AgX is on by default, and `?exposure` is why it can be
 *
 * The input to the curve is LINEAR and that was checked rather than assumed:
 * the scene pass renders into a `HalfFloatType` target with no colour space
 * tagged, and `renderOutput` is the single sRGB encode in the chain. Measured
 * on q3dm6, `?post=off` and the chain with every effect off average
 * `(46.37, 28.29, 26.50)` and `(46.40, 28.27, 26.46)` per channel — 0.19 counts
 * apart. There is no double encode to blame.
 *
 * What is left is real and is not a bug: **AgX is a scene-referred curve and
 * Quake's content is display-referred.** Linear 1.0 — white — lands at about
 * 0.79 on the display through AgX, and the whole picture sits in the toe, so a
 * dark map loses its shadows. That is what "it greys out the purples" was.
 *
 * `?exposure` is the fix, and it is a pre-multiply in LINEAR immediately before
 * the curve. 1.6 was picked by measuring, at two positions on q3dm6, the
 * per-channel mean against the same frame with no curve:
 *
 * | exposure | dark corridor        | bright room          |
 * | -------- | -------------------- | -------------------- |
 * | none     | (20.8, 13.0, 11.4)   | (46.4, 28.3, 26.5)   |
 * | 1.0      | (17.3,  8.8,  7.5)   | (45.8, 24.5, 22.2)   |
 * | 1.6      | (24.9, 14.1, 12.2)   | (61.7, 36.1, 33.1)   |
 * | 2.0      | (29.0, 17.2, 14.9)   | (69.9, 42.4, 39.1)   |
 *
 * At 1.0 the curve costs the dark map a sixth of its brightness and a fifth of
 * its lit pixels; at 2.0 the shadows lift enough to look hazy. 1.6 keeps the
 * shadows and buys the highlight rolloff, which is the one thing the curve is
 * actually for here: Quake's additive stages — the muzzle flashes, the lamp
 * glows, `rgbGen wave` — go past 1.0 in the pass target and used to hard-clip.
 *
 * `?tonemap=off` remains the faithful setting and always will.
 *
 * ## SSAO is world-only, and how that is enforced
 *
 * A spinning item whose own occlusion changes frame to frame shimmers, which is
 * worse than no AO on it at all. So AO is applied through a MASK carried in the
 * ALPHA of the one extra MRT attachment: the scene pass writes 0 for everything
 * by default, and `markAoWorld()` overrides it to 1 on the world's own materials
 * via `material.mrtNode`. Models are never marked, so they never RECEIVE AO.
 *
 * They do still CAST it: the occlusion is computed from the full scene depth,
 * which is free because that depth buffer already exists. A player standing on
 * a floor therefore gets contact darkening under them, which reads as grounding
 * rather than as shimmer. Making models not cast either would need a second,
 * world-only geometry pass, and that is not worth a full extra draw of the map.
 *
 * The default mask of 0 means an UNWIRED build applies no AO anywhere rather
 * than applying it to models by mistake — the safe direction for a project
 * whose product is fidelity. It is also exactly the kind of quiet no-op
 * `.agent/docs/render-gotchas.md` warns about, so `markAoWorld` not being
 * called is reported loudly on the first frame instead of looking like a
 * driver problem.
 *
 * The one call this needs from outside, now wired in `main.ts`:
 *
 * ```ts
 * r.world.add(surfaces.object);
 * r.post?.markAoWorld(surfaces.object);
 * ```
 *
 * **A marked material must never be drawn through a pass that has no MRT.**
 * `NodeMaterial` falls back to `resultNode = materialMRT` when the renderer has
 * no MRT set, `MRTNode.setup` then drops every output whose name is not a
 * texture on the current target, and an empty output list compiles to
 * `struct OutputType {}` — which WGSL rejects, so the pipeline is invalid and
 * the surface silently does not draw. One chain per renderer is what keeps this
 * safe; anything that renders the world into its own target (a shadow map, a
 * diagnostic pass) has to clear `mrtNode` first or give its target an
 * attachment of the same name.
 *
 * ## What SSAO costs, and why the defaults moved
 *
 * Measured in an isolated headless Chrome on the real adapter, q3dm6, one
 * session per row, interleaved, min of 21 reps of 30 renders. `base` is this
 * chain with `?ssao=off`, so every row below it is the marginal cost of the AO
 * pass and nothing else.
 *
 * Cost of the AO pass alone, in ms, at three backbuffer sizes:
 *
 * | configuration                            | 1280x800 | 1600x900 | 1920x1080 |
 * | ---------------------------------------- | -------- | -------- | --------- |
 * | base: AgX + FXAA + aberration, no SSAO   | 1.23 ms  | 1.11 ms  | 1.12 ms   |
 * | the OLD defaults: r=32, full resolution  | +0.24    | +0.96    | **+2.90** |
 * | r=24, full resolution                    | +0.18    | +0.83    | +2.00     |
 * | r=32, half resolution                    | +0.12    | +0.21    | +1.02     |
 * | the defaults here: r=24, half resolution | +0.17    | +0.17    | **+0.74** |
 * | r=24, half resolution, 8 samples         | +0.10    | +0.14    | +0.45     |
 *
 * Reproduced across two independent sessions at 1920x1080 to within 0.04 ms.
 *
 * At 1920x1080 the old configuration cost **two and a half times the entire
 * rest of the frame** — 72% of the frame's GPU time — for an effect that
 * darkened the average pixel by about 4%. Expensive and nearly invisible at the
 * same time, which is exactly what it was reported as. Note how badly it
 * scales: 1600x900 to 1920x1080 is 1.44x the pixels and 3x the cost, so a
 * 1280x800 window says nothing about a full-screen one.
 *
 * Two things were wrong with it, and they pull in opposite directions:
 *
 * - **Cost.** `resolutionScale` was left at 1, so the AO ran at every pixel of
 *   a 1920x1080 backbuffer. Occlusion is low-frequency by construction; at 0.5
 *   the picture is the same one — diffed directly against the full-resolution
 *   frame it differs by 0.27 counts over 1% of pixels, where the effect itself
 *   is worth 3.36 counts over 44% — and the pass is 2.7x cheaper. Radius
 *   costs too, and superlinearly in resolution — the taps are placed in view
 *   space and projected, so a large radius scatters them across the depth
 *   buffer and misses cache. At 1280x800 the whole spread collapses to
 *   0.10–0.24 ms and the orderings sit inside the noise; the cliff is real and
 *   it is a resolution cliff.
 * - **Visibility.** `strength 0.6` on top of `max 0.25` meant at most 15%
 *   darkening, and the occlusion buffer averages 0.96 at this radius. The
 *   defaults are now strength 1 against a 0.35 cap. Diffed against the same
 *   chain with `?ssao=off`, at two positions on q3dm6 in one session: the old
 *   values move the frame 1.97 and 0.64 counts, the new ones 3.36 and 1.08 —
 *   **1.7x more picture at both**, for a quarter of the cost.
 *
 * The radius was never the visibility problem: the old parameters at full
 * strength and no cap reach 3.83 and 1.35. Cost and visibility were two
 * independent mistakes, which is why fixing either alone would still have
 * looked wrong.
 *
 * The cap is still the legibility guard and is still a cap rather than a scale.
 *
 * ## Normals come from the geometry, after depth reconstruction failed
 *
 * `GTAONode` will reconstruct a view normal from the depth buffer if given a
 * null `normalNode`, which is attractive here: every material is a
 * `MeshBasicNodeMaterial` because Quake's lighting is baked, so there is no
 * shading to feed a normal target from.
 *
 * It does not work at this camera's `near = 4` / `far = 32768`. The
 * reconstruction came back as a constant `(0, 0, 1)` across the whole screen and
 * the occlusion buffer as a flat 1.0 — and neither `ssaostrength` nor `ssaomax`
 * at maximum revealed anything, because there was nothing to reveal. A subtle
 * effect that is doing nothing looks exactly like a subtle effect.
 *
 * So the attachment carries `vec4(normalView, aoMask)` — the geometry's own
 * normal, which every BSP and MD3 surface has, plus the mask. One attachment for
 * both. `?ssaodebug=ao|depth|normal|mask` puts each stage on the screen and is
 * kept for the next time this looks broken.
 */

import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  NormalBlending,
  ReinhardToneMapping,
  RenderPipeline,
  SRGBColorSpace,
} from 'three/webgpu';
import type {
  Camera,
  Material,
  Node,
  Object3D,
  Scene,
  ToneMapping,
  WebGPURenderer,
} from 'three/webgpu';
import {
  float,
  mrt,
  output,
  pass,
  renderOutput,
  normalView,
  screenUV,
  time,
  vec2,
  vec4,
} from 'three/tsl';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js';
import { chromaticAberration } from 'three/examples/jsm/tsl/display/ChromaticAberrationNode.js';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { gaussianBlur } from 'three/examples/jsm/tsl/display/GaussianBlurNode.js';
import {
  LAVA_BLOOM_RADIUS,
  LAVA_BLOOM_STRENGTH,
  SHIMMER_AMPLITUDE,
  shimmerOffset,
} from './lava.js';
import {
  gammaRampIsIdentity,
  getColorMapping,
  setColorMapping,
} from './color-mapping.js';
import type { ColorMapping } from './color-mapping.js';

/**
 * `?ssao=`. `world` masks the effect to geometry passed to `markAoWorld`;
 * `all` ignores the mask and is for comparison shots, not for playing.
 */
export type SsaoMode = 'off' | 'world' | 'all';

/** `?tonemap=`. `none` is the faithful setting — Quake has no tone curve. */
export type ToneCurve = 'none' | 'agx' | 'neutral' | 'aces' | 'cineon' | 'reinhard';

/**
 * `?ssaodebug=` — put an intermediate buffer on the screen instead of the game.
 *
 * `ao` is the occlusion itself, `depth` the linearised depth GTAO reads and
 * `normal` the normal it reconstructs from that depth. Three views because the
 * failure mode is a chain: a flat white occlusion buffer says only "nothing was
 * occluded", and the reason can be at any of the three stages.
 */
export type SsaoDebug = 'off' | 'ao' | 'depth' | 'normal' | 'mask';

const SSAO_DEBUG_MODES: readonly SsaoDebug[] = ['off', 'ao', 'depth', 'normal', 'mask'];

function ssaoDebug(params: URLSearchParams): SsaoDebug {
  const raw = params.get('ssaodebug');
  if (raw === null) {
    return 'off';
  }
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'on' || v === '1' || v === 'true') {
    return 'ao';
  }
  if ((SSAO_DEBUG_MODES as readonly string[]).includes(v)) {
    return v as SsaoDebug;
  }
  console.warn(`[overbounce] ignoring ?ssaodebug=${raw}: expected ${SSAO_DEBUG_MODES.join(', ')}`);
  return 'off';
}

export interface PostOptions {
  /** `?post=off` skips construction of the chain altogether. */
  enabled: boolean;
  fxaa: boolean;
  tone: ToneCurve;
  /**
   * Linear exposure applied immediately BEFORE the tone curve, and only when
   * there is one. See the `?exposure` note in the file header: Quake's content
   * is display-referred, so a scene-referred curve like AgX sees a picture that
   * never leaves its toe unless it is pre-exposed.
   */
  exposure: number;
  ssao: SsaoMode;
  /** Occlusion radius in Q3 units. The world is ~1 unit per inch. */
  ssaoRadius: number;
  /** How much of the computed occlusion to apply, 0..1. */
  ssaoStrength: number;
  /**
   * The legibility guard: the most SSAO may darken any pixel, 0..1.
   *
   * A cap, not a scale. Scaling makes every corner lighter including the ones
   * that were fine; a cap only touches the corners that were about to become
   * unreadable, which is the thing the plan is actually worried about.
   */
  ssaoMaxDarkening: number;
  /**
   * `GTAONode.resolutionScale`: the fraction of the backbuffer the occlusion is
   * computed at. THE cost dial — the AO pass is the whole cost of SSAO here and
   * it scales with its own pixel count, so 0.5 is a quarter of the work.
   */
  ssaoResolution: number;
  /**
   * `GTAONode.samples`. 16 gives 3 slices of 6 steps and 36 depth taps per
   * pixel; below 30 the node uses 3 slices, so the tap count is
   * `3 * ceil(samples/3) * 2`. There is no denoise pass in this chain, so
   * lowering it trades cost for noise with nothing to hide the noise.
   */
  ssaoSamples: number;
  /**
   * `?ssaodebug` — replace the picture with the raw occlusion buffer.
   *
   * Not decoration. A subtle effect that is doing nothing and a subtle effect
   * that is working look identical, and the first version of this chain was
   * the former: at `GTAONode`'s metre-scale default radius the occlusion was
   * a flat white field and no amount of turning the strength up revealed it.
   */
  ssaoDebug: SsaoDebug;
  /** Radial chromatic aberration strength. 0 disables the stage. */
  aberration: number;
  /**
   * `?lavabloom` — how hard lava blooms, 0..1. 0 removes the stage entirely.
   *
   * NOT Quake, and switchable for the reason `lava.ts` records: this is a
   * speedrunning game, and a bloom that spills over the edge of a lava pit
   * moves where that edge appears to be.
   */
  lavaBloom: number;
  /** `?lavabloomradius` — spread, in fractions of screen height. */
  lavaBloomRadius: number;
  /** `?lavashimmer` — peak heat-haze displacement in UV units. 0 removes it. */
  lavaShimmer: number;
  /** The faithful half of B3. See `color-mapping.ts`. */
  colorMapping: ColorMapping;
}

const TONE_CURVES: ReadonlyMap<ToneCurve, ToneMapping> = new Map<ToneCurve, ToneMapping>([
  ['none', NoToneMapping],
  ['agx', AgXToneMapping],
  ['neutral', NeutralToneMapping],
  ['aces', ACESFilmicToneMapping],
  ['cineon', CineonToneMapping],
  ['reinhard', ReinhardToneMapping],
]);

/**
 * Defaults, and the reasoning for each:
 *
 * - **FXAA on.** A pass render target does not carry the canvas's MSAA, so
 *   turning the chain on without FXAA would be a visible downgrade in edge
 *   quality rather than a neutral change.
 * - **AgX on, at exposure 1.6.** The project owner asked for it as the default.
 *   Quake's content was authored for a clamped 0..1 pipeline, so the curve does
 *   change every colour in the game — the exposure is what stops it also
 *   changing the overall brightness. See the header for the measurements.
 *   `?tonemap=off` is the faithful setting and is one parameter away.
 * - **SSAO on, world-only, at half resolution.** Subtle enough to keep a ledge
 *   readable and strong enough to be there at all: the previous values were
 *   0.6 strength against a 0.25 cap, which is at most 15% darkening on an
 *   occlusion buffer that averages 0.96. Nobody could see it and it cost 72% of
 *   the frame.
 * - **Aberration 0.1, not 0.** The plan's instinct — off by default — produced
 *   a feature nobody could tell had been built. 0.1 displaces the red and blue
 *   channels by 1.4 pixels at the edge of a 1280-wide frame and by exactly zero
 *   at the crosshair, because the displacement is proportional to the distance
 *   from the centre. That is small enough not to touch aim judgement, which is
 *   the plan's actual concern, and it is visible on a high-contrast edge.
 */
export const DEFAULT_POST_OPTIONS: Readonly<PostOptions> = Object.freeze({
  enabled: true,
  fxaa: true,
  lavaBloom: LAVA_BLOOM_STRENGTH,
  lavaBloomRadius: LAVA_BLOOM_RADIUS,
  lavaShimmer: SHIMMER_AMPLITUDE,
  tone: 'agx' as ToneCurve,
  exposure: 1.6,
  ssao: 'world' as SsaoMode,
  ssaoRadius: 24,
  ssaoStrength: 1,
  ssaoMaxDarkening: 0.35,
  ssaoResolution: 0.5,
  ssaoSamples: 16,
  ssaoDebug: 'off' as SsaoDebug,
  aberration: 0.1,
  colorMapping: getColorMapping() as ColorMapping,
});

function flag(params: URLSearchParams, name: string, fallback: boolean): boolean {
  const raw = params.get(name);
  if (raw === null) {
    return fallback;
  }
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'on' || v === '1' || v === 'true' || v === 'yes') {
    return true;
  }
  if (v === 'off' || v === '0' || v === 'false' || v === 'no') {
    return false;
  }
  console.warn(`[overbounce] ignoring ?${name}=${raw}: expected on or off`);
  return fallback;
}

function num(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) {
    return fallback;
  }
  const v = Number(raw.trim());
  if (!Number.isFinite(v)) {
    console.warn(`[overbounce] ignoring ?${name}=${raw}: expected a number`);
    return fallback;
  }
  return v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Read the whole layer's configuration off a query string.
 *
 * Pure, and exported so it can be tested in Node without a GPU: the toggles are
 * the part of this file that has to keep working, because they are what the
 * suite relies on to prove the layer is optional.
 */
export function parsePostOptions(search: string | URLSearchParams): PostOptions {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;

  const colorMapping: ColorMapping = {
    gamma: num(params, 'gamma', DEFAULT_POST_OPTIONS.colorMapping.gamma),
    overbrightBits: num(params, 'overbright', DEFAULT_POST_OPTIONS.colorMapping.overbrightBits),
    mapOverBrightBits: num(
      params,
      'mapoverbright',
      DEFAULT_POST_OPTIONS.colorMapping.mapOverBrightBits,
    ),
  };

  // ?ssao accepts a mode OR a bare strength, because "a bit less of it" is the
  // request that actually comes up while tuning and `?ssao=0.3` is how anyone
  // would try to say it.
  let ssao: SsaoMode = DEFAULT_POST_OPTIONS.ssao;
  let ssaoStrength = DEFAULT_POST_OPTIONS.ssaoStrength;
  const rawSsao = params.get('ssao');
  if (rawSsao !== null) {
    const v = rawSsao.trim().toLowerCase();
    if (v === 'off' || v === '0' || v === 'false' || v === 'no') {
      ssao = 'off';
    } else if (v === 'all' || v === 'models' || v === 'everything') {
      ssao = 'all';
    } else if (v === '' || v === 'on' || v === 'world' || v === 'true' || v === 'yes') {
      ssao = 'world';
    } else if (Number.isFinite(Number(v))) {
      ssao = 'world';
      ssaoStrength = clamp01(Number(v));
    } else {
      console.warn(`[overbounce] ignoring ?ssao=${rawSsao}: expected off, world, all or 0..1`);
    }
  }

  let tone = DEFAULT_POST_OPTIONS.tone;
  const rawTone = params.get('tonemap');
  if (rawTone !== null) {
    const v = rawTone.trim().toLowerCase();
    const named = v === 'off' || v === 'none' || v === '0' ? 'none' : (v as ToneCurve);
    if (TONE_CURVES.has(named)) {
      tone = named;
    } else {
      console.warn(
        `[overbounce] ignoring ?tonemap=${rawTone}: expected one of ` +
          `${[...TONE_CURVES.keys()].join(', ')}`,
      );
    }
  }

  return {
    enabled: flag(params, 'post', DEFAULT_POST_OPTIONS.enabled),
    fxaa: flag(params, 'fxaa', DEFAULT_POST_OPTIONS.fxaa),
    tone,
    exposure: clampRange(num(params, 'exposure', DEFAULT_POST_OPTIONS.exposure), 0.1, 8),
    ssao,
    lavaBloom: clamp01(num(params, 'lavabloom', DEFAULT_POST_OPTIONS.lavaBloom)),
    lavaBloomRadius: Math.max(0, num(params, 'lavabloomradius', DEFAULT_POST_OPTIONS.lavaBloomRadius)),
    lavaShimmer: Math.max(0, num(params, 'lavashimmer', DEFAULT_POST_OPTIONS.lavaShimmer)),
    ssaoRadius: num(params, 'ssaoradius', DEFAULT_POST_OPTIONS.ssaoRadius),
    ssaoStrength: clamp01(num(params, 'ssaostrength', ssaoStrength)),
    ssaoMaxDarkening: clamp01(num(params, 'ssaomax', DEFAULT_POST_OPTIONS.ssaoMaxDarkening)),
    ssaoResolution: clampRange(
      num(params, 'ssaoresolution', DEFAULT_POST_OPTIONS.ssaoResolution),
      0.1,
      1,
    ),
    ssaoSamples: Math.round(
      clampRange(num(params, 'ssaosamples', DEFAULT_POST_OPTIONS.ssaoSamples), 3, 64),
    ),
    ssaoDebug: ssaoDebug(params),
    aberration: num(params, 'aberration', DEFAULT_POST_OPTIONS.aberration),
    colorMapping,
  };
}

/**
 * True when the chain would be an exact pass-through and is therefore not worth
 * building. Note FXAA does NOT count as a pass-through: it changes pixels.
 */
export function postIsNoop(o: PostOptions): boolean {
  return (
    !o.enabled ||
    (!o.fxaa &&
      o.tone === 'none' &&
      (o.ssao === 'off' || o.ssaoStrength === 0) &&
      o.aberration === 0 &&
      gammaRampIsIdentity(o.colorMapping))
  );
}

export interface PostChain {
  readonly options: Readonly<PostOptions>;
  /** Draw one frame through the chain. Replaces `renderer.render`. */
  render(): void;
  /**
   * Let SSAO apply to this subtree.
   *
   * Call it with the world surfaces group and nothing else. Returns how many
   * materials were marked, which is the number to look at when AO does not
   * appear.
   */
  markAoWorld(object: Object3D): number;
  /**
   * Mark this subtree as LAVA, so the bloom and the heat haze find it.
   *
   * Same shape as `markAoWorld` and for the same reason: the post chain cannot
   * see a shader's `surfaceparm`, so the world builder has to tell it. Returns
   * how many materials were marked -- zero on the many maps with no lava, which
   * is not a warning.
   */
  markLava(objects: Iterable<Object3D>): number;
  dispose(): void;
}

/**
 * The name of the single extra MRT attachment: view normal in rgb, AO mask in
 * alpha.
 *
 * `GTAONode` can reconstruct a normal from depth instead — pass it a null
 * `normalNode` and it calls `getNormalFromDepth`. That was the first thing
 * tried here and it does not survive this project's camera: with `near = 4` and
 * `far = 32768` the reconstruction came back as a constant `(0, 0, 1)` over the
 * entire screen, and the occlusion buffer with it as a flat 1.0. Writing the
 * normal the geometry already has costs one attachment and removes the whole
 * question. `?ssaodebug=normal` is what showed it, and is kept for the next
 * time.
 */
const G_BUFFER = 'aoNormalMask';

/**
 * The second extra attachment: 1 where lava was drawn, 0 everywhere else.
 *
 * It has to be its own attachment rather than another channel of `G_BUFFER`,
 * and the reason is that the two are independent: `G_BUFFER` exists only when
 * SSAO is on, its alpha is already the AO world mask, and lava bloom has to
 * work under `?ssao=off`. Only rgb is used (as a scalar in r); the alpha is
 * spare.
 */
const LAVA_BUFFER = 'lavaMask';

/**
 * `ChromaticAberrationNode`'s own default for the per-channel scale step. It is
 * a multiplier on a hardcoded 0.02, not a distance, so it is left where the
 * node put it and `?aberration=` is the only dial.
 */
const ABERRATION_SCALE = 1.1;

/**
 * Whether a material may carry an AO mask override.
 *
 * Only fully opaque materials. `MRTNode.merge` builds the merged node with
 * `mrtTarget.blendings = blendings` while the property it is read back from is
 * `blendModes` — so a merged MRT loses the `output: MaterialBlending` entry and
 * every attachment falls back to no blending. For an opaque material that is
 * already the state, so nothing changes; for a `CustomBlending` filter surface
 * or an additive glow it would silently turn the blend off, which is the
 * `MultiplyBlending` failure in `.agent/docs/render-gotchas.md` all over again.
 */
function canCarryAoMask(material: Material): boolean {
  return material.transparent !== true && material.blending === NormalBlending;
}

/**
 * State the node type that `FXAANode` and `ChromaticAberrationNode` already
 * have.
 *
 * Both are declared in `@types/three` as a bare `TempNode` with no node type,
 * so TypeScript cannot see that they produce a vec4 — which both plainly do:
 * `FXAANode`'s `ApplyFXAA` and `ChromaticAberrationNode`'s
 * `ApplyChromaticAberration` are both `setLayout({ type: 'vec4' })`. The cast is
 * the declaration catching up with the implementation, and it is safe at
 * runtime for a second reason: TSL defines the swizzle and operator methods on
 * `Node.prototype` itself, so every node has them regardless of how it was
 * typed.
 */
function asColorNode(node: object): Node<'vec4'> {
  return node as unknown as Node<'vec4'>;
}

export function createPostChain(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  options: PostOptions,
): PostChain {
  const scenePass = pass(scene, camera);
  const useSsao = options.ssao !== 'off' && options.ssaoStrength > 0;
  const useLava = options.lavaBloom > 0 || options.lavaShimmer > 0;

  /*
   * The extra attachments, each present only when something reads it.
   *
   * `G_BUFFER` carries both things SSAO needs -- view normal in rgb, world mask
   * in alpha. `LAVA_BUFFER` is a separate attachment rather than another
   * channel of the first, because the two are independent: lava bloom has to
   * work under `?ssao=off`, when `G_BUFFER` does not exist at all.
   */
  if (useSsao || useLava) {
    const outputs: Record<string, Node<'vec4'>> = { output };
    if (useSsao) {
      outputs[G_BUFFER] = vec4(normalView, 0);
    }
    if (useLava) {
      outputs[LAVA_BUFFER] = vec4(0, 0, 0, 0);
    }
    scenePass.setMRT(mrt(outputs));
  }

  let color: Node<'vec4'> = scenePass;

  /*
   * HEAT SHIMMER, and it runs FIRST -- before AO, before the tone curve.
   *
   * It is a resample of the scene at a displaced coordinate, so it has to
   * happen while `color` is still a texture that can be sampled somewhere
   * other than at this fragment. One stage later it is an expression.
   *
   * The mask is BLURRED. Sampled sharp, the haze would stop at the lava's
   * silhouette with a hard edge -- a rectangle of wobbling pixels, which reads
   * as a rendering fault rather than as hot air. Blurred, it fades out above
   * the surface, which is where rising heat actually distorts.
   *
   * The AO and depth buffers are deliberately NOT displaced. They are read at
   * the undistorted coordinate, so occlusion is off by the shimmer offset --
   * 0.0025 of the screen, three pixels at 1280, against a low-frequency effect.
   * Distorting them too would mean a second full-resolution resample of both.
   */
  if (options.lavaShimmer > 0) {
    const mask = gaussianBlur(scenePass.getTextureNode(LAVA_BUFFER), vec2(3, 3), 4);
    const offset = shimmerOffset(
      screenUV,
      time,
      (mask as unknown as Node<'vec4'>).r,
      options.lavaShimmer,
    );
    // `PassNode` itself is not samplable; its OUTPUT texture node is, and
    // `.sample(uv)` on a texture node is the resample this needs.
    color = asColorNode(scenePass.getTextureNode().sample(screenUV.add(offset)));
  }

  if (useSsao) {
    const gbuffer = scenePass.getTextureNode(G_BUFFER);
    const aoNode = ao(scenePass.getTextureNode('depth'), gbuffer, camera);
    // GTAONode's defaults are tuned for a metre-scale scene: radius 0.25,
    // thickness 1. Q3 is ~1 unit per inch, so at the defaults the occlusion
    // radius here is a quarter of an INCH and the effect is invisible.
    //
    // The plan calls 32 units already large. 24 is the default here: it is
    // still a gradient at a wall/floor junction rather than the thin outline a
    // radius of 12 gives, and radius is one of the two things that made this
    // pass cost 72% of the frame — the taps are placed in view space and
    // projected, so a large radius scatters them across the depth buffer and
    // misses cache. The other is `resolutionScale`, below. Header for numbers.
    aoNode.radius.value = options.ssaoRadius;
    aoNode.thickness.value = options.ssaoRadius * 4;
    aoNode.distanceExponent.value = 1;
    aoNode.distanceFallOff.value = 1;
    aoNode.scale.value = 1;
    aoNode.samples.value = options.ssaoSamples;
    // THE cost dial, and the one the first version of this file left at 1.
    // `GTAONode.setSize` multiplies the drawing buffer size by this every
    // frame, so 0.5 is a quarter of the AO pixels — and at 1920x1080 that is
    // 2.00 ms down to 0.74 ms. Directly diffed against the full-resolution
    // frame it costs 0.27 counts of mean absolute difference over 1% of pixels,
    // against an effect that is worth 3.36 counts over 44%: eight percent of
    // the effect for a third of the price. Occlusion is low-frequency.
    aoNode.resolutionScale = options.ssaoResolution;

    const occlusion = aoNode.getTextureNode().r;
    // The legibility cap. `ssaoMaxDarkening` of 0.35 means a corner can never
    // drop below 65% of its lit value no matter how enclosed it is.
    const capped = occlusion.max(float(1 - options.ssaoMaxDarkening));
    const mask = options.ssao === 'all' ? float(1) : gbuffer.a;
    const factor = float(1).sub(float(1).sub(capped).mul(options.ssaoStrength).mul(mask));
    if (options.ssaoDebug === 'ao') {
      color = vec4(occlusion, occlusion, occlusion, float(1));
    } else if (options.ssaoDebug === 'depth') {
      // The linear view depth GTAO reads, scaled so a whole Q3 room is a
      // visible gradient rather than a flat white field: the camera's far
      // plane is 32768 units and nothing in a map is near it.
      const linear = scenePass.getViewZNode('depth').negate().div(float(2048));
      color = vec4(linear, linear, linear, float(1));
    } else if (options.ssaoDebug === 'normal') {
      color = vec4(gbuffer.rgb.mul(0.5).add(0.5), float(1));
    } else if (options.ssaoDebug === 'mask') {
      color = vec4(gbuffer.a, gbuffer.a, gbuffer.a, float(1));
    } else {
      color = vec4(color.rgb.mul(factor), color.a);
    }
  }

  /*
   * LAVA BLOOM.
   *
   * In LINEAR, before the tone curve, because that is what bloom is: light
   * scattering in a lens, which happens to the scene's radiance and not to the
   * display values a curve produces. Bloom after tone mapping is the classic
   * way to get a milky picture that never quite goes bright.
   *
   * `threshold` is 0 and the masking does the thresholding instead: the input
   * is the scene's own colour multiplied by the lava mask, so the ONLY thing
   * that can bloom is lava. A luminance threshold would also catch every lamp,
   * every rocket, and the sky.
   *
   * `LAVA_BLOOM_STRENGTH` is deliberately modest. See `lava.ts`: lava is
   * usually a floor the player has to judge a jump across, and a bloom that
   * spills past its own edge moves where that edge appears to be.
   */
  if (options.lavaBloom > 0) {
    const lava = scenePass.getTextureNode(LAVA_BUFFER);
    const emissive = vec4(color.rgb.mul((lava as unknown as Node<'vec4'>).r), color.a);
    color = vec4(
      color.rgb.add(
        asColorNode(
          bloom(emissive, options.lavaBloom, options.lavaBloomRadius, 0),
        ).rgb,
      ),
      color.a,
    );
  }

  // Exposure, and it belongs HERE — in linear, immediately before the curve,
  // and only when there is a curve. A tone curve is a scene-referred device: it
  // maps an open-ended range of light onto a display. Quake's content is
  // already display-referred, so linear 1.0 is white and the whole picture sits
  // in the curve's toe; AgX at exposure 1 maps 1.0 to about 0.79 and eats the
  // shadows of a dark map. `?exposure` is the one knob that moves the content
  // into the part of the curve it was designed for.
  //
  // It is deliberately NOT `renderer.toneMappingExposure`: that is shared state
  // on an object this file does not own, and it would apply to anything else
  // that ever tone maps.
  //
  // A `?ssaodebug` view is a diagnostic, so it skips both: a tone-mapped
  // occlusion buffer is a buffer that lies about its own values.
  const debugging = useSsao && options.ssaoDebug !== 'off';
  const tone = debugging ? 'none' : options.tone;
  if (tone !== 'none' && options.exposure !== 1) {
    color = vec4(color.rgb.mul(float(options.exposure)), color.a);
  }

  // Tone curve and sRGB encode, explicitly rather than through the pipeline's
  // own appended output transform: FXAA has to run AFTER the encode, and the
  // appended transform would put it after FXAA.
  color = renderOutput(color, TONE_CURVES.get(tone) ?? NoToneMapping, SRGBColorSpace);

  // `s_gammatable`, in the sRGB domain. See color-mapping.ts.
  const mapping = options.colorMapping;
  if (!gammaRampIsIdentity(mapping)) {
    const lit =
      mapping.gamma === 1 ? color.rgb : color.rgb.clamp(0, 1).pow(float(1 / mapping.gamma));
    color = vec4(lit.mul(float(1 << mapping.overbrightBits)).clamp(0, 1), color.a);
  }

  if (options.fxaa) {
    color = asColorNode(fxaa(color));
  }

  if (options.aberration > 0) {
    // Radial, and the CENTRE HAS TO BE PASSED. `ChromaticAberrationNode`'s
    // documentation says a null centre "uses screen center (0.5, 0.5)", and
    // nothing in the node implements that: the constructor stores the null and
    // the shader subtracts it, so the effect scales from the corner of the
    // screen instead of from the middle. The symptom is the one thing this
    // effect must never do — a uniform colour split across the whole image,
    // crosshair included, instead of zero displacement at the point the player
    // is aiming at.
    //
    // With a real centre the displacement is `0.022 * strength` of the distance
    // from the middle, so the default `?aberration=0.1` is 1.4 pixels at the
    // edge of a 1280-wide frame and exactly nothing at the crosshair.
    //
    // It was 0 before, which is why this was reported as "not implemented": the
    // stage is not even constructed at 0, so the only evidence the feature
    // existed was a comment. A default you cannot see is indistinguishable from
    // a default that is not there. Measured on q3dm6, against the same frame
    // with the stage removed: 0.1 moves 2.03 counts of mean absolute
    // difference over 30% of pixels, 1.0 moves 6.9 over 75%, and 4.0 moves 9.4
    // over 87% and looks like a broken television. `.agent/docs/shots/cmp/`
    // has the 4.0 shot, which is the one that proves it is radial — the middle
    // of the frame is clean and the corners are split.
    color = asColorNode(
      chromaticAberration(
        color,
        float(options.aberration),
        vec2(0.5, 0.5),
        float(ABERRATION_SCALE),
      ),
    );
  }

  const pipeline = new RenderPipeline(renderer, color);
  // The chain already did tone mapping and the sRGB encode.
  pipeline.outputColorTransform = false;

  // The override has to restate the normal as well as the mask: `MRTNode.merge`
  // replaces a whole named output, it does not merge inside one.
  const aoMaskNode = mrt({ [G_BUFFER]: vec4(normalView, 1) });
  const marked = new WeakSet<Material>();
  let markedCount = 0;
  let warnedUnmarked = false;

  /*
   * Lava's override has to restate the AO outputs as well, for the same reason
   * the comment above gives: `MRTNode.merge` replaces a whole named output. A
   * lava surface IS a world surface, so it wants the AO mask set too, and
   * writing only the lava output would silently take it out of SSAO.
   */
  const lavaMrtNode = mrt(
    useSsao
      ? {
          [G_BUFFER]: vec4(normalView, options.ssao === 'all' ? 0 : 1),
          [LAVA_BUFFER]: vec4(1, 1, 1, 1),
        }
      : { [LAVA_BUFFER]: vec4(1, 1, 1, 1) },
  );
  const markedLava = new WeakSet<Material>();

  const markLava = (objects: Iterable<Object3D>): number => {
    if (!useLava) {
      return 0;
    }
    let n = 0;
    const visit = (child: Object3D): void => {
      const withMaterial = child as { material?: Material | Material[] };
      const m = withMaterial.material;
      if (!m) {
        return;
      }
      for (const material of Array.isArray(m) ? m : [m]) {
        if (markedLava.has(material)) {
          continue;
        }
        const withMrt = material as Material & { mrtNode?: unknown };
        withMrt.mrtNode = lavaMrtNode;
        material.needsUpdate = true;
        markedLava.add(material);
        n++;
      }
    };
    // A LIST, not a subtree root. Lava batches by shader like everything else
    // and is scattered through the world object; reparenting it under a holder
    // so this could `traverse` would change draw order for a classification
    // that has nothing to do with draw order.
    for (const object of objects) {
      object.traverse(visit);
    }
    return n;
  };

  const markAoWorld = (object: Object3D): number => {
    if (!useSsao || options.ssao === 'all') {
      return 0;
    }
    let n = 0;
    object.traverse((child) => {
      const withMaterial = child as { material?: Material | Material[] };
      const m = withMaterial.material;
      if (!m) {
        return;
      }
      for (const material of Array.isArray(m) ? m : [m]) {
        if (marked.has(material) || !canCarryAoMask(material)) {
          continue;
        }
        const withMrt = material as Material & { mrtNode?: unknown };
        withMrt.mrtNode = aoMaskNode;
        material.needsUpdate = true;
        marked.add(material);
        n++;
      }
    });
    markedCount += n;
    return n;
  };

  return {
    options,
    render: () => {
      if (useSsao && options.ssao === 'world' && markedCount === 0 && !warnedUnmarked) {
        warnedUnmarked = true;
        console.warn(
          '[overbounce] SSAO is enabled but nothing is marked as world geometry, ' +
            'so it will have no visible effect. Call ' +
            'renderer.post.markAoWorld(<world surfaces group>) once after the map ' +
            'is built, or use ?ssao=all to ignore the mask, or ?ssao=off.',
        );
      }
      pipeline.render();
    },
    markAoWorld,
    markLava,
    dispose: () => {
      pipeline.dispose();
      scenePass.dispose();
    },
  };
}

/**
 * Install the faithful colour mapping and report anything the URL asked for
 * that the rest of the configuration makes impossible.
 *
 * Split out from `createPostChain` because it has to happen even when the chain
 * is disabled: `mapoverbright` is baked into the lightmap bytes at map load, so
 * it works with `?post=off` while `gamma` and `overbright` do not.
 */
export function applyPostColorMapping(options: PostOptions): void {
  const installed = setColorMapping(options.colorMapping);
  if (!options.enabled && !gammaRampIsIdentity(installed)) {
    console.warn(
      '[overbounce] ?gamma / ?overbright need the post-processing layer, and ' +
        '?post=off turned it off. The lightmap half (?mapoverbright) still applies.',
    );
  }
}
