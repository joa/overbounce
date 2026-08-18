/**
 * Quake III `.shader` scripts.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A surface in a BSP names a *shader*, not a texture. Most of the time a file
 * of the same name exists and the distinction does not matter — which is why
 * direct lookup got 77 of q3dm6's 85 shaders. The other 8 exist only here:
 * light strips, scrolling effects, lava. Without this they render with no
 * diffuse at all, which is the pale washed-out surfaces in the map.
 *
 * Structure follows `tr_shader.c` (`ParseShader` / `ParseStage`), but this is
 * deliberately a *resolver*, not a renderer. Quake composites a shader as
 * several blended passes with animated texture coordinates and wave-driven
 * colour; reproducing that is a project in itself. What this extracts is:
 *
 *   - which image to use as the diffuse
 *   - whether the surface is lightmapped
 *   - whether to draw both sides
 *   - whether it glows (an additive pass on top)
 *
 * That is enough to make a map look like the map. The animation is not.
 */

/**
 * A `waveForm_t`: `<func> <base> <amplitude> <phase> <frequency>`.
 *
 * `WAVEVALUE` in tr_shade_calc.c is
 * `base + table[(phase + time * frequency) * FUNCTABLE_SIZE] * amplitude`,
 * i.e. the wave is evaluated on a normalised 0..1 cycle rather than in radians.
 */
export interface Wave {
  func: WaveFunc;
  base: number;
  amplitude: number;
  phase: number;
  frequency: number;
}

export type WaveFunc =
  | 'sin'
  | 'triangle'
  | 'square'
  | 'sawtooth'
  | 'inversesawtooth'
  | 'noise';

/**
 * A `deformVertexes`. Quake moves the geometry itself, not just its texture.
 *
 * `wave` is what makes lava heave and banners ripple; `move` slides a whole
 * surface back and forth; `bulge` is the pulsing used on a few organic
 * surfaces. `autosprite` rebuilds geometry to face the viewer every frame and
 * is not represented here — see the note in render/shader-anim.ts.
 */
export type Deform =
  | { type: 'wave'; spread: number; wave: Wave }
  | { type: 'move'; vector: [number, number, number]; wave: Wave }
  | { type: 'bulge'; width: number; height: number; speed: number }
  | { type: 'normal'; wave: Wave }
  | { type: 'autosprite' }
  | { type: 'autosprite2' }
  | { type: 'projectionShadow' }
  | { type: 'text' };

/** A `tcMod`. Applied in the order they appear, which is why this is a list. */
export type TcMod =
  | { type: 'scroll'; s: number; t: number }
  | { type: 'scale'; s: number; t: number }
  | { type: 'turb'; wave: Wave }
  | { type: 'rotate'; degreesPerSecond: number }
  | { type: 'stretch'; wave: Wave }
  | { type: 'transform'; m: [number, number, number, number]; t: [number, number] };

/** One `{ ... }` pass inside a shader. */
export interface ShaderStage {
  /** The `map` / `clampmap` argument, or the first frame of an `animMap`. */
  map: string | null;
  /** `map $lightmap` — this pass IS the lightmap. */
  isLightmap: boolean;
  /** `map $whiteimage`. */
  isWhite: boolean;
  /**
   * The stage used `clampmap` rather than `map`.
   *
   * Not cosmetic. A `clampmap` combined with a `tcMod` that pushes the
   * coordinates outside 0..1 -- `stretch`, `scroll`, `rotate` -- must clamp to
   * the edge, or the sprite tiles instead of staying put. The bounce pad arrow
   * is exactly this: `clampmap jumppadsmall.tga` with `tcMod stretch`, which
   * repeats into a grid of arrows across the whole pad if the clamp is lost.
   */
  clamp: boolean;
  /** Lowercased `blendfunc` arguments, if any. */
  blend: string[];
  /** `tcMod`s in source order — they compose, so the order is meaningful. */
  tcMods: TcMod[];
  /** `animMap` frames, in order. Empty unless the stage is an animMap. */
  animFrames: string[];
  /** `animMap`'s first argument, in frames per second. */
  animFps: number;
  /**
   * `tcGen environment` — Quake's fake reflection.
   *
   * NOT a real reflection and not screen-space: the texture coordinate comes
   * from reflecting the view vector about the vertex normal and looking the
   * result up in a spheremap (`textures/effects/envmap*.tga`), which is a flat
   * painting of a shiny environment. It costs two instructions and reflects
   * things that are not on screen, which is exactly why Quake used it.
   *
   * Some models have nothing else: the Quad's shader is a single envmap stage
   * with its base texture commented out, so without this it has no correct
   * appearance at all.
   */
  envMap: boolean;
  /**
   * `alphaFunc GT0 | LT128 | GE128`, lowercased.
   *
   * This is what makes a grate a grate. Without it every grate, chain, banner
   * and fence in a Quake map renders as a solid opaque rectangle -- the black
   * panels that look like missing geometry.
   */
  alphaFunc: string | null;
  /** `rgbGen wave ...`, which is how Quake pulses a light or a warning strip. */
  rgbWave: Wave | null;
  /** Every remaining `key value...` line, lowercased key. */
  directives: Map<string, string[]>;
}

const WAVE_FUNCS: readonly string[] = [
  'sin',
  'triangle',
  'square',
  'sawtooth',
  'inversesawtooth',
  'noise',
];

function num(v: string | undefined, fallback = 0): number {
  const parsed = Number.parseFloat(v ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `<func> <base> <amplitude> <phase> <frequency>`. */
function parseWave(args: readonly string[], from: number): Wave {
  const raw = (args[from] ?? 'sin').toLowerCase();
  return {
    func: (WAVE_FUNCS.includes(raw) ? raw : 'sin') as WaveFunc,
    base: num(args[from + 1]),
    amplitude: num(args[from + 2]),
    phase: num(args[from + 3]),
    frequency: num(args[from + 4]),
  };
}

/** `ParseDeform` in tr_shader.c. */
function parseDeform(args: readonly string[]): Deform | null {
  const kind = (args[0] ?? '').toLowerCase();

  if (kind.startsWith('text')) {
    return { type: 'text' };
  }

  switch (kind) {
    case 'wave': {
      // `deformVertexes wave <div> <func> <base> <amp> <phase> <freq>`.
      // Note the C stores 1/div and substitutes 100 when div is 0, because the
      // value is used as a multiplier on the vertex position.
      const div = num(args[1]);
      return {
        type: 'wave',
        spread: div === 0 ? 100 : 1 / div,
        wave: parseWave(args, 2),
      };
    }
    case 'move':
      return {
        type: 'move',
        vector: [num(args[1]), num(args[2]), num(args[3])],
        wave: parseWave(args, 4),
      };
    case 'bulge':
      return {
        type: 'bulge',
        width: num(args[1]),
        height: num(args[2]),
        speed: num(args[3]),
      };
    case 'normal':
      // `deformVertexes normal <div> <func?> <base> <amp> <phase> <freq>` --
      // this perturbs normals, not positions, so nothing here uses it.
      return { type: 'normal', wave: parseWave(args, 1) };
    case 'autosprite':
      return { type: 'autosprite' };
    case 'autosprite2':
      return { type: 'autosprite2' };
    case 'projectionshadow':
      return { type: 'projectionShadow' };
    default:
      return null;
  }
}

function parseTcMod(args: readonly string[]): TcMod | null {
  switch ((args[0] ?? '').toLowerCase()) {
    case 'scroll':
      return { type: 'scroll', s: num(args[1]), t: num(args[2]) };
    case 'scale':
      // Note scale defaults to 1, not 0: a zero scale collapses the texture.
      return { type: 'scale', s: num(args[1], 1), t: num(args[2], 1) };
    case 'turb':
      // `tcMod turb <base> <amp> <phase> <freq>` — no func, it is always sin.
      return {
        type: 'turb',
        wave: {
          func: 'sin',
          base: num(args[1]),
          amplitude: num(args[2]),
          phase: num(args[3]),
          frequency: num(args[4]),
        },
      };
    case 'rotate':
      return { type: 'rotate', degreesPerSecond: num(args[1]) };
    case 'stretch':
      return { type: 'stretch', wave: parseWave(args, 1) };
    case 'transform':
      return {
        type: 'transform',
        m: [num(args[1], 1), num(args[2]), num(args[3]), num(args[4], 1)],
        t: [num(args[5]), num(args[6])],
      };
    default:
      return null;
  }
}

export interface Shader {
  name: string;
  stages: ShaderStage[];
  /** `qer_editorimage` — what the level editor shows. A good last resort. */
  editorImage: string | null;
  /** Every `surfaceparm`, lowercased. */
  surfaceparms: Set<string>;
  /** `cull none` / `cull twosided` / `cull disable`. */
  twoSided: boolean;
  /** True if any stage is a lightmap pass, or `surfaceparm nolightmap` is absent. */
  lightmapped: boolean;
  /** True if the shader has any `deformVertexes`. */
  deformed: boolean;
  /** The deforms themselves, in source order. */
  deforms: Deform[];
  /** `skyParms <outerbox> <cloudheight> <innerbox>`. */
  sky: SkyParms | null;
}

export interface SkyParms {
  /**
   * The outer box basename, e.g. `env/killsky`. The six sides are that plus
   * `_rt _bk _lf _ft _up _dn` — `ParseSkyParms` in tr_shader.c. `-` in the
   * script means "no box", and becomes null here.
   */
  outerBox: string | null;
  cloudHeight: number;
  innerBox: string | null;
}

/** The suffix order `ParseSkyParms` uses, verbatim. */
export const SKY_SUFFIXES = ['rt', 'bk', 'lf', 'ft', 'up', 'dn'] as const;

/**
 * Tokenize a shader script.
 *
 * Quake's `COM_ParseExt` treats braces as their own tokens and strips `//`
 * comments; `/* *\/` blocks appear in a few shipped files too.
 */
function tokenize(text: string): string[] {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.split('//')[0])
    .join('\n');

  const tokens: string[] = [];
  const re = /[{}]|[^\s{}]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

function parseStage(tokens: string[], at: { i: number }): ShaderStage {
  const stage: ShaderStage = {
    map: null,
    isLightmap: false,
    isWhite: false,
    clamp: false,
    blend: [],
    tcMods: [],
    animFrames: [],
    animFps: 0,
    envMap: false,
    alphaFunc: null,
    rgbWave: null,
    directives: new Map(),
  };

  while (at.i < tokens.length) {
    const token = tokens[at.i++];
    if (token === '}') {
      break;
    }

    const key = token.toLowerCase();
    // Collect the rest of this logical line. The tokenizer has lost newlines,
    // so a directive runs until the next token that starts a new one -- in
    // practice, until a brace or a known keyword. Reading a fixed arity per
    // keyword is what Quake does and is unambiguous.
    if (key === 'map' || key === 'clampmap') {
      if (key === 'clampmap') {
        stage.clamp = true;
      }
      const arg = tokens[at.i++] ?? '';
      const lower = arg.toLowerCase();
      if (lower === '$lightmap') {
        stage.isLightmap = true;
      } else if (lower === '$whiteimage') {
        stage.isWhite = true;
      } else {
        stage.map = arg;
      }
    } else if (key === 'animmap') {
      // animMap <fps> <image> <image> ...
      const fps = Number.parseFloat(tokens[at.i++] ?? '');
      const frames: string[] = [];
      while (at.i < tokens.length && !isKeyword(tokens[at.i]) && tokens[at.i] !== '}') {
        frames.push(tokens[at.i++]);
      }
      stage.animFps = Number.isFinite(fps) && fps > 0 ? fps : 1;
      stage.animFrames = frames;
      // `map` stays the first frame so anything that only wants a
      // representative image keeps working.
      if (frames.length && !stage.map) {
        stage.map = frames[0];
      }
      stage.directives.set('animmap', frames);
    } else if (key === 'blendfunc') {
      const args: string[] = [];
      while (at.i < tokens.length && !isKeyword(tokens[at.i]) && tokens[at.i] !== '}') {
        args.push(tokens[at.i++].toLowerCase());
      }
      stage.blend = args;
    } else {
      const args: string[] = [];
      while (at.i < tokens.length && !isKeyword(tokens[at.i]) && tokens[at.i] !== '}') {
        args.push(tokens[at.i++]);
      }

      if (key === 'alphafunc') {
        stage.alphaFunc = (args[0] ?? '').toLowerCase();
      } else if (key === 'tcgen' && (args[0] ?? '').toLowerCase() === 'environment') {
        stage.envMap = true;
      } else if (key === 'tcmod') {
        // A stage may carry several, and they compose in order, so these
        // accumulate instead of overwriting like the other directives.
        const mod = parseTcMod(args);
        if (mod) {
          stage.tcMods.push(mod);
        }
      } else if (key === 'rgbgen' && (args[0] ?? '').toLowerCase() === 'wave') {
        stage.rgbWave = parseWave(args, 1);
      }

      stage.directives.set(key, args);
    }
  }

  return stage;
}

/** Keywords that begin a directive, so argument runs know where to stop. */
const KEYWORDS = new Set([
  'map',
  'clampmap',
  'animmap',
  'videomap',
  'blendfunc',
  'rgbgen',
  'alphagen',
  'tcgen',
  'tcmod',
  'depthfunc',
  'depthwrite',
  'detail',
  'alphafunc',
  'surfaceparm',
  'cull',
  'deformvertexes',
  'nomipmaps',
  'nopicmip',
  'polygonoffset',
  'portal',
  'sort',
  'fogparms',
  'light',
  'skyparms',
  'qer_editorimage',
  'qer_trans',
  'qer_nocarve',
]);

function isKeyword(token: string): boolean {
  const lower = token.toLowerCase();
  return KEYWORDS.has(lower) || lower.startsWith('q3map_');
}

/** Parse one `.shader` file into its shaders, keyed by lowercased name. */
export function parseShaderFile(text: string): Map<string, Shader> {
  const out = new Map<string, Shader>();
  const tokens = tokenize(text);
  const at = { i: 0 };

  while (at.i < tokens.length) {
    const name = tokens[at.i++];
    if (name === '{' || name === '}') {
      continue; // stray brace; skip rather than abandoning the file
    }
    if (tokens[at.i] !== '{') {
      continue; // not a shader definition
    }
    at.i++; // consume '{'

    const shader: Shader = {
      name,
      stages: [],
      editorImage: null,
      surfaceparms: new Set(),
      twoSided: false,
      lightmapped: true,
      deformed: false,
      deforms: [],
      sky: null,
    };

    while (at.i < tokens.length) {
      const token = tokens[at.i++];
      if (token === '}') {
        break;
      }
      if (token === '{') {
        shader.stages.push(parseStage(tokens, at));
        continue;
      }

      const key = token.toLowerCase();
      const args: string[] = [];
      while (at.i < tokens.length && !isKeyword(tokens[at.i]) && !'{}'.includes(tokens[at.i])) {
        args.push(tokens[at.i++]);
      }

      if (key === 'qer_editorimage') {
        shader.editorImage = args[0] ?? null;
      } else if (key === 'surfaceparm') {
        const parm = (args[0] ?? '').toLowerCase();
        shader.surfaceparms.add(parm);
        if (parm === 'nolightmap') {
          shader.lightmapped = false;
        }
      } else if (key === 'cull') {
        const mode = (args[0] ?? '').toLowerCase();
        shader.twoSided = mode === 'none' || mode === 'twosided' || mode === 'disable';
      } else if (key === 'deformvertexes') {
        shader.deformed = true;
        const deform = parseDeform(args);
        if (deform) {
          shader.deforms.push(deform);
        }
      } else if (key === 'skyparms') {
        const dash = (v: string | undefined): string | null =>
          !v || v === '-' ? null : v;
        const height = Number.parseFloat(args[1] ?? '');
        shader.sky = {
          outerBox: dash(args[0]),
          // ParseSkyParms defaults a missing or zero cloudheight to 512.
          cloudHeight: Number.isFinite(height) && height !== 0 ? height : 512,
          innerBox: dash(args[2]),
        };
      }
    }

    out.set(name.toLowerCase(), shader);
  }

  return out;
}

/**
 * The image to draw a shader with.
 *
 * In order: the first stage naming a real texture, then the editor image.
 * Quake would composite every stage; this picks the one that carries the
 * surface's identity, which for the light and liquid shaders that motivated
 * this is the `GL_DST_COLOR GL_ZERO` pass sitting after the lightmap.
 *
 * Returns null for a shader that genuinely has no texture — a pure `$lightmap`
 * or a sky — and null is a real answer there, not a failure.
 */
export function shaderDiffuse(shader: Shader): string | null {
  for (const stage of shader.stages) {
    if (stage.map) {
      return stage.map;
    }
  }
  return shader.editorImage;
}

/**
 * The alpha test a stage applies, as `{ threshold, keepAbove }`.
 *
 * `NameToAFunc` in tr_shader.c: GT0 keeps alpha > 0, GE128 keeps alpha >= 128,
 * LT128 keeps alpha < 128. 128/255 is 0.502, not 0.5 -- a small difference that
 * matters on the one-pixel border of a grate.
 */
export function alphaTestOf(
  stage: ShaderStage,
): { threshold: number; keepAbove: boolean } | null {
  switch (stage.alphaFunc) {
    case 'gt0':
      return { threshold: 0, keepAbove: true };
    case 'ge128':
      return { threshold: 128 / 255, keepAbove: true };
    case 'lt128':
      return { threshold: 128 / 255, keepAbove: false };
    default:
      return null;
  }
}

/** True if a stage blends with the framebuffer using its own alpha. */
export function isAlphaBlendedStage(stage: ShaderStage): boolean {
  const [src, dst] = stage.blend;
  return (
    (src === 'gl_src_alpha' && dst === 'gl_one_minus_src_alpha') || src === 'blend'
  );
}

/** True if a stage's blendfunc adds to what is already there. */
export function isAdditiveStage(stage: ShaderStage): boolean {
  const [src, dst] = stage.blend;
  return (
    (src === 'gl_one' && dst === 'gl_one') ||
    src === 'add' ||
    (src === 'gl_src_alpha' && dst === 'gl_one')
  );
}

/**
 * Every additive pass layered on top of the diffuse, in source order.
 *
 * This is where nearly all of a Quake map's motion lives, and missing it is
 * why the bounce pads and pulsing wall trim sat still. The animation is almost
 * never on the diffuse stage: `textures/sfx/bounce_largeblock3b` carries its
 * base texture on stage 0 and its pulse on stages 2 and 3, and
 * `textures/sfx/border11c` puts the scrolling glow on stage 3.
 *
 * Returned as stages rather than names because each one has its own tcMods and
 * its own rgbGen wave, and those are the whole point.
 */
export function shaderGlowStages(shader: Shader): ShaderStage[] {
  const diffuse = shaderDiffuse(shader);
  return shader.stages.filter(
    (stage) =>
      (stage.map !== null || stage.animFrames.length > 0) &&
      stage.map !== diffuse &&
      isAdditiveStage(stage),
  );
}

/** The first additive pass, by name. Kept for callers that only want an image. */
export function shaderGlow(shader: Shader): string | null {
  return shaderGlowStages(shader)[0]?.map ?? null;
}

/** The six side images of a sky box, in `SKY_SUFFIXES` order. */
export function skyBoxImages(sky: SkyParms): string[] | null {
  if (!sky.outerBox) {
    return null;
  }
  return SKY_SUFFIXES.map((suffix) => `${sky.outerBox}_${suffix}`);
}

/** Every shader in a set of `.shader` files, later files winning. */
export function mergeShaderFiles(texts: readonly string[]): Map<string, Shader> {
  const all = new Map<string, Shader>();
  for (const text of texts) {
    for (const [name, shader] of parseShaderFile(text)) {
      all.set(name, shader);
    }
  }
  return all;
}
