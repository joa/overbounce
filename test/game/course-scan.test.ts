/**
 * The per-map scan course select needs before any map is played.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { describe, it, expect } from 'vitest';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { scanCourseSummary } from '../../src/game/course-scan.js';
import { writeBsp } from '../collision/bsp-writer.js';
import { CONTENTS_SOLID } from '../../src/physics/constants.js';

const BOX = {
  mins: [-64, -64, -16] as [number, number, number],
  maxs: [64, 64, 0] as [number, number, number],
  contents: CONTENTS_SOLID,
};

/** Build a minimal, uncompressed (stored) ZIP containing the given files. */
function buildStoredZip(files: Record<string, Uint8Array>): Blob {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [name, data] of Object.entries(files)) {
    const nameBytes = enc.encode(name);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralStart = offset;
  const centralBytes = centrals.reduce((n, c) => n + c.length, 0);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralBytes, true);
  ev.setUint32(16, centralStart, true);

  return new Blob([...locals, ...centrals, eocd] as BlobPart[]);
}

describe('scanCourseSummary', () => {
  it('counts checkpoints and finds the timer entity, from the entity lump alone', async () => {
    const entities =
      '{\n"classname" "worldspawn"\n}\n' +
      '{\n"classname" "target_startTimer"\n}\n' +
      '{\n"classname" "target_checkpoint"\n}\n' +
      '{\n"classname" "target_checkpoint"\n}\n' +
      '{\n"classname" "target_stopTimer"\n}\n\0';
    const bsp = new Uint8Array(writeBsp([BOX], [], [], entities));

    const fs = new Pk3FileSystem();
    await fs.mount('timed.pk3', buildStoredZip({ 'maps/timed.bsp': bsp }));

    const summary = await scanCourseSummary(fs, 'timed');
    expect(summary).toEqual({ timed: true, checkpoints: 2 });
  });

  it('reports untimed for a map with no target_startTimer -- FREERUN, per R3', async () => {
    const entities = '{\n"classname" "worldspawn"\n}\n\0';
    const bsp = new Uint8Array(writeBsp([BOX], [], [], entities));

    const fs = new Pk3FileSystem();
    await fs.mount('freerun.pk3', buildStoredZip({ 'maps/freerun.bsp': bsp }));

    const summary = await scanCourseSummary(fs, 'freerun');
    expect(summary).toEqual({ timed: false, checkpoints: 0 });
  });

  it('returns null for a map that is not mounted, rather than throwing', async () => {
    const fs = new Pk3FileSystem();
    expect(await scanCourseSummary(fs, 'nope')).toBeNull();
  });

  it('returns null for a file that exists but is not a real BSP', async () => {
    const fs = new Pk3FileSystem();
    await fs.mount(
      'bad.pk3',
      buildStoredZip({ 'maps/bad.bsp': new TextEncoder().encode('not a bsp') }),
    );
    expect(await scanCourseSummary(fs, 'bad')).toBeNull();
  });
});
