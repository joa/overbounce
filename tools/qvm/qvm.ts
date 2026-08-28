/**
 * Quake 3 VM (.qvm) image loading and instruction decoding.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Header layout is `vmHeader_t` from refs/quake3/qcommon/qfiles.h; the load and
 * validation path mirrors `VM_Restart` in refs/quake3/qcommon/vm.c. Decoding
 * follows `VM_PrepareInterpreter` (vm_interpreted.c): a flat byte stream of
 * `instructionCount` instructions, each an opcode byte followed by an operand
 * whose width the opcode alone determines.
 *
 * This reads images; it does not execute them. See tools/qvm/disasm.ts for the
 * analysis built on top, and .agent/plans/CPMA-REVERSE-ENG.md for why.
 */

import { operandWidth, Op, OP_MAX } from './opcodes.js';

/** `VM_MAGIC`, qfiles.h. */
export const VM_MAGIC = 0x12721444;

/** `vmHeader_t`. Eight little-endian int32s, in this order. */
export interface QvmHeader {
  vmMagic: number;
  instructionCount: number;
  codeOffset: number;
  codeLength: number;
  dataOffset: number;
  dataLength: number;
  /** `(dataLength - litLength)` is the byteswapped-on-load part. */
  litLength: number;
  /** Zero-filled memory appended to dataLength. */
  bssLength: number;
}

export const QVM_HEADER_BYTES = 32;

export interface Instruction {
  /** Index into `QvmImage.instructions`. Branch operands address this. */
  index: number;
  /** Byte offset within the code segment. */
  pc: number;
  op: number;
  /** Decoded operand, or undefined when the opcode takes none. */
  operand?: number;
}

export interface QvmImage {
  header: QvmHeader;
  instructions: Instruction[];
  /** Instruction index -> byte pc. `vm->instructionPointers`. */
  pcOf: Int32Array;
  /** Byte pc -> instruction index, for resolving a raw offset. */
  indexOfPc: Map<number, number>;
  /** Initialised data: `dataLength + litLength` bytes, as stored. */
  data: Uint8Array;
}

function readHeader(bytes: Uint8Array): QvmHeader {
  if (bytes.length < QVM_HEADER_BYTES) {
    throw new Error(
      `not a QVM: ${String(bytes.length)} bytes is shorter than the ${String(QVM_HEADER_BYTES)}-byte header`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const int = (i: number): number => view.getInt32(i * 4, true);
  return {
    vmMagic: view.getUint32(0, true),
    instructionCount: int(1),
    codeOffset: int(2),
    codeLength: int(3),
    dataOffset: int(4),
    dataLength: int(5),
    litLength: int(6),
    bssLength: int(7),
  };
}

/**
 * `VM_Restart`'s validation, kept to the same four conditions it rejects on.
 *
 * Deliberately no stricter than the engine: a QVM the engine loads must load
 * here, or this tool is measuring something the game does not run.
 */
function validate(header: QvmHeader, size: number): void {
  if (header.vmMagic !== VM_MAGIC) {
    throw new Error(
      `bad header: vmMagic 0x${header.vmMagic.toString(16)} != 0x${VM_MAGIC.toString(16)}`,
    );
  }
  if (
    header.bssLength < 0 ||
    header.dataLength < 0 ||
    header.litLength < 0 ||
    header.codeLength <= 0
  ) {
    throw new Error('bad header: negative segment length');
  }
  const codeEnd = header.codeOffset + header.codeLength;
  const dataEnd = header.dataOffset + header.dataLength + header.litLength;
  if (codeEnd > size || dataEnd > size) {
    throw new Error(
      `truncated image: segments end at ${String(Math.max(codeEnd, dataEnd))} but the file is ${String(size)} bytes`,
    );
  }
}

/**
 * Decode the code segment.
 *
 * `VM_PrepareInterpreter` trusts `instructionCount` and walks forward, so the
 * stream is self-delimiting only in that direction — there is no way to
 * resynchronise after a bad opcode, which is why an out-of-range opcode byte is
 * fatal here rather than skipped. Hitting one means the offsets are wrong, not
 * that one instruction is odd.
 */
function decode(code: Uint8Array, count: number): {
  instructions: Instruction[];
  pcOf: Int32Array;
  indexOfPc: Map<number, number>;
} {
  const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const instructions: Instruction[] = [];
  const pcOf = new Int32Array(count);
  const indexOfPc = new Map<number, number>();

  let pc = 0;
  for (let index = 0; index < count; index++) {
    if (pc >= code.length) {
      throw new Error(
        `code segment exhausted after ${String(index)} of ${String(count)} instructions`,
      );
    }
    pcOf[index] = pc;
    indexOfPc.set(pc, index);

    const op = code[pc];
    if (op > OP_MAX) {
      throw new Error(
        `invalid opcode ${String(op)} at pc ${String(pc)} (instruction ${String(index)})`,
      );
    }
    pc++;

    const width = operandWidth(op);
    if (pc + width > code.length) {
      throw new Error(`operand for ${String(op)} at pc ${String(pc)} runs past the code segment`);
    }
    let operand: number | undefined;
    if (width === 4) {
      operand = view.getInt32(pc, true);
    } else if (width === 1) {
      operand = code[pc];
    }
    pc += width;

    instructions.push(operand === undefined ? { index, pc: pcOf[index], op } : { index, pc: pcOf[index], op, operand });
  }

  return { instructions, pcOf, indexOfPc };
}

export function loadQvm(bytes: Uint8Array): QvmImage {
  const header = readHeader(bytes);
  validate(header, bytes.length);

  const code = bytes.subarray(header.codeOffset, header.codeOffset + header.codeLength);
  const { instructions, pcOf, indexOfPc } = decode(code, header.instructionCount);
  const data = bytes.subarray(
    header.dataOffset,
    header.dataOffset + header.dataLength + header.litLength,
  );

  return { header, instructions, pcOf, indexOfPc, data };
}

/** True when `bytes` starts with the QVM magic. Cheap enough to run over pak entries. */
export function looksLikeQvm(bytes: Uint8Array): boolean {
  if (bytes.length < 4) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === VM_MAGIC;
}

/**
 * Reinterpret an int32 operand as float32.
 *
 * The only way constants are recoverable at all: q3lcc emits float literals as
 * `OP_CONST` with the IEEE-754 bit pattern in the operand, so 150.0f is
 * 0x43160000 and reads back as the integer 1125318656. Nothing in the encoding
 * marks which of the two a given constant is — that is what the surrounding
 * opcodes are for.
 */
export function asFloat(operand: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setInt32(0, operand, true);
  return new DataView(buf).getFloat32(0, true);
}

/** A `CONST` whose value is the address of a function entry, i.e. a call target. */
export function isCallTarget(image: QvmImage, index: number): boolean {
  const next = image.instructions[index + 1];
  return next !== undefined && next.op === Op.CALL;
}
