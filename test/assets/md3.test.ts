/**
 * MD3 model parsing.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Like the BSP tests, structural checks run against synthetic data that this
 * file writes, and LAYOUT is validated separately against real models. A writer
 * and a parser built from the same struct definitions agree with each other
 * even when both are wrong; only third-party files settle it.
 *
 * Those models come from OpenArena (GPLv2), and they are reproducible:
 *
 *   npm run download-assets     # -> assets/md3/
 *   npm run test:assets
 *
 * MD3_MODELS overrides the directory if you want to point at your own.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  MD3_IDENT,

  MD3_XYZ_SCALE,
  decodeNormal,
  findTag,
  lerpSurfaceFrames,
  parseMd3,
} from '../../src/assets/md3.js';

describe('MD3 header validation', () => {
  it('rejects a file that is not an MD3', () => {
    const buf = new ArrayBuffer(256);
    new DataView(buf).setInt32(0, 0x12345678, true);
    expect(() => parseMd3(buf)).toThrow(/not an MD3 model/);
  });

  it('rejects an unsupported version', () => {
    const buf = new ArrayBuffer(256);
    const v = new DataView(buf);
    v.setInt32(0, MD3_IDENT, true);
    v.setInt32(4, 14, true);
    expect(() => parseMd3(buf)).toThrow(/unsupported MD3 version 14/);
  });

  it('rejects a truncated file', () => {
    expect(() => parseMd3(new ArrayBuffer(16))).toThrow(/too short/);
  });
});

describe('packed normal decoding', () => {
  it('decodes straight up as +Z', () => {
    // lat 0, lng 0: x = cos(0)*sin(0) = 0, y = 0, z = cos(0) = 1
    const n = decodeNormal(0);
    expect(n[0]).toBeCloseTo(0, 6);
    expect(n[1]).toBeCloseTo(0, 6);
    expect(n[2]).toBeCloseTo(1, 6);
  });

  it('decodes lng = a quarter turn as horizontal', () => {
    // lng = 64 of 256 is pi/2, so z = cos(pi/2) = 0 and the normal is flat.
    const n = decodeNormal(64);
    expect(n[2]).toBeCloseTo(0, 6);
    expect(Math.hypot(n[0], n[1])).toBeCloseTo(1, 6);
  });

  it('always produces unit vectors', () => {
    for (let lat = 0; lat < 256; lat += 17) {
      for (let lng = 0; lng < 256; lng += 13) {
        const n = decodeNormal((lat << 8) | lng);
        expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
      }
    }
  });
});

describe('fixed point scale', () => {
  it('is 1/64, six fractional bits', () => {
    expect(MD3_XYZ_SCALE).toBe(1 / 64);
    // A short therefore reaches +/-512 units, which is why large models are
    // split into several surfaces.
    expect(32767 * MD3_XYZ_SCALE).toBeCloseTo(511.98, 2);
  });
});

// ---------------------------------------------------------------------------
// Real models
// ---------------------------------------------------------------------------

// `npm run download-assets` unpacks OpenArena's MD3s here. MD3_MODELS wins if
// set, so a local Quake III install can still be pointed at instead.
const DEFAULT_MODEL_DIR = 'assets/md3';
const modelDir = process.env.MD3_MODELS ?? DEFAULT_MODEL_DIR;
const files = existsSync(modelDir)
  ? readdirSync(modelDir).filter((f) => f.toLowerCase().endsWith('.md3'))
  : [];

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe.skipIf(files.length === 0)(
  `real MD3 models (${files.length ? modelDir : 'none — run: npm run download-assets'})`,
  () => {
    for (const file of files) {
      describe(file, () => {
        const model = parseMd3(toArrayBuffer(readFileSync(join(modelDir, file))));

        it('parses a well-formed header', () => {
          expect(model.frames.length).toBeGreaterThan(0);
          expect(model.surfaces.length).toBeGreaterThan(0);

          // NOT asserted: a non-empty `name`. This test used to require one,
          // which held for id's models and is false for OpenArena's — every
          // one of theirs leaves the 64-byte name field blank. Nothing reads
          // it (surfaces and tags carry their own names), so an empty string
          // is a valid parse, not a broken one. Exactly the assumption this
          // block exists to catch: a writer and a parser built from the same
          // structs agreed with each other, and only third-party files
          // settled it.
          expect(typeof model.name).toBe('string');
        });

        it('has consistent surface geometry', () => {
          for (const s of model.surfaces) {
            expect(s.numVerts).toBeGreaterThan(0);
            expect(s.indices.length % 3).toBe(0);
            expect(s.indices.length).toBeGreaterThan(0);

            // Every index must address a real vertex. A wrong struct size
            // almost always shows up here first.
            for (const idx of s.indices) {
              expect(idx).toBeLessThan(s.numVerts);
            }

            expect(s.st.length).toBe(s.numVerts * 2);
            expect(s.xyz.length).toBe(s.numVerts * s.numFrames * 3);
            expect(s.normals.length).toBe(s.xyz.length);
            // Surfaces share the model's frame count.
            expect(s.numFrames).toBe(model.frames.length);
          }
        });

        it('has unit normals throughout', () => {
          for (const s of model.surfaces) {
            for (let i = 0; i < s.numVerts; i++) {
              const o = i * 3;
              const len = Math.hypot(s.normals[o], s.normals[o + 1], s.normals[o + 2]);
              expect(len).toBeCloseTo(1, 4);
            }
          }
        });

        it('keeps vertices inside the bounds the frame declares', () => {
          const frame = model.frames[0];
          for (const s of model.surfaces) {
            for (let i = 0; i < s.numVerts; i++) {
              const o = i * 3;
              for (let k = 0; k < 3; k++) {
                // A little slack: the frame bounds are the model's, and are
                // stored as floats rather than derived from the fixed point.
                expect(s.xyz[o + k]).toBeGreaterThanOrEqual(frame.mins[k] - 1);
                expect(s.xyz[o + k]).toBeLessThanOrEqual(frame.maxs[k] + 1);
              }
            }
          }
        });

        it('names a shader for every surface', () => {
          for (const s of model.surfaces) {
            expect(s.shaders.length).toBeGreaterThan(0);
            expect(s.shaders[0].length).toBeGreaterThan(0);
          }
        });

        it('stores one set of tags per frame', () => {
          expect(model.tags.length).toBe(model.frames.length * model.numTags);
        });

        it('interpolates between frames without leaving the model', () => {
          const s = model.surfaces[0];
          const out = new Float32Array(s.numVerts * 3);
          const outN = new Float32Array(s.numVerts * 3);
          const last = Math.min(1, s.numFrames - 1);

          lerpSurfaceFrames(s, 0, last, 0.5, out, outN);

          for (let i = 0; i < out.length; i++) {
            expect(Number.isFinite(out[i])).toBe(true);
          }
          for (let i = 0; i < s.numVerts; i++) {
            const o = i * 3;
            expect(Math.hypot(outN[o], outN[o + 1], outN[o + 2])).toBeCloseTo(1, 4);
          }

          // t=0 must reproduce frame 0 exactly.
          lerpSurfaceFrames(s, 0, last, 0, out);
          for (let i = 0; i < out.length; i++) {
            expect(out[i]).toBe(s.xyz[i]);
          }
        });

        it('returns null for a tag it does not have', () => {
          expect(findTag(model, 0, 'tag_definitely_not_here')).toBeNull();
        });
      });
    }
  },
);
