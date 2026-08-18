/**
 * Shader animation: tcMod and rgbGen wave, in TSL.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `assets/shader.ts` resolves *which* texture a surface uses. This moves it.
 * Without it lava sits still, teleporters do not shimmer, warning strips do not
 * pulse and the cloud sky is a photograph — every surface Quake animates is
 * frozen, which reads as a slightly dead version of the map rather than as a
 * missing feature.
 *
 * Ported from `tr_shade_calc.c`. Quake evaluates these on the CPU per vertex
 * and rewrites the texture coordinates; here they are node expressions
 * evaluated per fragment, which is the same maths in a different place.
 *
 * The one thing to keep straight is that Quake's waves run on a **normalised
 * 0..1 cycle**, not radians:
 *
 *     WAVEVALUE = base + table[(phase + time * frequency) * FUNCTABLE_SIZE]
 *                        * amplitude
 *
 * so a `sin` wave is `sin(2 * PI * x)` where `x = phase + time * frequency`.
 * Feeding radians straight in gives a wave that is 2*PI too slow, which looks
 * plausible and is wrong.
 */

import { float, normalLocal, positionLocal, sin, uniform, uv, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Deform, TcMod, Wave } from '../assets/shader.js';

/** The shader clock, in seconds. One uniform shared by every animated material. */
export class ShaderClock {
  readonly node: Node<'float'>;
  private readonly value = { value: 0 };

  constructor() {
    this.node = uniform(0);
  }

  set(seconds: number): void {
    // `uniform()` returns a node whose `.value` is the live binding.
    (this.node as unknown as { value: number }).value = seconds;
    this.value.value = seconds;
  }

  get seconds(): number {
    return this.value.value;
  }
}

const TWO_PI = Math.PI * 2;

/**
 * `EvalWaveForm` — one wave sample at the current time.
 *
 * Only `sin` is exact. Quake builds lookup tables for triangle, square and the
 * sawtooths; those are reconstructed from `fract` here, which matches their
 * shape but not their 1024-entry quantisation. Nothing in a Quake map depends
 * on that quantisation, and `noise` falls back to sin rather than pretending.
 */
export function waveNode(wave: Wave, time: Node<'float'>): Node<'float'> {
  // x is the position within the cycle, 0..1.
  const x = time.mul(wave.frequency).add(wave.phase);
  const f = x.fract();

  let shape: Node<'float'>;
  switch (wave.func) {
    case 'square':
      // +1 for the first half of the cycle, -1 for the second.
      shape = f.lessThan(0.5).select(float(1), float(-1));
      break;
    case 'triangle':
      // Rises 0->1 over the first half, falls back over the second.
      shape = f.lessThan(0.5).select(f.mul(2), f.oneMinus().mul(2));
      break;
    case 'sawtooth':
      shape = f;
      break;
    case 'inversesawtooth':
      shape = f.oneMinus();
      break;
    case 'sin':
    case 'noise':
    default:
      // The normalised cycle again: sin over 0..1, not over 0..2*PI.
      shape = sin(x.mul(TWO_PI));
      break;
  }

  return shape.mul(wave.amplitude).add(wave.base);
}

/**
 * Apply a stage's tcMods to a UV, in order.
 *
 * Order matters and is not commutative: `tcMod scale 3 2` then
 * `tcMod scroll 0.15 0.15` scrolls in the scaled space, which is three times
 * faster horizontally than scrolling first would be.
 */
export function applyTcMods(
  uvNode: Node<'vec2'>,
  mods: readonly TcMod[],
  time: Node<'float'>,
): Node<'vec2'> {
  let uv = uvNode;

  for (const mod of mods) {
    switch (mod.type) {
      case 'scroll':
        // RB_CalcScrollTexCoords. Quake also takes the fractional part to keep
        // the number small for fixed-point hardware; float32 UVs do not need
        // that, and omitting it avoids a visible jump when it wraps.
        uv = vec2(uv.x.add(time.mul(mod.s)), uv.y.add(time.mul(mod.t)));
        break;

      case 'scale':
        uv = vec2(uv.x.mul(mod.s), uv.y.mul(mod.t));
        break;

      case 'turb': {
        // RB_CalcTurbulentTexCoords. The displacement is driven by POSITION,
        // not by the UV: that is what makes lava churn in world space instead
        // of sliding with the texture. x + z drives s, y drives t, both scaled
        // by 1/128 * 0.125.
        const now = time.mul(mod.wave.frequency).add(mod.wave.phase);
        const scale = (1 / 128) * 0.125;
        const sPhase = positionLocal.x.add(positionLocal.z).mul(scale).add(now);
        const tPhase = positionLocal.y.mul(scale).add(now);
        uv = vec2(
          uv.x.add(sin(sPhase.mul(TWO_PI)).mul(mod.wave.amplitude)),
          uv.y.add(sin(tPhase.mul(TWO_PI)).mul(mod.wave.amplitude)),
        );
        break;
      }

      case 'rotate': {
        // RB_CalcRotateTexCoords, which rotates about the UV centre (0.5, 0.5).
        const degs = time.mul(-mod.degreesPerSecond);
        const rad = degs.mul(Math.PI / 180);
        const c = rad.cos();
        const s = rad.sin();
        const cx = uv.x.sub(0.5);
        const cy = uv.y.sub(0.5);
        uv = vec2(
          cx.mul(c).sub(cy.mul(s)).add(0.5),
          cx.mul(s).add(cy.mul(c)).add(0.5),
        );
        break;
      }

      case 'stretch': {
        // RB_CalcStretchTexCoords: scale about the centre by 1/wave.
        const w = waveNode(mod.wave, time);
        const inv = float(1).div(w.abs().max(0.0001));
        uv = vec2(
          uv.x.sub(0.5).mul(inv).add(0.5),
          uv.y.sub(0.5).mul(inv).add(0.5),
        );
        break;
      }

      case 'transform':
        uv = vec2(
          uv.x.mul(mod.m[0]).add(uv.y.mul(mod.m[2])).add(mod.t[0]),
          uv.x.mul(mod.m[1]).add(uv.y.mul(mod.m[3])).add(mod.t[1]),
        );
        break;
    }
  }

  return uv;
}

/**
 * `RB_DeformTessGeometry` — move the geometry itself.
 *
 * Quake deforms on the CPU, rewriting `tess.xyz` before the draw; this is the
 * same maths as a vertex-stage node expression.
 *
 * Implemented: `wave`, `move`, `bulge`. These are the ones that make lava
 * heave, banners ripple and surfaces pulse, and they are all pure functions of
 * position, normal and time.
 *
 * NOT implemented, deliberately: `autosprite` and `autosprite2` rebuild the
 * triangles every frame so a quad faces the viewer, which is a geometry
 * operation rather than a vertex displacement and cannot be expressed as one.
 * `projectionShadow` and `text` need render state this project does not have.
 * A shader carrying one of those keeps its undeformed geometry, which is what
 * it did before this existed.
 */
export function deformNode(
  deforms: readonly Deform[],
  time: Node<'float'>,
): Node<'vec3'> | null {
  let position: Node<'vec3'> = positionLocal;
  let deformed = false;

  for (const deform of deforms) {
    switch (deform.type) {
      case 'wave': {
        // RB_CalcDeformVertexes. The spread term is what makes the wave travel
        // ALONG the surface instead of pulsing it uniformly: the phase is
        // offset by (x + y + z) * spread, so neighbouring vertices are at
        // different points in the cycle.
        const w = deform.wave;
        const scale =
          w.frequency === 0
            ? waveNode(w, time)
            : waveNode(
                { ...w, phase: 0 },
                // Fold the positional offset into the time term: WAVEVALUE
                // adds `phase + off` and multiplies time by frequency, so the
                // equivalent is time + (phase + off) / frequency.
                time.add(
                  positionLocal.x
                    .add(positionLocal.y)
                    .add(positionLocal.z)
                    .mul(deform.spread)
                    .add(w.phase)
                    .div(w.frequency),
                ),
              );
        position = position.add(normalLocal.mul(scale));
        deformed = true;
        break;
      }

      case 'move': {
        // RB_CalcMoveVertexes: one wave, the whole surface slides along it.
        const scale = waveNode(deform.wave, time);
        position = position.add(
          vec3(deform.vector[0], deform.vector[1], deform.vector[2]).mul(scale),
        );
        deformed = true;
        break;
      }

      case 'bulge': {
        // RB_CalcBulgeVertexes. Driven by the S texture coordinate, and note
        // `now = time * speed * 0.001` -- the speed is in milliseconds where
        // everything else here is in seconds.
        const now = time.mul(deform.speed);
        // The C indexes sinTable by (FUNCTABLE_SIZE / 2PI) * (s * width + now),
        // i.e. it treats the argument as radians rather than as a 0..1 cycle.
        const arg = uv().x.mul(deform.width).add(now);
        position = position.add(normalLocal.mul(sin(arg).mul(deform.height)));
        deformed = true;
        break;
      }

      // normal perturbs normals, not positions; the rest cannot be expressed
      // as a vertex displacement. See the note above.
      default:
        break;
    }
  }

  return deformed ? position : null;
}

/** True if any deform can actually be applied. */
export function hasDeform(deforms: readonly Deform[]): boolean {
  return deforms.some(
    (d) => d.type === 'wave' || d.type === 'move' || d.type === 'bulge',
  );
}

/** True if a stage has anything time-varying about it. */
export function isAnimated(mods: readonly TcMod[], rgbWave: Wave | null): boolean {
  if (rgbWave) {
    return true;
  }
  return mods.some(
    (m) =>
      m.type === 'scroll' ||
      m.type === 'turb' ||
      m.type === 'rotate' ||
      m.type === 'stretch',
  );
}
