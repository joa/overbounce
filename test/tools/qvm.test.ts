/**
 * QVM loader and constant-recovery tests.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * See .agent/plans/CPMA-REVERSE-ENG.md. These prove the decoder without any
 * CPMA file present, so the analysis is a single command once one lands.
 */

import { describe, expect, it } from 'vitest';

import { Op, opName, operandWidth } from '../../tools/qvm/opcodes.js';
import { asFloat, loadQvm, looksLikeQvm, VM_MAGIC } from '../../tools/qvm/qvm.js';
import { findCalls, findFunctions, functionAt, groupFloats, scanFloats } from '../../tools/qvm/disasm.js';
import { assembleQvm, constFloat } from './qvm-writer.js';

describe('opcode table', () => {
  it('numbers opcodes by their position in vm_local.h', () => {
    // The one thing that would silently corrupt every disassembly.
    expect(Op.UNDEF).toBe(0);
    expect(Op.ENTER).toBe(3);
    expect(Op.CONST).toBe(8);
    expect(Op.LEAVE).toBe(4);
    expect(Op.BLOCK_COPY).toBe(34);
    expect(Op.MULF).toBe(57);
    expect(Op.CVFI).toBe(59);
    expect(opName(Op.MULF)).toBe('MULF');
  });

  it('gives a 4-byte operand to exactly the opcodes VM_PrepareInterpreter lists', () => {
    const wide = [
      Op.ENTER, Op.CONST, Op.LOCAL, Op.LEAVE, Op.EQ, Op.NE, Op.LTI, Op.LEI,
      Op.GTI, Op.GEI, Op.LTU, Op.LEU, Op.GTU, Op.GEU, Op.EQF, Op.NEF,
      Op.LTF, Op.LEF, Op.GTF, Op.GEF, Op.BLOCK_COPY,
    ];
    for (const op of wide) {
      expect(operandWidth(op)).toBe(4);
    }
    expect(operandWidth(Op.ARG)).toBe(1);
    for (const op of [Op.CALL, Op.PUSH, Op.POP, Op.JUMP, Op.ADD, Op.MULF, Op.LOAD4]) {
      expect(operandWidth(op)).toBe(0);
    }
  });
});

describe('loadQvm', () => {
  it('round-trips a hand-assembled image', () => {
    const program = [
      { op: Op.ENTER, operand: 16 },
      { op: Op.LOCAL, operand: 8 },
      { op: Op.LOAD4 },
      constFloat(150),
      { op: Op.MULF },
      { op: Op.ARG, operand: 8 },
      { op: Op.LEAVE, operand: 16 },
    ];
    const image = loadQvm(assembleQvm(program));

    expect(image.header.vmMagic).toBe(VM_MAGIC);
    expect(image.header.instructionCount).toBe(program.length);
    expect(image.instructions.map((i) => i.op)).toEqual(program.map((p) => p.op));
    expect(image.instructions[0].operand).toBe(16);
    expect(image.instructions[5].operand).toBe(8);
    expect(image.instructions[6].operand).toBe(16);
  });

  it('advances pc by the operand width of each opcode', () => {
    // ENTER(1+4) LOAD4(1) ARG(1+1) MULF(1)
    const image = loadQvm(
      assembleQvm([
        { op: Op.ENTER, operand: 0 },
        { op: Op.LOAD4 },
        { op: Op.ARG, operand: 4 },
        { op: Op.MULF },
      ]),
    );
    expect([...image.pcOf]).toEqual([0, 5, 6, 8]);
    expect(image.indexOfPc.get(8)).toBe(3);
  });

  it('reads a negative operand as signed, which is how syscalls are encoded', () => {
    const image = loadQvm(
      assembleQvm([
        { op: Op.ENTER, operand: 8 },
        { op: Op.CONST, operand: -21 },
        { op: Op.CALL },
      ]),
    );
    expect(image.instructions[1].operand).toBe(-21);
    expect(findCalls(image)).toEqual([{ at: 2, target: -21 }]);
  });

  it('rejects a bad magic', () => {
    expect(() => loadQvm(assembleQvm([{ op: Op.LEAVE, operand: 0 }], { magic: 0xdeadbeef }))).toThrow(
      /vmMagic/,
    );
  });

  it('rejects an instructionCount the code segment cannot satisfy', () => {
    expect(() =>
      loadQvm(assembleQvm([{ op: Op.ADD }], { instructionCount: 4 })),
    ).toThrow(/exhausted/);
  });

  it('rejects an out-of-range opcode rather than resynchronising', () => {
    const bytes = assembleQvm([{ op: Op.ENTER, operand: 0 }, { op: Op.ADD }]);
    bytes[bytes.length - 1] = 200;
    expect(() => loadQvm(bytes)).toThrow(/invalid opcode 200/);
  });

  it('recognises the magic without a full parse', () => {
    expect(looksLikeQvm(assembleQvm([{ op: Op.ADD }]))).toBe(true);
    expect(looksLikeQvm(new Uint8Array([1, 2, 3, 4]))).toBe(false);
    expect(looksLikeQvm(new Uint8Array([1]))).toBe(false);
  });

  it('exposes the initialised data segment', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const image = loadQvm(assembleQvm([{ op: Op.ADD }], { data, litLength: 4 }));
    expect(image.header.dataLength).toBe(4);
    expect(image.header.litLength).toBe(4);
    expect([...image.data]).toEqual([...data]);
  });
});

describe('asFloat', () => {
  it('decodes the IEEE-754 bit patterns q3lcc emits for float literals', () => {
    // These four are the CPM constants the exercise is looking for, written
    // the way they will appear in a CONST operand.
    expect(asFloat(0x43160000)).toBe(150); // AIR_CONTROL
    expect(asFloat(0x428c0000)).toBe(70); // STRAFE_ACCELERATE
    expect(asFloat(0x41f00000)).toBe(30); // WISH_SPEED
    expect(asFloat(0x40200000)).toBe(2.5); // AIR_STOP_ACCELERATE
    // and as a signed int32, which is how the operand is actually stored.
    expect(asFloat(1125515264)).toBe(150);
  });

  it('decodes a small integer constant as a denormal, which is what makes filtering possible', () => {
    // The reason scanFloats has a lower bound: `CONST 320` is an int, and it
    // decodes to ~4.5e-43 rather than to anything plausible.
    expect(asFloat(320)).toBeLessThan(1e-40);
  });
});

describe('findFunctions', () => {
  it('splits on OP_ENTER and runs each function to the next entry', () => {
    const image = loadQvm(
      assembleQvm([
        { op: Op.ENTER, operand: 8 },
        { op: Op.LEAVE, operand: 8 },
        { op: Op.ENTER, operand: 24 },
        { op: Op.ADD },
        { op: Op.LEAVE, operand: 24 },
        { op: Op.LEAVE, operand: 24 },
      ]),
    );
    const functions = findFunctions(image);
    expect(functions).toEqual([
      { entry: 0, end: 2, frameSize: 8 },
      { entry: 2, end: 6, frameSize: 24 },
    ]);
    expect(functionAt(functions, 3)?.entry).toBe(2);
    expect(functionAt(functions, 0)?.entry).toBe(0);
  });

  it('does not attribute code preceding the first entry to any function', () => {
    const image = loadQvm(assembleQvm([{ op: Op.ADD }, { op: Op.ENTER, operand: 8 }]));
    expect(functionAt(findFunctions(image), 0)).toBeUndefined();
  });
});

describe('scanFloats', () => {
  it('recovers a float constant and attributes it to its function', () => {
    const image = loadQvm(
      assembleQvm([
        { op: Op.ENTER, operand: 16 },
        constFloat(150),
        { op: Op.MULF },
        { op: Op.LEAVE, operand: 16 },
      ]),
    );
    const found = scanFloats(image, findFunctions(image));
    expect(found).toHaveLength(1);
    expect(found[0].value).toBe(150);
    expect(found[0].fn).toBe(0);
    expect(found[0].confirmed).toBe(true);
  });

  it('reports an unconfirmed constant rather than dropping it', () => {
    // No float-domain opcode follows, so `confirmed` is false — but the value
    // is still reported. Dropping it is exactly the failure mode that would
    // lose the one constant this exercise is about.
    const image = loadQvm(
      assembleQvm([{ op: Op.ENTER, operand: 8 }, constFloat(2.5), { op: Op.LEAVE, operand: 8 }]),
    );
    const found = scanFloats(image, findFunctions(image));
    expect(found).toHaveLength(1);
    expect(found[0].value).toBe(2.5);
    expect(found[0].confirmed).toBe(false);
  });

  it('filters out integer constants, which decode as implausible denormals', () => {
    const image = loadQvm(
      assembleQvm([
        { op: Op.ENTER, operand: 8 },
        { op: Op.CONST, operand: 320 },
        { op: Op.CONST, operand: 0 },
        { op: Op.CONST, operand: 1 },
        { op: Op.LEAVE, operand: 8 },
      ]),
    );
    expect(scanFloats(image, findFunctions(image))).toHaveLength(0);
  });

  it('groups repeated values by frequency', () => {
    const image = loadQvm(
      assembleQvm([
        { op: Op.ENTER, operand: 8 },
        constFloat(0.25),
        { op: Op.MULF },
        constFloat(150),
        { op: Op.MULF },
        constFloat(0.25),
        { op: Op.MULF },
        { op: Op.LEAVE, operand: 8 },
      ]),
    );
    const groups = groupFloats(scanFloats(image, findFunctions(image)));
    expect(groups.map((g) => [g.value, g.count])).toEqual([
      [0.25, 2],
      [150, 1],
    ]);
    expect(groups[0].confirmed).toBe(2);
  });
});

describe('a VQ3-shaped fingerprint', () => {
  it('picks PM_Friction out of a file by its constants alone', () => {
    // The identification strategy, in miniature: QVMs are stripped, so a
    // function is found by the numbers in it. pm_stopspeed 100, pm_friction 6
    // and PM_Friction's 0.25 water scale sit together in one function and
    // nowhere else.
    const image = loadQvm(
      assembleQvm([
        // some other function
        { op: Op.ENTER, operand: 8 },
        constFloat(800),
        { op: Op.MULF },
        { op: Op.LEAVE, operand: 8 },
        // the one we want
        { op: Op.ENTER, operand: 32 },
        constFloat(100),
        { op: Op.MULF },
        constFloat(6),
        { op: Op.MULF },
        constFloat(0.25),
        { op: Op.MULF },
        { op: Op.LEAVE, operand: 32 },
      ]),
    );
    const functions = findFunctions(image);
    const floats = scanFloats(image, functions);

    const byFunction = new Map<number, Set<number>>();
    for (const f of floats) {
      const set = byFunction.get(f.fn) ?? new Set<number>();
      set.add(f.value);
      byFunction.set(f.fn, set);
    }

    const fingerprint = [100, 6, 0.25];
    const matches = [...byFunction.entries()].filter(([, values]) =>
      fingerprint.every((v) => values.has(v)),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0][0]).toBe(4);
  });
});
