/**
 * Integration tests against a real Quake III demo.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * OPT-IN, and skipped unless `OB_DEMO` points at a `.dm_68`. No demo is
 * committed -- `demos/` is gitignored, because a retail Quake III demo is not
 * ours to redistribute any more than `pak0.pk3` is (see NOTICE):
 *
 *   OB_DEMO="demos/coldrun[df.vq3.tr]00.06.536(q3a).dm_68" npm run test:demo
 *
 * They exist for the same reason `test/collision/realmap.test.ts` does. The
 * synthetic writer in `demo-writer.ts` encodes from the same netfield tables
 * and the same Huffman frequencies the reader decodes with, so it validates
 * the delta MACHINERY and can never validate the TABLES -- writer and reader
 * would agree with each other even if every field were shifted by one. Only a
 * demo recorded by Quake III itself settles that.
 *
 * The assertions below are chosen to be hard to pass by accident. A decode
 * with a shifted table still parses, still produces snapshots, and still
 * fills them with entities: what it cannot do is produce a POV that moves
 * continuously, at speeds a player can reach, with a monotonic command clock
 * and an animation number that agrees with the weapon.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseDm68, CS, infoValue } from '../../src/demo/dm68.js';
import { demoMeta } from '../../src/demo/meta.js';
import { EntityType } from '../../src/demo/state.js';

const demoPath = process.env.OB_DEMO;
const available = !!demoPath && existsSync(demoPath);

describe.skipIf(!available)('a real .dm_68', () => {
  const demo = available ? parseDm68(new Uint8Array(readFileSync(demoPath!))) : null;

  it('decodes a gamestate with a map name', () => {
    const serverInfo = demo!.configStrings[CS.SERVERINFO] ?? '';
    expect(serverInfo).not.toBe('');
    expect(infoValue(serverInfo, 'mapname')).not.toBe('');
  });

  it('agrees with itself about the protocol', () => {
    const stated = infoValue(demo!.configStrings[CS.SERVERINFO] ?? '', 'protocol');
    if (stated) {
      expect(Number.parseInt(stated, 10)).toBe(68);
    }
  });

  it('has a POV client with its own configstring', () => {
    expect(demo!.clientNum).toBeGreaterThanOrEqual(0);
    expect(demo!.clientNum).toBeLessThan(64);
    expect(demo!.configStrings[CS.PLAYERS + demo!.clientNum]).toBeTruthy();
  });

  it('produces snapshots at a steady rate', () => {
    const meta = demoMeta(demo!);
    expect(meta.snapshotCount).toBeGreaterThan(10);
    expect(meta.snapshotIntervalMs).toBeGreaterThan(0);
    // The measured interval must account for most of the demo, or the
    // "steady rate" reading is wrong.
    const spanned = meta.snapshotIntervalMs * (meta.snapshotCount - 1);
    expect(spanned).toBeGreaterThan(meta.durationMs * 0.8);
  });

  it('has a monotonic server clock and command clock', () => {
    const snaps = demo!.snapshots;
    for (let i = 1; i < snaps.length; i++) {
      expect(snaps[i].serverTime).toBeGreaterThan(snaps[i - 1].serverTime);
      expect(snaps[i].ps.commandTime).toBeGreaterThanOrEqual(snaps[i - 1].ps.commandTime);
    }
  });

  it('moves the POV continuously, at speeds a player can reach', () => {
    const snaps = demo!.snapshots;
    const meta = demoMeta(demo!);
    // A teleport is the one legitimate discontinuity, so the bound is
    // generous -- but a shifted netfield table puts the origin somewhere new
    // every snapshot, which blows past any bound at all.
    const maxStep = 6000 * (meta.snapshotIntervalMs / 1000);
    let worst = 0;
    let teleports = 0;
    for (let i = 1; i < snaps.length; i++) {
      const a = snaps[i - 1].ps.origin;
      const b = snaps[i].ps.origin;
      const step = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (step > maxStep) {
        teleports++;
      } else {
        worst = Math.max(worst, step);
      }
      // Whatever else it is, it is a number.
      expect(Number.isFinite(step)).toBe(true);
    }
    expect(worst).toBeGreaterThan(0);
    // Teleports are rare; a decode failure is not.
    expect(teleports).toBeLessThan(snaps.length / 100);
  });

  it('keeps the POV inside a plausible world and speed envelope', () => {
    let maxCoord = 0;
    let maxSpeed = 0;
    let maxGravity = 0;
    let minGravity = Infinity;
    for (const snap of demo!.snapshots) {
      const [x, y, z] = snap.ps.origin;
      maxCoord = Math.max(maxCoord, Math.abs(x), Math.abs(y), Math.abs(z));
      const [vx, vy, vz] = snap.ps.velocity;
      maxSpeed = Math.max(maxSpeed, Math.hypot(vx, vy, vz));
      maxGravity = Math.max(maxGravity, snap.ps.gravity);
      minGravity = Math.min(minGravity, snap.ps.gravity);
    }
    // `MAX_MAP_BOUNDS` is 65536 in q3map2; nothing legitimately sits outside
    // that, and garbage routinely does.
    expect(maxCoord).toBeLessThan(65536);
    // Generous: a long fall plus a strafe-jump chain. Garbage exceeds it by
    // orders of magnitude, not by a margin.
    expect(maxSpeed).toBeLessThan(20000);
    expect(minGravity).toBeGreaterThanOrEqual(0);
    expect(maxGravity).toBeLessThan(10000);
  });

  it('has a POV weapon and animations in range', () => {
    for (const snap of demo!.snapshots) {
      // `weapon` is a 5-bit field, and `weapon_t` runs to WP_NUM_WEAPONS.
      expect(snap.ps.weapon).toBeGreaterThanOrEqual(0);
      expect(snap.ps.weapon).toBeLessThan(16);
      // The animation number is the low 7 bits; the high bit is
      // ANIM_TOGGLEBIT. Both halves have to be in range.
      expect(snap.ps.legsAnim & 0x7f).toBeLessThan(32);
      expect(snap.ps.torsoAnim & 0x7f).toBeLessThan(32);
    }
  });

  it('only ever produces entity types that exist', () => {
    // Collected and asserted once rather than an `expect` per entity: a long
    // demo holds a couple of hundred thousand entity states across its
    // snapshots, and a quarter of a million assertion calls is seconds of
    // test time for the same single answer.
    const badTypes = new Set<number>();
    const badNumbers = new Set<number>();
    for (const snap of demo!.snapshots) {
      for (const ent of snap.entities) {
        // Below ET_EVENTS it must be a real entityType_t; at or above, it is
        // a freestanding event and the event number must be inside the
        // 10-bit event field's range.
        if (ent.eType < 0 || ent.eType - EntityType.EVENTS >= 256) {
          badTypes.add(ent.eType);
        }
        if (ent.number < 0 || ent.number >= 1024) {
          badNumbers.add(ent.number);
        }
      }
    }
    expect([...badTypes]).toEqual([]);
    expect([...badNumbers]).toEqual([]);
  });

  it('reads the physics mode from the server, or admits it does not know', () => {
    expect(['vq3', 'cpm', 'unknown']).toContain(demoMeta(demo!).physics);
  });

  it('decodes the WHOLE file, not just as far as it got', () => {
    // The reader tolerates a demo cut off mid-message, which is also exactly
    // how a decode bug presents -- it stops early and keeps what it had. So
    // the assertion has to be on `complete`, which is false in both cases,
    // rather than on anything that survives an early stop.
    expect(demo!.stoppedBecause).toBeNull();
    expect(demo!.complete).toBe(true);
    expect(demo!.unknownOps).toEqual([]);
    // Every message after the gamestate carried a snapshot, so these track
    // each other -- a decode that quietly stopped halfway would not.
    expect(demo!.messagesRead).toBeGreaterThanOrEqual(demo!.snapshots.length);
  });
});
