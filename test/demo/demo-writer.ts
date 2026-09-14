/**
 * A synthetic `.dm_68` writer, for testing the reader.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The same device `test/collision/bsp-writer.ts` is, and it carries the same
 * warning, which CLAUDE.md states in general terms and this restates in
 * specific ones: **this encodes from the same understanding of the format
 * that `src/demo/` decodes with.** If the netfield tables were transposed,
 * writer and reader would agree with each other perfectly and both be wrong.
 *
 * What it therefore DOES prove: that the delta machinery is
 * self-consistent -- change counts, per-field change bits, the
 * zero/integral/full-float ladder, the sorted merge in packet entities, the
 * ring of delta parents, the framing. Those are the parts with real logic in
 * them, and a bug in any of them shows up here.
 *
 * What only `OB_DEMO=<file>` can prove: that the tables and the Huffman
 * frequencies match what Quake III actually writes.
 */

import { MsgWriter } from '../../src/demo/msg.js';
import { Svc } from '../../src/demo/dm68.js';
import {
  DemoPlayerState,
  EntityState,
  writeDeltaEntity,
  writeDeltaPlayerState,
} from '../../src/demo/state.js';
import { ES, PS } from '../../src/demo/netfields.js';

const MAX_GENTITIES = 1024;

export interface SyntheticSnapshot {
  serverTime: number;
  ps: DemoPlayerState;
  entities: EntityState[];
}

/** Build a `playerState_t` from readable fields. */
export function makePlayerState(fields: {
  commandTime: number;
  origin: [number, number, number];
  velocity: [number, number, number];
  viewangles: [number, number, number];
  weapon?: number;
  legsAnim?: number;
  torsoAnim?: number;
  groundEntityNum?: number;
  pm_flags?: number;
  stats?: number[];
  ammo?: number[];
}): DemoPlayerState {
  const ps = new DemoPlayerState();
  ps.words[PS.commandTime] = fields.commandTime;
  ps.floats[PS.origin_0] = fields.origin[0];
  ps.floats[PS.origin_1] = fields.origin[1];
  ps.floats[PS.origin_2] = fields.origin[2];
  ps.floats[PS.velocity_0] = fields.velocity[0];
  ps.floats[PS.velocity_1] = fields.velocity[1];
  ps.floats[PS.velocity_2] = fields.velocity[2];
  ps.floats[PS.viewangles_0] = fields.viewangles[0];
  ps.floats[PS.viewangles_1] = fields.viewangles[1];
  ps.floats[PS.viewangles_2] = fields.viewangles[2];
  ps.words[PS.weapon] = fields.weapon ?? 0;
  ps.words[PS.legsAnim] = fields.legsAnim ?? 0;
  ps.words[PS.torsoAnim] = fields.torsoAnim ?? 0;
  ps.words[PS.groundEntityNum] = fields.groundEntityNum ?? MAX_GENTITIES - 1;
  ps.words[PS.pm_flags] = fields.pm_flags ?? 0;
  for (let i = 0; i < (fields.stats?.length ?? 0); i++) {
    ps.stats[i] = fields.stats![i];
  }
  for (let i = 0; i < (fields.ammo?.length ?? 0); i++) {
    ps.ammo[i] = fields.ammo![i];
  }
  return ps;
}

/** Build an `entityState_t` from readable fields. */
export function makeEntity(fields: {
  number: number;
  eType: number;
  origin?: [number, number, number];
  trBase?: [number, number, number];
  trDelta?: [number, number, number];
  trType?: number;
  trTime?: number;
  weapon?: number;
  clientNum?: number;
  modelindex?: number;
  /**
   * `SOLID_BMODEL` (0xffffff) to make `modelindex` an INLINE model index.
   *
   * Not decoration: `CG_Mover` (`cg_ents.c:580`) reads `modelindex` as an
   * inline brush model only when `solid == SOLID_BMODEL`, and as an index
   * into the ordinary model list otherwise. A mover written without it is a
   * mover pointing at the wrong list.
   */
  solid?: number;
  event?: number;
  eventParm?: number;
  legsAnim?: number;
  torsoAnim?: number;
}): EntityState {
  const es = new EntityState();
  es.number = fields.number;
  es.words[ES.eType] = fields.eType;
  const origin = fields.origin ?? [0, 0, 0];
  es.floats[ES.origin_0] = origin[0];
  es.floats[ES.origin_1] = origin[1];
  es.floats[ES.origin_2] = origin[2];
  const trBase = fields.trBase ?? origin;
  es.floats[ES.pos_trBase_0] = trBase[0];
  es.floats[ES.pos_trBase_1] = trBase[1];
  es.floats[ES.pos_trBase_2] = trBase[2];
  const trDelta = fields.trDelta ?? [0, 0, 0];
  es.floats[ES.pos_trDelta_0] = trDelta[0];
  es.floats[ES.pos_trDelta_1] = trDelta[1];
  es.floats[ES.pos_trDelta_2] = trDelta[2];
  es.words[ES.pos_trType] = fields.trType ?? 0;
  es.words[ES.pos_trTime] = fields.trTime ?? 0;
  es.words[ES.weapon] = fields.weapon ?? 0;
  es.words[ES.clientNum] = fields.clientNum ?? 0;
  es.words[ES.modelindex] = fields.modelindex ?? 0;
  es.words[ES.solid] = fields.solid ?? 0;
  es.words[ES.event] = fields.event ?? 0;
  es.words[ES.eventParm] = fields.eventParm ?? 0;
  es.words[ES.legsAnim] = fields.legsAnim ?? 0;
  es.words[ES.torsoAnim] = fields.torsoAnim ?? 0;
  return es;
}

/** One demo message, framed as `CL_WriteDemoMessage` does. */
function frame(sequence: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setInt32(0, sequence, true);
  view.setInt32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

export interface SyntheticDemoOptions {
  configStrings: Record<number, string>;
  baselines?: EntityState[];
  clientNum: number;
  snapshots: SyntheticSnapshot[];
  /** Server commands, keyed by the snapshot index they precede. */
  commands?: { atSnapshot: number; text: string }[];
  /** Truncate the last message's bytes, to test a demo cut off mid-record. */
  truncateTail?: boolean | undefined;
}

/**
 * Write a whole synthetic demo.
 *
 * Every snapshot after the first deltas from its immediate predecessor, which
 * is the ordinary case; the first is uncompressed (`deltaNum` 0 on the wire).
 */
export function writeSyntheticDemo(options: SyntheticDemoOptions): Uint8Array {
  const chunks: Uint8Array[] = [];
  let sequence = 1;
  let commandSequence = 0;

  // --- the gamestate message ---
  {
    const msg = new MsgWriter();
    msg.writeLong(0); // reliableAcknowledge
    msg.writeByte(Svc.GAMESTATE);
    msg.writeLong(commandSequence);
    for (const [index, value] of Object.entries(options.configStrings)) {
      msg.writeByte(Svc.CONFIGSTRING);
      msg.writeShort(Number(index));
      msg.writeString(value);
    }
    for (const baseline of options.baselines ?? []) {
      msg.writeByte(Svc.BASELINE);
      // The entity number is written by `writeDeltaEntity` itself, not here.
      // The asymmetry is real and is id's: the WRITER emits the number as
      // part of the delta, while the READER pulls it off first and hands it
      // to `readDeltaEntity` as an argument (that is how it knows which
      // `from` to delta against). Writing it here too desynchronises the
      // whole gamestate by ten bits.
      writeDeltaEntity(msg, new EntityState(), baseline, true);
    }
    msg.writeByte(Svc.EOF);
    msg.writeLong(options.clientNum);
    msg.writeLong(0); // checksumFeed
    msg.writeByte(Svc.EOF);
    chunks.push(frame(sequence, msg.bytes()));
    sequence++;
  }

  // --- snapshots ---
  const baselineFor = (number: number): EntityState =>
    (options.baselines ?? []).find((b) => b.number === number) ?? new EntityState();

  for (let i = 0; i < options.snapshots.length; i++) {
    const snap = options.snapshots[i];
    const prev = i > 0 ? options.snapshots[i - 1] : null;
    const msg = new MsgWriter();
    msg.writeLong(0); // reliableAcknowledge

    for (const command of options.commands ?? []) {
      if (command.atSnapshot === i) {
        commandSequence++;
        msg.writeByte(Svc.SERVERCOMMAND);
        msg.writeLong(commandSequence);
        msg.writeString(command.text);
      }
    }

    msg.writeByte(Svc.SNAPSHOT);
    msg.writeLong(snap.serverTime);
    // `deltaNum` is an OFFSET back from this message's sequence number, so
    // 1 means "the previous message" and 0 means "uncompressed".
    msg.writeByte(prev ? 1 : 0);
    msg.writeByte(0); // snapFlags
    msg.writeByte(0); // areamask length

    writeDeltaPlayerState(msg, prev ? prev.ps : null, snap.ps);

    // Packet entities: ascending by number, merged against the old frame.
    const oldEntities = prev ? prev.entities : [];
    const numbers = new Set<number>();
    for (const e of oldEntities) {
      numbers.add(e.number);
    }
    for (const e of snap.entities) {
      numbers.add(e.number);
    }
    for (const number of [...numbers].sort((a, b) => a - b)) {
      const from = oldEntities.find((e) => e.number === number);
      const to = snap.entities.find((e) => e.number === number);
      if (!to) {
        // gone: a delta-remove
        writeDeltaEntity(msg, from!, null, false);
        continue;
      }
      if (from) {
        // A `force` write, because the reader's sorted merge only carries an
        // entity over implicitly when the writer SKIPS its number entirely.
        // Writing every number explicitly keeps the test's intent legible.
        writeDeltaEntity(msg, from, to, true);
      } else {
        writeDeltaEntity(msg, baselineFor(number), to, true);
      }
    }
    msg.writeBits(MAX_GENTITIES - 1, 10); // end of packet entities

    msg.writeByte(Svc.EOF);
    chunks.push(frame(sequence, msg.bytes()));
    sequence++;
  }

  // --- the end marker ---
  if (!options.truncateTail) {
    const tail = new Uint8Array(8);
    const view = new DataView(tail.buffer);
    view.setInt32(0, sequence, true);
    view.setInt32(4, -1, true);
    chunks.push(tail);
  }

  let total = 0;
  for (const c of chunks) {
    total += c.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return options.truncateTail ? out.subarray(0, out.length - 12) : out;
}
