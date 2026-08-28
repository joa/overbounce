/**
 * Quake 3 VM opcodes.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Transcribed from id Software's GPLv2 engine sources, which
 * `npm run download-assets -- --refs` fetches:
 *
 *   refs/quake3/qcommon/vm_local.h        `opcode_t`, in this exact order
 *   refs/quake3/qcommon/vm_interpreted.c  `opnames[]`, and VM_PrepareInterpreter's
 *                                         switch — the authority on operand widths
 *
 * The enum is ordinal: `OP_UNDEF` is 0 and every opcode after it is its
 * position in the C enum, so the numbering here must not be reordered even
 * though the grouping comments make it look rearrangeable.
 */

/** `opcode_t`, ordered exactly as `vm_local.h` declares it. */
export const enum Op {
  UNDEF = 0,
  IGNORE = 1,
  BREAK = 2,

  ENTER = 3,
  LEAVE = 4,
  CALL = 5,
  PUSH = 6,
  POP = 7,

  CONST = 8,
  LOCAL = 9,

  JUMP = 10,

  EQ = 11,
  NE = 12,

  LTI = 13,
  LEI = 14,
  GTI = 15,
  GEI = 16,

  LTU = 17,
  LEU = 18,
  GTU = 19,
  GEU = 20,

  EQF = 21,
  NEF = 22,

  LTF = 23,
  LEF = 24,
  GTF = 25,
  GEF = 26,

  LOAD1 = 27,
  LOAD2 = 28,
  LOAD4 = 29,
  STORE1 = 30,
  STORE2 = 31,
  STORE4 = 32,
  ARG = 33,

  BLOCK_COPY = 34,

  SEX8 = 35,
  SEX16 = 36,

  NEGI = 37,
  ADD = 38,
  SUB = 39,
  DIVI = 40,
  DIVU = 41,
  MODI = 42,
  MODU = 43,
  MULI = 44,
  MULU = 45,

  BAND = 46,
  BOR = 47,
  BXOR = 48,
  BCOM = 49,

  LSH = 50,
  RSHI = 51,
  RSHU = 52,

  NEGF = 53,
  ADDF = 54,
  SUBF = 55,
  DIVF = 56,
  MULF = 57,

  CVIF = 58,
  CVFI = 59,
}

/** `opnames[]`, minus the `OP_` prefix. Index is the opcode byte. */
export const OP_NAMES: readonly string[] = [
  'UNDEF', 'IGNORE', 'BREAK', 'ENTER', 'LEAVE', 'CALL', 'PUSH', 'POP',
  'CONST', 'LOCAL', 'JUMP', 'EQ', 'NE', 'LTI', 'LEI', 'GTI',
  'GEI', 'LTU', 'LEU', 'GTU', 'GEU', 'EQF', 'NEF', 'LTF',
  'LEF', 'GTF', 'GEF', 'LOAD1', 'LOAD2', 'LOAD4', 'STORE1', 'STORE2',
  'STORE4', 'ARG', 'BLOCK_COPY', 'SEX8', 'SEX16', 'NEGI', 'ADD', 'SUB',
  'DIVI', 'DIVU', 'MODI', 'MODU', 'MULI', 'MULU', 'BAND', 'BOR',
  'BXOR', 'BCOM', 'LSH', 'RSHI', 'RSHU', 'NEGF', 'ADDF', 'SUBF',
  'DIVF', 'MULF', 'CVIF', 'CVFI',
];

/** Highest opcode the engine defines. Anything above this is not valid bytecode. */
export const OP_MAX = Op.CVFI;

export function opName(op: number): string {
  return OP_NAMES[op] ?? `UNKNOWN_${String(op)}`;
}

/**
 * Operand width in bytes for each opcode.
 *
 * From `VM_PrepareInterpreter`'s comment "these are the only opcodes that
 * aren't a single byte": a 4-byte little-endian operand for ENTER, CONST,
 * LOCAL, LEAVE, BLOCK_COPY and every comparison (whose operand is the branch
 * target), 1 byte for ARG, and none for anything else.
 *
 * This is the whole of the instruction encoding — QVM has no other addressing
 * modes — so a decoder that gets this table right decodes the format.
 */
export function operandWidth(op: number): 0 | 1 | 4 {
  switch (op) {
    case Op.ENTER:
    case Op.CONST:
    case Op.LOCAL:
    case Op.LEAVE:
    case Op.EQ:
    case Op.NE:
    case Op.LTI:
    case Op.LEI:
    case Op.GTI:
    case Op.GEI:
    case Op.LTU:
    case Op.LEU:
    case Op.GTU:
    case Op.GEU:
    case Op.EQF:
    case Op.NEF:
    case Op.LTF:
    case Op.LEF:
    case Op.GTF:
    case Op.GEF:
    case Op.BLOCK_COPY:
      return 4;
    case Op.ARG:
      return 1;
    default:
      return 0;
  }
}

/**
 * Comparison opcodes, whose 4-byte operand is a *branch target* (an instruction
 * index, not a byte offset) rather than a value. `OP_JUMP` branches too, but
 * takes its target from the stack and so carries no operand.
 */
export function isBranch(op: number): boolean {
  return (op >= Op.EQ && op <= Op.GEF) || op === Op.JUMP;
}

/** Float-domain opcodes. A `CONST` feeding one of these is a float bit pattern. */
export function isFloatOp(op: number): boolean {
  return (
    (op >= Op.EQF && op <= Op.GEF) ||
    (op >= Op.NEGF && op <= Op.MULF) ||
    op === Op.CVIF ||
    op === Op.CVFI
  );
}
