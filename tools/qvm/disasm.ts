/**
 * Disassembly and constant recovery for Quake 3 VM images.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The point of this file is `scanFloats`. QVMs ship stripped — no symbol table,
 * no names — so a function cannot be found by looking it up, only by
 * recognising it. Pmove's tunables reach the bytecode as `OP_CONST` immediates
 * holding IEEE-754 bit patterns, and a function that contains 100.0, 10.0 and
 * 6.0 is `PM_Friction` whatever it is called. Everything else here exists to
 * make that recognition checkable by hand afterwards.
 *
 * See .agent/plans/CPMA-REVERSE-ENG.md for what may and may not be taken out of
 * a proprietary VM this way. Short version: numbers yes, code no.
 */

import { asFloat, type Instruction, type QvmImage } from './qvm.js';
import { isBranch, isFloatOp, Op, opName } from './opcodes.js';

export interface QvmFunction {
  /** Instruction index of the `OP_ENTER`. This is the address `OP_CALL` uses. */
  entry: number;
  /** One past the last instruction belonging to this function. */
  end: number;
  /** `OP_ENTER`'s operand: bytes of stack frame the function reserves. */
  frameSize: number;
}

/**
 * Split the image into functions on `OP_ENTER`.
 *
 * q3lcc emits exactly one `OP_ENTER` per function, as its first instruction, so
 * the entries partition the code completely: each function runs to the next
 * entry. That is more reliable than segmenting on `OP_LEAVE`, which appears
 * once per `return` statement and so several times in most functions.
 */
export function findFunctions(image: QvmImage): QvmFunction[] {
  const functions: QvmFunction[] = [];
  for (const inst of image.instructions) {
    if (inst.op === Op.ENTER) {
      functions.push({ entry: inst.index, end: 0, frameSize: inst.operand ?? 0 });
    }
  }
  for (let i = 0; i < functions.length; i++) {
    functions[i].end = i + 1 < functions.length ? functions[i + 1].entry : image.instructions.length;
  }
  return functions;
}

/** The function containing `index`, or undefined if it precedes the first entry. */
export function functionAt(functions: QvmFunction[], index: number): QvmFunction | undefined {
  let lo = 0;
  let hi = functions.length - 1;
  let found: QvmFunction | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (functions[mid].entry <= index) {
      found = functions[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found !== undefined && index < found.end ? found : undefined;
}

/**
 * Call targets, resolved from the `OP_CONST` that feeds each `OP_CALL`.
 *
 * `OP_CALL` takes its destination off the stack, so a call is only readable as
 * the pair `CONST <n>; CALL`. A negative n is an engine syscall (`-1 - index`
 * into cg_syscalls.asm / g_syscalls.asm) rather than a VM address; those are
 * reported as-is because they are the other half of identifying a function —
 * anything calling `trap_Trace` is doing collision.
 */
export function findCalls(image: QvmImage): { at: number; target: number }[] {
  const calls: { at: number; target: number }[] = [];
  for (let i = 1; i < image.instructions.length; i++) {
    const inst = image.instructions[i];
    const prev = image.instructions[i - 1];
    if (inst.op === Op.CALL && prev.op === Op.CONST && prev.operand !== undefined) {
      calls.push({ at: i, target: prev.operand });
    }
  }
  return calls;
}

export interface FloatConstant {
  /** Instruction index of the `OP_CONST`. */
  at: number;
  /** The raw operand, as int32. */
  raw: number;
  value: number;
  /** Entry index of the enclosing function, or -1. */
  fn: number;
  /**
   * True when a float-domain opcode uses this constant within a few
   * instructions — strong evidence the bit pattern really is a float rather
   * than a large integer that happens to decode as one.
   */
  confirmed: boolean;
}

/**
 * How far ahead of an `OP_CONST` to look for a float-domain opcode.
 *
 * A constant is normally consumed within an instruction or two (`CONST; MULF`),
 * but one operand of a binary op may be a whole subexpression, so the window
 * has to be wider than that. Eight is enough for the pmove idioms
 * (`CONST; LOCAL; LOAD4; MULF`) without reaching into the next statement often
 * enough to matter. `confirmed` is a hint for ranking, not a filter — an
 * unconfirmed constant is still reported.
 */
const FLOAT_USE_WINDOW = 8;

/**
 * Plausibility bounds for a recovered float.
 *
 * Every int32 decodes as *some* float, so filtering is the whole job. Small
 * integers (0, 1, 4, 320) decode to denormals around 1e-43 and are excluded by
 * the lower bound; genuine physics constants sit between roughly 1e-3 (an
 * epsilon) and 1e5 (a speed cap or a large fuse time).
 */
const MIN_PLAUSIBLE = 1e-4;
const MAX_PLAUSIBLE = 1e6;

/**
 * Recover float constants from `OP_CONST` immediates.
 *
 * This is deliberately noisy. It is better to hand-filter a list that contains
 * the answer than to tighten the heuristic until it silently drops the one
 * constant the whole exercise is about.
 */
export function scanFloats(image: QvmImage, functions: QvmFunction[]): FloatConstant[] {
  const out: FloatConstant[] = [];
  for (const inst of image.instructions) {
    if (inst.op !== Op.CONST || inst.operand === undefined) {
      continue;
    }
    const value = asFloat(inst.operand);
    if (!Number.isFinite(value) || value === 0) {
      continue;
    }
    const magnitude = Math.abs(value);
    if (magnitude < MIN_PLAUSIBLE || magnitude > MAX_PLAUSIBLE) {
      continue;
    }

    let confirmed = false;
    const limit = Math.min(inst.index + 1 + FLOAT_USE_WINDOW, image.instructions.length);
    for (let j = inst.index + 1; j < limit; j++) {
      if (isFloatOp(image.instructions[j].op)) {
        confirmed = true;
        break;
      }
    }

    out.push({
      at: inst.index,
      raw: inst.operand,
      value,
      fn: functionAt(functions, inst.index)?.entry ?? -1,
      confirmed,
    });
  }
  return out;
}

/** Group recovered floats by value, most frequent first. */
export function groupFloats(
  floats: FloatConstant[],
): { value: number; count: number; confirmed: number; sites: FloatConstant[] }[] {
  const byValue = new Map<number, FloatConstant[]>();
  for (const f of floats) {
    const bucket = byValue.get(f.value);
    if (bucket === undefined) {
      byValue.set(f.value, [f]);
    } else {
      bucket.push(f);
    }
  }
  return [...byValue.entries()]
    .map(([value, sites]) => ({
      value,
      count: sites.length,
      confirmed: sites.filter((s) => s.confirmed).length,
      sites,
    }))
    .sort((a, b) => b.count - a.count || a.value - b.value);
}

function formatOperand(inst: Instruction): string {
  if (inst.operand === undefined) {
    return '';
  }
  if (isBranch(inst.op)) {
    return `-> ${String(inst.operand)}`;
  }
  if (inst.op === Op.CONST) {
    const f = asFloat(inst.operand);
    const magnitude = Math.abs(f);
    const asFloatNote =
      Number.isFinite(f) && f !== 0 && magnitude >= MIN_PLAUSIBLE && magnitude <= MAX_PLAUSIBLE
        ? `  ; ${String(f)}f`
        : '';
    return `${String(inst.operand)}${asFloatNote}`;
  }
  return String(inst.operand);
}

/** Render one instruction as `index  pc  OP  operand`. */
export function formatInstruction(inst: Instruction): string {
  const index = String(inst.index).padStart(7);
  const pc = inst.pc.toString(16).padStart(6, '0');
  const name = opName(inst.op).padEnd(11);
  return `${index}  ${pc}  ${name} ${formatOperand(inst)}`.trimEnd();
}

/** Render a function, with a header naming its entry address and frame size. */
export function formatFunction(image: QvmImage, fn: QvmFunction): string {
  const lines = [
    `; ---- function @${String(fn.entry)} (pc 0x${image.pcOf[fn.entry].toString(16)}), ` +
      `frame ${String(fn.frameSize)} bytes, ${String(fn.end - fn.entry)} instructions ----`,
  ];
  for (let i = fn.entry; i < fn.end; i++) {
    lines.push(formatInstruction(image.instructions[i]));
  }
  return lines.join('\n');
}

/**
 * A `DataView` over the image's initialised data.
 *
 * VM data addresses are offsets from the start of this segment, which is what
 * an `OP_CONST` feeding `OP_LOAD4` holds, so an address printed by `--globals`
 * indexes straight into it.
 */
export function dataView(image: QvmImage): DataView {
  return new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength);
}

/** One word of the data segment, read both ways because nothing marks which. */
export interface DataWord {
  addr: number;
  float: number;
  int: number;
}

/** Read `[lo, hi)` of the data segment, one word at a time. */
export function readData(image: QvmImage, lo: number, hi: number): DataWord[] {
  const view = dataView(image);
  const end = Math.min(hi, image.data.length);
  const words: DataWord[] = [];
  for (let addr = lo; addr + 4 <= end; addr += 4) {
    words.push({ addr, float: view.getFloat32(addr, true), int: view.getInt32(addr, true) });
  }
  return words;
}

/**
 * The global variables a function reads, as data addresses.
 *
 * q3lcc compiles a read of a file-scope variable to `OP_CONST <addr>` followed
 * by `OP_LOAD4`, which is what makes tunables recoverable even though they are
 * not immediates: `PM_Friction` does not contain 6.0, it contains the address
 * `pm_friction` lives at. Pairs whose address falls outside the initialised
 * data are dropped — those are bss, and hold nothing to read.
 */
export function findGlobalReads(image: QvmImage, fn: QvmFunction): Map<number, number> {
  const reads = new Map<number, number>();
  for (let i = fn.entry; i < fn.end - 1; i++) {
    const a = image.instructions[i];
    const b = image.instructions[i + 1];
    if (a.op !== Op.CONST || a.operand === undefined) {
      continue;
    }
    if (b.op !== Op.LOAD4 && b.op !== Op.STORE4) {
      continue;
    }
    if (a.operand < 0 || a.operand + 4 > image.data.length) {
      continue;
    }
    reads.set(a.operand, (reads.get(a.operand) ?? 0) + 1);
  }
  return reads;
}

/** Where a data address is used, as `fn entry -> use count`. */
export function findDataRefs(
  image: QvmImage,
  functions: QvmFunction[],
  addr: number,
): Map<number, number> {
  const refs = new Map<number, number>();
  for (let i = 0; i < image.instructions.length - 1; i++) {
    const a = image.instructions[i];
    const b = image.instructions[i + 1];
    if (a.op !== Op.CONST || a.operand !== addr) {
      continue;
    }
    if (b.op !== Op.LOAD4 && b.op !== Op.STORE4) {
      continue;
    }
    const fn = functionAt(functions, i);
    if (fn !== undefined) {
      refs.set(fn.entry, (refs.get(fn.entry) ?? 0) + 1);
    }
  }
  return refs;
}

/** Printable-ASCII runs in the data segment, with the address each starts at. */
export function scanStrings(image: QvmImage, min = 3): { addr: number; text: string }[] {
  const found: { addr: number; text: string }[] = [];
  const decoder = new TextDecoder();
  let start = -1;
  for (let i = 0; i <= image.data.length; i++) {
    const c = i < image.data.length ? image.data[i] : 0;
    if (c >= 0x20 && c < 0x7f) {
      if (start < 0) {
        start = i;
      }
      continue;
    }
    if (start >= 0 && i - start >= min) {
      found.push({ addr: start, text: decoder.decode(image.data.subarray(start, i)) });
    }
    start = -1;
  }
  return found;
}
