/**
 * A minimal QVM assembler, for testing the loader.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Same idea as test/collision's synthetic BSP writer, and the same caveat: this
 * encodes from the struct definitions the loader decodes from, so the two agree
 * with each other even if both are wrong about what id's tools actually emit.
 * It proves the decoder's instruction walk and operand widths. Only a real
 * shipped .qvm settles on-disk layout.
 */

import { Op } from '../../tools/qvm/opcodes.js';
import { operandWidth } from '../../tools/qvm/opcodes.js';
import { QVM_HEADER_BYTES, VM_MAGIC } from '../../tools/qvm/qvm.js';

export interface AsmInstruction {
  op: Op;
  operand?: number;
}

/** `CONST <float bits>` — how q3lcc emits a float literal. */
export function constFloat(value: number): AsmInstruction {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return { op: Op.CONST, operand: new DataView(buf).getInt32(0, true) };
}

export interface AssembleOptions {
  /** Override the magic, to exercise the loader's rejection path. */
  magic?: number;
  /** Override instructionCount, to exercise truncation handling. */
  instructionCount?: number;
  /** Initialised data segment. */
  data?: Uint8Array;
  /** litLength; the rest of `data` counts as dataLength. */
  litLength?: number;
  bssLength?: number;
}

export function assembleQvm(
  instructions: AsmInstruction[],
  options: AssembleOptions = {},
): Uint8Array {
  const codeBytes: number[] = [];
  for (const inst of instructions) {
    const width = operandWidth(inst.op);
    codeBytes.push(inst.op);
    if (width === 4) {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setInt32(0, inst.operand ?? 0, true);
      codeBytes.push(...new Uint8Array(buf));
    } else if (width === 1) {
      codeBytes.push((inst.operand ?? 0) & 0xff);
    }
  }

  const data = options.data ?? new Uint8Array(0);
  const litLength = options.litLength ?? 0;
  const codeOffset = QVM_HEADER_BYTES;
  const dataOffset = codeOffset + codeBytes.length;

  const out = new Uint8Array(dataOffset + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, options.magic ?? VM_MAGIC, true);
  view.setInt32(4, options.instructionCount ?? instructions.length, true);
  view.setInt32(8, codeOffset, true);
  view.setInt32(12, codeBytes.length, true);
  view.setInt32(16, dataOffset, true);
  view.setInt32(20, data.length - litLength, true);
  view.setInt32(24, litLength, true);
  view.setInt32(28, options.bssLength ?? 0, true);

  out.set(codeBytes, codeOffset);
  out.set(data, dataOffset);
  return out;
}
