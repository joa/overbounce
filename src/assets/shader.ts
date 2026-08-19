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
  /** Where this stage's RGB comes from. Defaults to `identity`, i.e. white. */
  rgbGen: ColorGen;
  /** Where this stage's alpha comes from. */
  alphaGen: AlphaGen;
  /** `rgbGen wave ...`, which is how Quake pulses a light or a warning strip. */
  rgbWave: Wave | null;
  /**
   * `alphaGen portal <range>`, hoisted to `Shader.portalRange` by the caller.
   *
   * Lives on the stage only because that is where the token appears; id writes
   * it straight onto the shader from inside `ParseStage`.
   */
  portalRange?: number;
  /** `alphaGen wave ...`. */
  alphaWave: Wave | null;
  /** `rgbGen const` / `alphaGen const`, as 0..1 RGBA. */
  constantColor: [number, number, number, number];
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

/**
 * `colorGen_t` — where a stage's RGB comes from.
 *
 * Quake does not simply sample the texture: every stage says how its colour is
 * generated, and the texture is then modulated by that. `identity` is white, so
 * most stages look like a plain sample; the rest are not decoration.
 * `lightingDiffuse` is how a MODEL is lit, and `vertex` is how a lot of maps
 * tint decals and terrain blends.
 */
export type ColorGen =
  | 'identity'
  | 'identityLighting'
  | 'entity'
  | 'oneMinusEntity'
  | 'vertex'
  | 'exactVertex'
  | 'oneMinusVertex'
  | 'lightingDiffuse'
  | 'wave'
  | 'const';

/** `alphaGen_t`. Same idea for the alpha channel. */
export type AlphaGen =
  | 'identity'
  | 'entity'
  | 'oneMinusEntity'
  | 'vertex'
  | 'oneMinusVertex'
  | 'lightingSpecular'
  | 'wave'
  | 'const'
  | 'portal';

/**
 * `fogParms ( r g b ) <depthForOpaque>`.
 *
 * Declares the shader's brushes to be a fog VOLUME: everything seen through
 * them is tinted toward `color`, reaching full opacity at `depthForOpaque`
 * units of travel. Note this is separate from whatever stages the shader also
 * draws -- a fog brush commonly has both, and the stages are ordinary surfaces.
 */
export interface FogParms {
  /** 0..1 per channel. */
  color: [number, number, number];
  /** Distance through the fog at which it is fully opaque, in units. */
  depthForOpaque: number;
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
  /** `fogParms`, when this shader declares a fog volume. */
  fogParms: FogParms | null;
  /**
   * `shaderSort_t`, 0 (`SS_BAD`) when the shader does not set one.
   *
   * Quake draws in sort order rather than by distance, and the value also gates
   * fog: `GeneratePermanentShader` gives `FP_EQUAL` only to `sort <= SS_OPAQUE`.
   * A decal is `SS_DECAL`, which is past that, so scorch marks do not get fogged
   * on top of the wall they are already sitting on.
   */
  sort: number;
  /** `polygonOffset` — pull the surface toward the viewer to stop z-fighting. */
  polygonOffset: boolean;
  /**
   * `alphaGen portal <range>` — how far the portal fades over, in Q3 units.
   *
   * A SHADER field even though the keyword appears inside a stage, because
   * that is where id put it: `ParseStage` writes `shader.portalRange`. Defaults
   * to 256 when the keyword is given with no argument, which id warns about.
   *
   * `RB_CalcAlphaFromEntity`'s `AGEN_PORTAL` case reads it as
   * `alpha = clamp(|vertex - viewOrigin| / portalRange, 0, 1)`, which is the
   * reverse of the obvious guess: the stage is OPAQUE far away and TRANSPARENT
   * up close. On `textures/sfx/portal_sfx` that stage is the fog layer, so
   * walking up to a portal is what reveals the view through it.
   */
  portalRange: number;
  /**
   * `q3map_surfaceLight <value>` — this surface EMITS light.
   *
   * A compiler directive rather than a renderer one: q3map2 turns every
   * surface carrying it into an area light and bakes the result into the
   * lightmap, and `tr_shader.c` never reads it, which is why every other
   * `q3map_` key here is skipped as a keyword and this one used to be too.
   *
   * It is kept because it is the only honest answer to "which of these
   * surfaces is a lamp": the alpha-mapped light panels and the flame textures
   * declare it, and the maps in rotation carry 854 declarations between them.
   * Null when the shader does not emit.
   */
  surfaceLight: number | null;
}

/**
 * `shaderSort_t`, tr_local.h:112.
 *
 * Note `SS_BLEND6`: the NAME says 6 but the enum has no BLEND4 or BLEND5, so
 * its value is 13. Taking the name at face value would put it three places too
 * far back.
 */
export const SS_BAD = 0;
export const SS_PORTAL = 1;
export const SS_ENVIRONMENT = 2;
export const SS_OPAQUE = 3;
export const SS_DECAL = 4;
export const SS_SEE_THROUGH = 5;
export const SS_BANNER = 6;
export const SS_FOG = 7;
export const SS_UNDERWATER = 8;
export const SS_BLEND0 = 9;
export const SS_BLEND1 = 10;
export const SS_NEAREST = 16;

/** `ParseSort`'s names. Anything else is read as a bare number. */
const SORT_NAMES = new Map<string, number>([
  ['portal', SS_PORTAL],
  ['sky', SS_ENVIRONMENT],
  ['opaque', SS_OPAQUE],
  ['decal', SS_DECAL],
  ['seethrough', SS_SEE_THROUGH],
  ['banner', SS_BANNER],
  ['additive', SS_BLEND1],
  ['nearest', SS_NEAREST],
  ['underwater', SS_UNDERWATER],
]);

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

/**
 * `ParseVector`: `( a b c )`. The tokenizer keeps the parens as separate
 * tokens, so they are skipped rather than parsed.
 */
function parseVector(args: readonly string[], from: number): [number, number, number] {
  const nums: number[] = [];
  for (let i = from; i < args.length && nums.length < 3; i++) {
    if (args[i] === '(' || args[i] === ')') {
      continue;
    }
    const v = Number.parseFloat(args[i]);
    if (Number.isFinite(v)) {
      nums.push(v);
    }
  }
  return [nums[0] ?? 1, nums[1] ?? 1, nums[2] ?? 1];
}

/**
 * Directives whose first argument must be taken even if it looks like a keyword.
 *
 * Argument collection normally stops at the next known keyword, because the
 * tokenizer has lost newlines and that is the only way to find a line end. That
 * breaks when a directive's own parameter shares a name with a keyword -- and
 * one does: `alphaGen portal`, where `portal` is also a shader-level directive.
 * Read the parameter greedily and `alphaGen` silently stayed `identity`.
 *
 * Quake reads a fixed arity per keyword and has no such ambiguity; this is the
 * price of a tokenizer that does not track lines.
 */
const NEEDS_ARGUMENT = new Set([
  'rgbgen',
  'alphagen',
  'tcgen',
  'tcmod',
  'alphafunc',
  'surfaceparm',
  'cull',
  'deformvertexes',
  'qer_editorimage',
  'fogparms',
  'skyparms',
  'sort',
]);

/** `rgbGen` keywords -- exactly the set `ParseStage` accepts. */
const COLOR_GEN = new Map<string, ColorGen>([
  ['identity', 'identity'],
  ['identitylighting', 'identityLighting'],
  ['entity', 'entity'],
  ['oneminusentity', 'oneMinusEntity'],
  ['vertex', 'vertex'],
  ['exactvertex', 'exactVertex'],
  ['oneminusvertex', 'oneMinusVertex'],
  ['lightingdiffuse', 'lightingDiffuse'],
  ['wave', 'wave'],
  ['const', 'const'],
]);

/** `alphaGen` keywords. Note there is no `identityLighting` among them. */
const ALPHA_GEN = new Map<string, AlphaGen>([
  ['identity', 'identity'],
  ['entity', 'entity'],
  ['oneminusentity', 'oneMinusEntity'],
  ['vertex', 'vertex'],
  ['oneminusvertex', 'oneMinusVertex'],
  ['lightingspecular', 'lightingSpecular'],
  ['wave', 'wave'],
  ['const', 'const'],
  ['portal', 'portal'],
]);

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
    rgbGen: 'identity',
    alphaGen: 'identity',
    rgbWave: null,
    alphaWave: null,
    constantColor: [1, 1, 1, 1],
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
      if (NEEDS_ARGUMENT.has(key) && at.i < tokens.length && tokens[at.i] !== '}') {
        args.push(tokens[at.i++]);
      }
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
      } else if (key === 'rgbgen') {
        const gen = COLOR_GEN.get((args[0] ?? '').toLowerCase());
        if (gen) {
          stage.rgbGen = gen;
          if (gen === 'wave') {
            stage.rgbWave = parseWave(args, 1);
          } else if (gen === 'const') {
            const [r, g, b] = parseVector(args, 1);
            stage.constantColor = [r, g, b, stage.constantColor[3]];
          } else if (gen === 'vertex' && stage.alphaGen === 'identity') {
            // `if ( stage->alphaGen == 0 ) stage->alphaGen = AGEN_VERTEX;`
            // -- rgbGen vertex drags alphaGen along unless one was set already.
            stage.alphaGen = 'vertex';
          }
        }
      } else if (key === 'alphagen') {
        const gen = ALPHA_GEN.get((args[0] ?? '').toLowerCase());
        if (gen) {
          stage.alphaGen = gen;
          if (gen === 'wave') {
            stage.alphaWave = parseWave(args, 1);
          } else if (gen === 'const') {
            const a = Number.parseFloat(args[1] ?? '');
            stage.constantColor[3] = Number.isFinite(a) ? a : 1;
          } else if (gen === 'portal') {
            /*
             * `alphaGen portal <range>`. id parses the argument here and
             * writes `shader.portalRange` -- a SHADER field set from inside a
             * stage, which is why it is carried on the stage and hoisted by
             * the caller.
             *
             * A missing argument is 256 with a warning in id's parser; the
             * default is the same here without the noise.
             */
            const range = Number.parseFloat(args[1] ?? '');
            stage.portalRange = Number.isFinite(range) && range > 0 ? range : 256;
          }
        }
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
      surfaceLight: null,
      portalRange: 256,
      twoSided: false,
      lightmapped: true,
      deformed: false,
      deforms: [],
      sky: null,
      fogParms: null,
      sort: SS_BAD,
      polygonOffset: false,
    };

    while (at.i < tokens.length) {
      const token = tokens[at.i++];
      if (token === '}') {
        break;
      }
      if (token === '{') {
        const stage = parseStage(tokens, at);
        shader.stages.push(stage);
        // `ParseStage` writes `shader.portalRange` directly; the stage carries
        // it up here because this parser hands stages back rather than mutating
        // the shader in place.
        if (stage.portalRange !== undefined) {
          shader.portalRange = stage.portalRange;
        }
        continue;
      }

      const key = token.toLowerCase();
      const args: string[] = [];
      if (
        NEEDS_ARGUMENT.has(key) &&
        at.i < tokens.length &&
        !'{}'.includes(tokens[at.i])
      ) {
        args.push(tokens[at.i++]);
      }
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
      } else if (key === 'sort') {
        const name = (args[0] ?? '').toLowerCase();
        const named = SORT_NAMES.get(name);
        if (named !== undefined) {
          shader.sort = named;
        } else {
          // `shader.sort = atof( token );` -- a bare number is legal and maps
          // shipped by hand-tuners do use it.
          const n = Number.parseFloat(args[0] ?? '');
          shader.sort = Number.isFinite(n) ? n : SS_BAD;
        }
      } else if (key === 'polygonoffset') {
        shader.polygonOffset = true;
      } else if (key === 'portal') {
        /*
         * The bare `portal` directive (tr_shader.c:1542), which is how a
         * surface says "render another view through me".
         *
         * It was being SKIPPED. `portal` is in the keyword table, so the
         * parser treated it as a directive to step over and never set the
         * sort -- which meant no surface in any map was ever marked as a
         * portal, and a scan for `SS_PORTAL` across q3dm7 came back empty even
         * though `textures/sfx/portal_sfx` declares it on its third line.
         */
        shader.sort = SS_PORTAL;
      } else if (key === 'q3map_surfacelight') {
        // The one `q3map_` directive this renderer keeps. See the field.
        const n = Number.parseFloat(args[0] ?? '');
        shader.surfaceLight = Number.isFinite(n) && n > 0 ? n : null;
      } else if (key === 'fogparms') {
        // `fogParms ( r g b ) <depthForOpaque>`, then "skip any old gradient
        // directions" -- older shaders carry trailing tokens that mean nothing.
        const [r, g, b] = parseVector(args, 0);
        const depth = Number.parseFloat(args[args.length - 1] ?? '');
        shader.fogParms = {
          color: [r, g, b],
          depthForOpaque: Number.isFinite(depth) && depth > 0 ? depth : 1,
        };
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

    // `FinishShader`, tr_shader.c:2134 -- a polygon-offset surface defaults to
    // SS_DECAL, but only if the shader did not already ask for a sort. That
    // ordering is what keeps a decal out of the fog pass: the fog gate is
    // `sort <= SS_OPAQUE`, and SS_DECAL is past it, so a scorch mark is not
    // fogged on top of the wall it is already lying on.
    if (shader.polygonOffset && !shader.sort) {
      shader.sort = SS_DECAL;
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
/**
 * The key a shader is stored and looked up under.
 *
 * `R_FindShader` runs `COM_StripExtension` on the name before searching, and
 * the difference is not academic: MD3 surfaces name their shader as a texture
 * file, sometimes in capitals -- `models/powerups/health/yellow_sphere.TGA`
 * for a shader declared as `models/powerups/health/yellow_sphere`. Matching
 * literally misses, the model falls back to a plain image lookup, that misses
 * too, and the item renders as a grey blob.
 */
export function shaderKey(name: string): string {
  return name.toLowerCase().replace(/\.(tga|jpg|jpeg|png|pcx|bmp)$/, '');
}

export function isAlphaBlendedStage(stage: ShaderStage): boolean {
  const [src, dst] = stage.blend;
  return (
    (src === 'gl_src_alpha' && dst === 'gl_one_minus_src_alpha') || src === 'blend'
  );
}

/**
 * How a stage combines with the passes drawn before it, within one shader.
 *
 * This is `RB_StageIteratorGeneric` reduced to the four cases Quake's own
 * content actually uses. It is deliberately TOTAL: every stage gets an answer,
 * so a compositor written against it cannot silently drop a pass. Selecting
 * "the diffuse plus the additive ones" instead is how the ammo boxes lost
 * their colour -- `blendfunc blend` is neither, so the pass carrying the
 * model's actual texture was never drawn.
 *
 * `replace` covers both `GL_ONE GL_ZERO` and a stage with no blendfunc, which
 * are the same thing.
 */
export type StageBlendOp = 'replace' | 'add' | 'multiply' | 'blend';

export function stageBlendOp(stage: ShaderStage): StageBlendOp {
  if (isAdditiveStage(stage)) {
    return 'add';
  }
  if (isFilterStage(stage)) {
    return 'multiply';
  }
  if (isAlphaBlendedStage(stage)) {
    return 'blend';
  }
  return 'replace';
}

/**
 * The stage whose blendfunc decides how the SURFACE meets the scene.
 *
 * It is the FIRST stage, and it is not the same thing as the diffuse stage.
 * `tr_shader.c` decides a shader's sort and opacity from stage 0's state bits;
 * every later stage blends against what this shader has already drawn, inside
 * the surface, not against the framebuffer behind it.
 *
 * Quake's ordinary lightmapped surface is written lightmap-FIRST:
 *
 *     textures/base_floor/clangdark
 *     {
 *       { map $lightmap  rgbGen identity }
 *       { map textures/base_floor/clangdark.tga
 *         blendFunc GL_DST_COLOR GL_ZERO      <- multiplies onto the lightmap
 *         rgbGen identity }
 *     }
 *
 * That `GL_DST_COLOR GL_ZERO` is a MULTIPASS instruction. Read it as a claim
 * about the surface and you conclude that a solid metal floor is translucent,
 * stop writing depth for it, and the lamps in the room below start showing
 * through the floor. `shaderDiffuse` picks the texture stage -- stage 1 here --
 * so it is exactly the wrong stage to ask.
 */
export function shaderBlendBase(shader: Shader): ShaderStage | null {
  return shader.stages[0] ?? null;
}

/**
 * True if a stage's blendfunc MULTIPLIES what is already there.
 *
 * `blendfunc filter` and its longhand `GL_DST_COLOR GL_ZERO` are how Quake
 * darkens: decals, grime, and the shadow patches under architecture. Drawn as
 * an opaque base they cover the wall they were meant to stain, which is a
 * grey-brown rectangle where a smudge should be.
 */
export function isFilterStage(stage: ShaderStage): boolean {
  const [src, dst] = stage.blend;
  return (
    src === 'filter' ||
    (src === 'gl_dst_color' && dst === 'gl_zero') ||
    (src === 'gl_zero' && dst === 'gl_src_color')
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
 * True if a stage BRIGHTENS what is behind it: `blendfunc GL_DST_COLOR GL_ONE`.
 *
 *     dst * src + dst * 1  =  dst * (1 + src)
 *
 * Neither an add nor a multiply, and reading it as either is what rendered
 * every body of water in the game as a black blob. Quake's water shaders are
 * built entirely out of this one blendfunc:
 *
 *     textures/liquids/clear_calm1              (q3ctf2's pools)
 *     {
 *       surfaceparm water
 *       { map pool3d_5e.tga  blendFunc GL_dst_color GL_one  tcmod scroll ... }
 *       { map pool3d_3e.tga  blendFunc GL_dst_color GL_one  tcmod scroll ... }
 *       { map $lightmap      blendFunc GL_dst_color GL_zero }
 *     }
 *
 * Every stage multiplies the FRAMEBUFFER, so the pool floor showing through is
 * not transparency the shader asks for -- it is the only thing the shader ever
 * draws. `isModulateStage` used to answer `multiply` here, which computes
 * `dst * src`: two dark blue water textures multiplied together and then by a
 * lightmap, drawn opaque because stage 0 matched no blend class at all.
 *
 * 63 stages across pak0 use it, 30 of them in `liquid.shader`.
 */
export function isBrightenStage(stage: ShaderStage): boolean {
  const [src, dst] = stage.blend;
  return src === 'gl_dst_color' && dst === 'gl_one';
}

/**
 * True if a SURFACE only ever modulates what is already on screen.
 *
 * Stage 0 decides, for the reason `shaderBlendBase` gives at length. Both
 * multiplying forms qualify: `GL_DST_COLOR GL_ZERO` (a decal, a grime patch)
 * and `GL_DST_COLOR GL_ONE` (water). Such a surface has no colour of its own --
 * it is a function applied to the pixels behind it -- so it draws with
 * `applyFilterBlend` and must not be lit, because what it multiplies is
 * already lit.
 */
export function isModulatedSurface(shader: Shader): boolean {
  const base = shaderBlendBase(shader);
  return base !== null && (isFilterStage(base) || isBrightenStage(base));
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

/**
 * True if a stage's blendfunc MULTIPLIES, counting the forms `isFilterStage`
 * does not recognise.
 *
 * Quake's framebuffer has no destination alpha, so `GL_ONE_MINUS_DST_ALPHA`
 * evaluates to zero and `blendFunc GL_DST_COLOR GL_ONE_MINUS_DST_ALPHA`
 * degenerates to the same `dst * src` as plain `filter`. That spelling is how
 * `pewter_shiney` and `diamond2c_ow` apply their lightmap, so a rule that only
 * matched `GL_DST_COLOR GL_ZERO` would drop the lightmap on exactly those.
 * `GL_DST_COLOR GL_SRC_ALPHA` (`steed1gf`) is not literally a multiply, but its
 * `dst * srcAlpha` term is small and treating it as one is what we already did.
 *
 * `isFilterStage` stays as it is: it decides how a SURFACE meets the scene, and
 * widening it would reclassify surfaces rather than stages.
 */
export function isModulateStage(stage: ShaderStage): boolean {
  return isFilterStage(stage) || stage.blend[0] === 'gl_dst_color';
}

/**
 * `stageBlendOp` plus the one answer a WORLD surface needs and a model does
 * not: `skip`.
 *
 * `stageBlendOp` is total by design and answers `replace` for a blendfunc it
 * does not recognise. On a model that is the safe direction -- the thing being
 * replaced is another pass of the same model. On a world surface the thing
 * underneath is very often the lightmap, and replacing it throws the surface's
 * lighting away, so an unrecognised blend is better left out than guessed at.
 */
export type StageOp = StageBlendOp | 'skip' | 'brighten';

export interface StageComposite {
  stage: ShaderStage;
  op: StageOp;
}

/** `stageBlendOp`, but unrecognised blendfuncs answer `skip`. */
export function stageOp(stage: ShaderStage): StageOp {
  const [src, dst] = stage.blend;
  // No blendfunc at all and `GL_ONE GL_ZERO` are the same thing, and both
  // genuinely do discard what is under them.
  if (src === undefined || (src === 'gl_one' && dst === 'gl_zero')) {
    return 'replace';
  }
  const op = stageBlendOp(stage);
  if (op !== 'replace') {
    return op;
  }
  // Before `isModulateStage`, which would answer `multiply` and lose the `1 +`.
  if (isBrightenStage(stage)) {
    return 'brighten';
  }
  return isModulateStage(stage) ? 'multiply' : 'skip';
}

/**
 * A shader's stages in draw order, each tagged with how it combines.
 *
 * This is the difference between "which image is the surface" and "what the
 * surface looks like". A second `GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA` stage is
 * NOT a claim that the surface is translucent -- it is a MASK, laid over what
 * this shader has already drawn, and its alpha channel is the mask:
 *
 *     textures/base_floor/diamond2c_ow            (q3dm17, under the weapons)
 *     {
 *       { map textures/sfx/proto_zzztblu2.tga     <- energy, fills the tile
 *         blendFunc GL_ONE GL_ZERO }
 *       { map textures/base_floor/diamond2c_ow.tga
 *         blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA }   <- the grate ON TOP
 *       { map $lightmap
 *         blendFunc GL_DST_COLOR GL_ONE_MINUS_DST_ALPHA }
 *     }
 *
 * Take the first stage and stop, and the floor is a bare sheet of scrolling
 * plasma: the plate that is supposed to cover it, letting the glow through only
 * where its alpha is low, is never drawn at all.
 *
 * The first drawable stage is always the base, whatever its blendfunc says --
 * how the surface meets the SCENE is `shaderBlendBase`'s question, not this
 * one. Stages with no image of any kind are dropped, as `ParseShader` does.
 */
export function shaderComposition(shader: Shader): StageComposite[] {
  const out: StageComposite[] = [];
  /*
   * A PORTAL's first stage does not replace, it blends.
   *
   * Everywhere else the first drawable stage owns the pixel, because there is
   * nothing underneath it. A portal surface is the exception: by the time Quake
   * runs its stages the framebuffer already holds the view rendered through it,
   * and every stage composites OVER that. `portal_sfx`'s first stage is the
   * ring, `GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA` -- treat it as a replace and
   * the ring's transparent middle becomes opaque black and the view is gone.
   */
  const portal = shader.sort === SS_PORTAL;
  for (const stage of shader.stages) {
    const drawable =
      stage.isLightmap || stage.isWhite || stage.map !== null || stage.animFrames.length > 0;
    if (!drawable) {
      continue;
    }
    const op = stageOp(stage);
    /*
     * A `brighten` first stage keeps its own op rather than being forced to
     * `replace`. `GL_DST_COLOR GL_ONE` multiplies the FRAMEBUFFER, so there IS
     * something underneath it -- the same exception the portal above needs, for
     * the same reason. Forcing `replace` here is what turned water opaque.
     *
     * A `filter` first stage still replaces, and that is not an inconsistency:
     * its factor is `src` alone, so starting from an identity destination and
     * starting from the texture are the same expression.
     */
    const first = out.length === 0 && !portal;
    out.push({ stage, op: first && op !== 'brighten' ? 'replace' : op });
  }
  return out;
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
