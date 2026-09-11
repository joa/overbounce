/**
 * The Huffman coder and the bit reader.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * These are the two layers where a bug is invisible: a wrong Huffman tree or a
 * misread bit width does not throw, it silently produces different numbers.
 * Everything above them inherits that, so this is where it gets caught.
 */

import { describe, it, expect } from 'vitest';
import { MsgReader, MsgWriter, MSG_HDATA, intBitsToFloat, floatBitsToInt } from '../../src/demo/msg.js';
import { Huffman } from '../../src/demo/huffman.js';
import {
  DemoPlayerState,
  EntityState,
  readDeltaEntity,
  readDeltaPlayerState,
  writeDeltaEntity,
  writeDeltaPlayerState,
} from '../../src/demo/state.js';
import { ENTITY_FIELDS, PLAYER_FIELDS, ES, PS } from '../../src/demo/netfields.js';

describe('msg_hData', () => {
  it('has 256 entries', () => {
    expect(MSG_HDATA).toHaveLength(256);
  });

  it('matches the checksum of id\'s table', () => {
    // The sum is a cheap whole-table fingerprint: any single altered entry
    // moves it, and it is stable across formatting. 1053340 is the sum of
    // `msg_hData[256]` as shipped.
    expect(MSG_HDATA.reduce((a, b) => a + b, 0)).toBe(1053340);
    expect(MSG_HDATA[0]).toBe(250315);
    expect(MSG_HDATA[255]).toBe(13504);
  });

  it('builds a tree in which every symbol is reachable', () => {
    // `Huff_offsetTransmit` writes nothing at all for a symbol that has no
    // `loc` entry, which would make that byte silently unencodable. Seeding
    // from the frequency table is what guarantees all 256 have one.
    const huff = new Huffman();
    huff.seed(MSG_HDATA);
    const out = new Uint8Array(4096);
    for (let ch = 0; ch < 256; ch++) {
      const cursor = { bloc: 0 };
      huff.compressor.offsetTransmit(ch, out, cursor);
      expect(cursor.bloc, `symbol ${ch} encoded to zero bits`).toBeGreaterThan(0);
    }
  });
});

describe('MsgReader / MsgWriter', () => {
  it('round-trips bit widths 1..32', () => {
    const w = new MsgWriter();
    const values: { value: number; bits: number }[] = [];
    for (let bits = 1; bits <= 32; bits++) {
      // A value that fills the width without overflowing it. Built with an
      // unsigned shift rather than `(1 << bits) - 1`, which goes negative at
      // 31 because JS's `<<` is a signed 32-bit operation.
      const value = 0xffffffff >>> (32 - bits);
      values.push({ value, bits });
      w.writeBits(value | 0, bits);
    }
    const r = new MsgReader(w.bytes());
    r.bitstream();
    for (const { value, bits } of values) {
      const got = r.readBits(bits) >>> 0;
      expect(got, `${bits} bits`).toBe(value);
    }
  });

  it('round-trips bytes, shorts, longs and strings', () => {
    const w = new MsgWriter();
    w.writeByte(200);
    w.writeShort(-12345);
    w.writeLong(1234567890);
    w.writeString('mapname\\coldrun');
    w.writeString('');
    const r = new MsgReader(w.bytes());
    r.bitstream();
    expect(r.readByte()).toBe(200);
    expect(r.readShort()).toBe(-12345);
    expect(r.readLong()).toBe(1234567890);
    expect(r.readString()).toBe('mapname\\coldrun');
    expect(r.readString()).toBe('');
  });

  it('substitutes % and high ASCII in strings, as id does', () => {
    const w = new MsgWriter();
    w.writeString('100%');
    const r = new MsgReader(w.bytes());
    r.bitstream();
    // Not cosmetic: it is what keeps a hostile server's string out of a
    // format specifier.
    expect(r.readString()).toBe('100.');
  });

  it('reinterprets float bits both ways', () => {
    for (const f of [0, 1, -1, 0.5, 1234.5678, -8256.25]) {
      expect(intBitsToFloat(floatBitsToInt(f))).toBe(Math.fround(f));
    }
  });
});

describe('delta entity', () => {
  function roundTrip(from: EntityState, to: EntityState): EntityState {
    const w = new MsgWriter();
    writeDeltaEntity(w, from, to, true);
    const r = new MsgReader(w.bytes());
    r.bitstream();
    const number = r.readBits(10);
    const out = new EntityState();
    const removed = readDeltaEntity(r, from, out, number);
    expect(removed).toBe(false);
    return out;
  }

  it('round-trips every field', () => {
    const from = new EntityState();
    const to = new EntityState();
    to.number = 42;
    // Fill every net field with a distinct value that survives its own
    // encoding: integers get something inside their bit width, floats get a
    // non-integral value so they take the full-float branch.
    for (let i = 0; i < ENTITY_FIELDS.length; i++) {
      const field = ENTITY_FIELDS[i];
      if (field.bits === 0) {
        to.floats[field.slot] = i + 0.25;
      } else {
        const width = Math.abs(field.bits);
        to.words[field.slot] = (i + 1) % (width >= 31 ? 0x7fffffff : 1 << width);
      }
    }
    const out = roundTrip(from, to);
    expect(out.number).toBe(42);
    for (const field of ENTITY_FIELDS) {
      expect(out.words[field.slot], field.name).toBe(to.words[field.slot]);
    }
  });

  it('takes the integral-float path for whole numbers and the full path otherwise', () => {
    const from = new EntityState();
    const to = new EntityState();
    to.number = 3;
    to.floats[ES.origin_0] = 128; // integral, inside the 13-bit biased range
    to.floats[ES.origin_1] = 128.5; // needs all 32 bits
    to.floats[ES.origin_2] = 0; // the zero case
    const out = roundTrip(from, to);
    expect(out.origin).toEqual([128, 128.5, 0]);
  });

  it('carries unchanged fields forward', () => {
    const from = new EntityState();
    from.number = 7;
    from.words[ES.eType] = 3;
    from.floats[ES.origin_0] = 999.5;
    const to = from.clone();
    to.words[ES.legsAnim] = 12;
    const out = roundTrip(from, to);
    expect(out.words[ES.eType]).toBe(3);
    expect(out.floats[ES.origin_0]).toBe(999.5);
    expect(out.words[ES.legsAnim]).toBe(12);
  });

  it('signals a removal', () => {
    const from = new EntityState();
    from.number = 9;
    const w = new MsgWriter();
    writeDeltaEntity(w, from, null, false);
    const r = new MsgReader(w.bytes());
    r.bitstream();
    const number = r.readBits(10);
    expect(number).toBe(9);
    const out = new EntityState();
    expect(readDeltaEntity(r, from, out, number)).toBe(true);
  });
});

describe('delta playerstate', () => {
  function roundTrip(from: DemoPlayerState | null, to: DemoPlayerState): DemoPlayerState {
    const w = new MsgWriter();
    writeDeltaPlayerState(w, from, to);
    const r = new MsgReader(w.bytes());
    r.bitstream();
    const out = new DemoPlayerState();
    readDeltaPlayerState(r, from, out);
    return out;
  }

  it('round-trips every field from a null base', () => {
    const to = new DemoPlayerState();
    for (let i = 0; i < PLAYER_FIELDS.length; i++) {
      const field = PLAYER_FIELDS[i];
      if (field.bits === 0) {
        to.floats[field.slot] = i + 0.5;
      } else {
        // Positive and inside the width: the wire form is unsigned for
        // positive widths, and `viewheight` (-8) and friends are signed but
        // still fine with a small positive value.
        const width = Math.abs(field.bits);
        to.words[field.slot] = (i + 1) % (1 << Math.min(width, 20));
      }
    }
    const out = roundTrip(null, to);
    for (const field of PLAYER_FIELDS) {
      expect(out.words[field.slot], field.name).toBe(to.words[field.slot]);
    }
  });

  it('round-trips the stats/persistant/ammo/powerups arrays', () => {
    const from = new DemoPlayerState();
    const to = new DemoPlayerState();
    to.stats[0] = 117;
    to.stats[3] = 85;
    to.persistant[1] = 4;
    to.ammo[5] = 7;
    // Powerups are absolute expiry times, sent as LONGs -- a value past
    // 16 bits is exactly what a short would silently truncate.
    to.powerups[2] = 1234567;
    const out = roundTrip(from, to);
    expect(Array.from(out.stats)).toEqual(Array.from(to.stats));
    expect(Array.from(out.persistant)).toEqual(Array.from(to.persistant));
    expect(Array.from(out.ammo)).toEqual(Array.from(to.ammo));
    expect(Array.from(out.powerups)).toEqual(Array.from(to.powerups));
  });

  it('has NO zero case for floats, unlike the entity coder', () => {
    // The two readers differ here and conflating them decodes into plausible
    // nonsense. A zero float in a playerstate goes down the integral path
    // (13 bits of biased zero), not down a one-bit zero flag.
    const from = new DemoPlayerState();
    from.floats[PS.origin_0] = 512;
    const to = from.clone();
    to.floats[PS.origin_0] = 0;
    const out = roundTrip(from, to);
    expect(out.floats[PS.origin_0]).toBe(0);
  });
});
