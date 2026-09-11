/**
 * Quake III's network message bit reader and writer.
 * Ported from Quake III Arena's code/qcommon/msg.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Bit-level IO over a Huffman-coded byte buffer (`huffman.ts`), plus the delta
 * readers for `entityState_t` and `playerState_t`. This is the whole of what a
 * `.dm_68` demo is made of below the message layer.
 *
 * ## Only the reading half is load-bearing
 *
 * `MsgWriter` exists so the tests can build a synthetic demo, which is how
 * `dm68.ts` is checked without committing a demo file (`demos/` is
 * gitignored). It carries the same caveat `test/collision`'s BSP writer does
 * and CLAUDE.md spells out: a round-trip through a writer built from the same
 * understanding as the reader proves traversal, never on-disk truth. The real
 * check is `OB_DEMO=<file> npm test`.
 *
 * ## Three ported quirks, none of them safe to tidy
 *
 * 1. **`readBits` sign-extends against the wrong width.** id subtracts the
 *    sub-byte remainder from `bits` before the `1 << (bits - 1)` sign check at
 *    the bottom, so a signed read of a width that is not a multiple of 8 would
 *    extend from the wrong bit. Every signed read the protocol actually makes
 *    is 8, 16 or 32 wide, so it never fires -- but the shape is kept, because
 *    a "fixed" version would decode a hypothetical stream differently from
 *    every real Quake client.
 * 2. **The playerState float path has no zero case.** `entityState`'s float
 *    reader has three branches (zero / integral / full float);
 *    `playerState`'s has two (integral / full float), and its integer fields
 *    have no zero bit at all. They look like the same function and are not.
 *    See `state.ts`, which is where both live.
 * 3. **`readcount` lands one byte past the bit cursor** -- `readcount =
 *    (bit >> 3) + 1`. Overflow checks compare against it, so they are
 *    deliberately a byte loose. Kept, because `readString` uses `readByte`'s
 *    `-1` return as its terminator and that is where the looseness shows.
 *
 * The `usercmd_t` delta readers (`MSG_ReadDeltaUsercmd`,
 * `MSG_ReadDeltaUsercmdKey`) are NOT ported: they decode client-to-server
 * messages, and a demo holds only the server-to-client direction. Their
 * absence is a scope decision, not an oversight.
 */

import { Huffman, huffGetBit, huffOffsetReceive, huffPutBit } from './huffman.js';
import type { BitCursor } from './huffman.js';

/** `FLOAT_INT_BITS` -- an integral float in this many bits, or 32 raw. */
export const FLOAT_INT_BITS = 13;

/** `FLOAT_INT_BIAS` -- `1 << (FLOAT_INT_BITS - 1)`, so the small-int range
 *  covers equal parts positive and negative. */
export const FLOAT_INT_BIAS = 1 << (FLOAT_INT_BITS - 1);

/** `GENTITYNUM_BITS`. */
export const GENTITYNUM_BITS = 10;

/** `MAX_GENTITIES`. */
export const MAX_GENTITIES = 1 << GENTITYNUM_BITS;

/** `MAX_MSGLEN`. */
export const MAX_MSGLEN = 16384;

/** `MAX_STRING_CHARS`. */
export const MAX_STRING_CHARS = 1024;

/** `BIG_INFO_STRING`. */
export const BIG_INFO_STRING = 8192;

/**
 * `msg_hData[256]` -- the symbol frequencies both Huffman trees are built
 * from, and the reason a Quake demo can be decoded at all without the tree
 * being transmitted.
 *
 * Transcribed mechanically out of `msg.c` rather than typed: a single wrong
 * entry reorders the tree and corrupts every byte after the first, with no
 * error anywhere to say so.
 */
export const MSG_HDATA: readonly number[] = [
  250315, 41193, 6292, 7106, 3730, 3750, 6110, 23283,
  33317, 6950, 7838, 9714, 9257, 17259, 3949, 1778,
  8288, 1604, 1590, 1663, 1100, 1213, 1238, 1134,
  1749, 1059, 1246, 1149, 1273, 4486, 2805, 3472,
  21819, 1159, 1670, 1066, 1043, 1012, 1053, 1070,
  1726, 888, 1180, 850, 960, 780, 1752, 3296,
  10630, 4514, 5881, 2685, 4650, 3837, 2093, 1867,
  2584, 1949, 1972, 940, 1134, 1788, 1670, 1206,
  5719, 6128, 7222, 6654, 3710, 3795, 1492, 1524,
  2215, 1140, 1355, 971, 2180, 1248, 1328, 1195,
  1770, 1078, 1264, 1266, 1168, 965, 1155, 1186,
  1347, 1228, 1529, 1600, 2617, 2048, 2546, 3275,
  2410, 3585, 2504, 2800, 2675, 6146, 3663, 2840,
  14253, 3164, 2221, 1687, 3208, 2739, 3512, 4796,
  4091, 3515, 5288, 4016, 7937, 6031, 5360, 3924,
  4892, 3743, 4566, 4807, 5852, 6400, 6225, 8291,
  23243, 7838, 7073, 8935, 5437, 4483, 3641, 5256,
  5312, 5328, 5370, 3492, 2458, 1694, 1821, 2121,
  1916, 1149, 1516, 1367, 1236, 1029, 1258, 1104,
  1245, 1006, 1149, 1025, 1241, 952, 1287, 997,
  1713, 1009, 1187, 879, 1099, 929, 1078, 951,
  1656, 930, 1153, 1030, 1262, 1062, 1214, 1060,
  1621, 930, 1106, 912, 1034, 892, 1158, 990,
  1175, 850, 1121, 903, 1087, 920, 1144, 1056,
  3462, 2240, 4397, 12136, 7758, 1345, 1307, 3278,
  1950, 886, 1023, 1112, 1077, 1042, 1061, 1071,
  1484, 1001, 1096, 915, 1052, 995, 1070, 876,
  1111, 851, 1059, 805, 1112, 923, 1103, 817,
  1899, 1872, 976, 841, 1127, 956, 1159, 950,
  7791, 954, 1289, 933, 1127, 3207, 1020, 927,
  1355, 768, 1040, 745, 952, 805, 1073, 740,
  1013, 805, 1008, 796, 996, 1057, 11457, 13504,
];

/**
 * The one Huffman pair, built once and shared.
 *
 * `MSG_initHuffman` is called from `MSG_Init` behind a `msgInit` flag, i.e.
 * lazily and once per process, and the trees are never modified afterwards
 * (see `huffman.ts`'s header). A module-level singleton is that, exactly --
 * and because nothing mutates it, sharing it across concurrent readers is
 * safe in a way the C's file-static `bloc` was not.
 */
let sharedHuff: Huffman | null = null;

function huff(): Huffman {
  if (!sharedHuff) {
    const h = new Huffman();
    h.seed(MSG_HDATA);
    sharedHuff = h;
  }
  return sharedHuff;
}

const scratch = new DataView(new ArrayBuffer(4));

/** Reinterpret an int32's bits as a float32. C's `*(float *)&i`. */
export function intBitsToFloat(i: number): number {
  scratch.setInt32(0, i | 0, true);
  return scratch.getFloat32(0, true);
}

/** Reinterpret a float32's bits as an int32. C's `*(int *)&f`. */
export function floatBitsToInt(f: number): number {
  scratch.setFloat32(0, f, true);
  return scratch.getInt32(0, true);
}

/** `msg_t`, reading. */
export class MsgReader {
  /** `msg->bit` -- the bit cursor. Shared with the Huffman decoder. */
  readonly cursor: BitCursor = { bloc: 0 };
  /** `msg->readcount`. One byte PAST the bit cursor -- see the file header. */
  readcount = 0;
  /** `msg->cursize`. */
  readonly cursize: number;
  /** `msg->oob` -- raw bytes rather than Huffman symbols. */
  private oob = false;

  constructor(
    private readonly data: Uint8Array,
    cursize = data.length,
  ) {
    this.cursize = cursize;
  }

  /** `MSG_Bitstream` -- leave out-of-band mode. */
  bitstream(): void {
    this.oob = false;
  }

  /** `MSG_BeginReadingOOB`. */
  beginReadingOOB(): void {
    this.readcount = 0;
    this.cursor.bloc = 0;
    this.oob = true;
  }

  /** True once the cursor has run past the end of the message. */
  get overflowed(): boolean {
    return this.readcount > this.cursize;
  }

  /** `MSG_ReadBits`. Negative `bits` means signed. */
  readBits(bits: number): number {
    let value = 0;
    let sgn = false;
    let b = bits;

    if (b < 0) {
      b = -b;
      sgn = true;
    }

    if (this.oob) {
      if (b === 8) {
        value = this.data[this.readcount];
        this.readcount += 1;
        this.cursor.bloc += 8;
      } else if (b === 16) {
        value = this.data[this.readcount] | (this.data[this.readcount + 1] << 8);
        this.readcount += 2;
        this.cursor.bloc += 16;
      } else if (b === 32) {
        value =
          (this.data[this.readcount] |
            (this.data[this.readcount + 1] << 8) |
            (this.data[this.readcount + 2] << 16) |
            (this.data[this.readcount + 3] << 24)) >>>
          0;
        this.readcount += 4;
        this.cursor.bloc += 32;
      } else {
        throw new Error(`MSG_ReadBits: can't read ${b} bits out of band`);
      }
    } else {
      let nbits = 0;
      if (b & 7) {
        nbits = b & 7;
        for (let i = 0; i < nbits; i++) {
          value |= huffGetBit(this.data, this.cursor) << i;
        }
        b = b - nbits;
      }
      if (b) {
        const tree = huff().decompressor.tree;
        for (let i = 0; i < b; i += 8) {
          const get = huffOffsetReceive(tree, this.data, this.cursor);
          // `>>> 0` keeps the 32-bit case from going negative mid-accumulation;
          // C's `int` would have, and the sign block below is what decides
          // signedness, not the shifting.
          value = (value | (get << (i + nbits))) >>> 0;
        }
      }
      this.readcount = (this.cursor.bloc >> 3) + 1;
    }

    if (sgn) {
      // `b`, not `bits` -- id's own off-by-a-remainder. See the file header.
      if (value & (1 << (b - 1))) {
        value |= -1 ^ ((1 << b) - 1);
      }
    }

    return value | 0;
  }

  /** `MSG_ReadChar`. -1 past the end. */
  readChar(): number {
    const c = (this.readBits(8) << 24) >> 24;
    return this.overflowed ? -1 : c;
  }

  /** `MSG_ReadByte`. -1 past the end -- which `readString` relies on. */
  readByte(): number {
    const c = this.readBits(8) & 0xff;
    return this.overflowed ? -1 : c;
  }

  /** `MSG_ReadShort`. */
  readShort(): number {
    const c = (this.readBits(16) << 16) >> 16;
    return this.overflowed ? -1 : c;
  }

  /** `MSG_ReadLong`. */
  readLong(): number {
    const c = this.readBits(32) | 0;
    return this.overflowed ? -1 : c;
  }

  /** `MSG_ReadFloat`. */
  readFloat(): number {
    const bits = this.readBits(32);
    return this.overflowed ? -1 : intBitsToFloat(bits);
  }

  /**
   * `MSG_ReadString`. Stops at NUL or at the end of the message.
   *
   * The two substitutions are id's and they are not cosmetic: `%` becomes `.`
   * so a hostile server cannot hand a format string to `Com_Printf`, and
   * anything over 127 becomes `.` as well. A demo's configstrings therefore
   * arrive already sanitised, which is worth knowing before wondering why a
   * player name lost its high-ASCII decoration.
   */
  readString(max = MAX_STRING_CHARS): string {
    let out = '';
    for (;;) {
      const c = this.readByte();
      if (c === -1 || c === 0) {
        break;
      }
      let ch = c;
      if (ch === 0x25 /* '%' */) {
        ch = 0x2e /* '.' */;
      }
      if (ch > 127) {
        ch = 0x2e;
      }
      out += String.fromCharCode(ch);
      if (out.length >= max - 1) {
        break;
      }
    }
    return out;
  }

  /** `MSG_ReadBigString`. */
  readBigString(): string {
    return this.readString(BIG_INFO_STRING);
  }

  /** `MSG_ReadData`. */
  readData(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = this.readByte();
    }
    return out;
  }

  /** `MSG_ReadDelta`. */
  readDelta(oldV: number, bits: number): number {
    if (this.readBits(1)) {
      return this.readBits(bits);
    }
    return oldV;
  }
}

/** `msg_t`, writing. Test-only -- see the file header. */
export class MsgWriter {
  readonly cursor: BitCursor = { bloc: 0 };
  cursize = 0;
  private oob = false;
  private readonly data: Uint8Array;

  constructor(capacity = MAX_MSGLEN) {
    this.data = new Uint8Array(capacity);
  }

  beginWritingOOB(): void {
    this.oob = true;
  }

  bitstream(): void {
    this.oob = false;
  }

  /** The bytes written so far. */
  bytes(): Uint8Array {
    return this.data.slice(0, this.cursize);
  }

  /** `MSG_WriteBits`. */
  writeBits(value: number, bits: number): void {
    let b = bits;
    let v = value;
    if (b === 0 || b < -31 || b > 32) {
      throw new Error(`MSG_WriteBits: bad bits ${bits}`);
    }
    if (b < 0) {
      b = -b;
    }
    if (this.oob) {
      if (b === 8) {
        this.data[this.cursize] = v;
        this.cursize += 1;
        this.cursor.bloc += 8;
      } else if (b === 16) {
        this.data[this.cursize] = v & 0xff;
        this.data[this.cursize + 1] = (v >> 8) & 0xff;
        this.cursize += 2;
        this.cursor.bloc += 16;
      } else if (b === 32) {
        this.data[this.cursize] = v & 0xff;
        this.data[this.cursize + 1] = (v >> 8) & 0xff;
        this.data[this.cursize + 2] = (v >> 16) & 0xff;
        this.data[this.cursize + 3] = (v >> 24) & 0xff;
        this.cursize += 4;
        // id increments by 8 here, not 32. A real bug, and inert because
        // nothing reads `bit` in out-of-band mode. Kept.
        this.cursor.bloc += 8;
      } else {
        throw new Error(`MSG_WriteBits: can't write ${b} bits out of band`);
      }
      return;
    }
    v = b === 32 ? v >>> 0 : (v & (0xffffffff >>> (32 - b))) >>> 0;
    if (b & 7) {
      const nbits = b & 7;
      for (let i = 0; i < nbits; i++) {
        huffPutBit(v & 1, this.data, this.cursor);
        v = v >>> 1;
      }
      b = b - nbits;
    }
    if (b) {
      const tree = huff().compressor;
      for (let i = 0; i < b; i += 8) {
        tree.offsetTransmit(v & 0xff, this.data, this.cursor);
        v = v >>> 8;
      }
    }
    this.cursize = (this.cursor.bloc >> 3) + 1;
  }

  writeByte(c: number): void {
    this.writeBits(c, 8);
  }

  writeShort(c: number): void {
    this.writeBits(c, 16);
  }

  writeLong(c: number): void {
    this.writeBits(c, 32);
  }

  writeData(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      this.writeByte(data[i]);
    }
  }

  /** `MSG_WriteString`. Writes the terminating NUL. */
  writeString(s: string): void {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.writeByte(c > 127 ? 0x2e : c);
    }
    this.writeByte(0);
  }

  /** `MSG_WriteDelta`. */
  writeDelta(oldV: number, newV: number, bits: number): void {
    if (oldV === newV) {
      this.writeBits(0, 1);
      return;
    }
    this.writeBits(1, 1);
    this.writeBits(newV, bits);
  }
}
