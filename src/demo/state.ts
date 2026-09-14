/**
 * `entityState_t` and `playerState_t` as they arrive over the wire, and the
 * delta coders that read them.
 * Ported from Quake III Arena's code/qcommon/msg.c and code/game/bg_public.h.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ## Why these are word arrays and not objects with fields
 *
 * The C delta coder does not know what any field means. It walks a table of
 * `(offset, bits)` pairs, compares `*(int*)(from + offset)` against
 * `*(int*)(to + offset)`, and copies ints -- reinterpreting the same four
 * bytes as a float only where the table says `bits == 0`. Two of its
 * behaviours fall straight out of that and would have to be re-created by
 * hand in any field-per-property port:
 *
 *  - **Unsent fields are copied verbatim**, including the ones past `lc`
 *    (the change count), as raw ints. A float field carried forward this way
 *    keeps its exact bit pattern, NaNs and all.
 *  - **A float field's "no change" test is an INT comparison.** `-0.0` and
 *    `0.0` are different words and so count as a change; two NaNs with the
 *    same payload count as no change. Comparing them as floats would get both
 *    backwards.
 *
 * So the state is an `Int32Array` with a `Float32Array` view over the same
 * buffer, exactly as the C struct is, and `netfields.ts` maps each name to a
 * slot. The named getters below are a reading convenience on top; nothing in
 * the delta path uses them.
 *
 * ## The two delta readers are not the same function
 *
 * They look alike and they differ in a way that decodes into plausible
 * nonsense if conflated:
 *
 * | | entityState | playerState |
 * | --- | --- | --- |
 * | float field | zero bit, then integral-vs-full bit | integral-vs-full bit only |
 * | integer field | zero bit, then the value | the value |
 * | trailing fields | copied from `from` | copied from `from` |
 * | arrays | none | stats/persistant/ammo/powerups, separately |
 *
 * The entity reader also has two envelope cases before any of that: a remove
 * (number becomes `MAX_GENTITIES - 1`) and a no-delta (`to = from`).
 */

import { FLOAT_INT_BIAS, FLOAT_INT_BITS, MAX_GENTITIES } from './msg.js';
import type { MsgReader, MsgWriter } from './msg.js';
import { ENTITY_FIELDS, ENTITY_SLOTS, ES, PLAYER_FIELDS, PLAYER_SLOTS, PS } from './netfields.js';

/** `entityType_t`. */
/**
 * `SOLID_BMODEL` -- `q_shared.h:1259`, with its own comment one line above:
 * "if entityState->solid == SOLID_BMODEL, modelindex is an inline model
 * number". It is the sentinel that decides which of two model lists
 * `modelindex` points into, not a collision flag to be read as one.
 */
export const SOLID_BMODEL = 0xffffff;

export const enum EntityType {
  GENERAL = 0,
  PLAYER = 1,
  ITEM = 2,
  MISSILE = 3,
  MOVER = 4,
  BEAM = 5,
  PORTAL = 6,
  SPEAKER = 7,
  PUSH_TRIGGER = 8,
  TELEPORT_TRIGGER = 9,
  INVISIBLE = 10,
  GRAPPLE = 11,
  TEAM = 12,
  /** `eType >= ET_EVENTS` is a freestanding event, `eType - ET_EVENTS` being
   *  the event number. Not a drawable entity. */
  EVENTS = 13,
}

/**
 * `weapon_t` -- Quake's numbering, which is NOT Overbounce's `Weapon`.
 *
 * Kept as its own enum precisely so the two cannot be confused: Overbounce
 * has `SHOTGUN = 6` where Quake has `WP_SHOTGUN = 3`, and a demo decoded
 * straight into `Weapon` would arm every recording with the wrong gun. The
 * mapping happens once, explicitly, in `playback/`.
 */
export const enum Q3Weapon {
  NONE = 0,
  GAUNTLET = 1,
  MACHINEGUN = 2,
  SHOTGUN = 3,
  GRENADE_LAUNCHER = 4,
  ROCKET_LAUNCHER = 5,
  LIGHTNING = 6,
  RAILGUN = 7,
  PLASMAGUN = 8,
  BFG = 9,
  GRAPPLING_HOOK = 10,
}

/** One `trajectory_t`, read out of a state's slots. */
export interface WireTrajectory {
  trType: number;
  trTime: number;
  trDuration: number;
  trBase: [number, number, number];
  trDelta: [number, number, number];
}

/**
 * A state's storage: ints and floats over one buffer, the way the C struct
 * is. Shared by both state types because the delta coder treats them
 * identically.
 */
class WireState {
  readonly words: Int32Array;
  readonly floats: Float32Array;

  constructor(slots: number) {
    const buffer = new ArrayBuffer(slots * 4);
    this.words = new Int32Array(buffer);
    this.floats = new Float32Array(buffer);
  }

  /** `Com_Memset(to, 0, sizeof(*to))`. */
  clear(): void {
    this.words.fill(0);
  }

  /** `*to = *from`. */
  copyFrom(other: WireState): void {
    this.words.set(other.words);
  }
}

/** `entityState_t`. */
export class EntityState extends WireState {
  constructor() {
    super(ENTITY_SLOTS);
  }

  clone(): EntityState {
    const out = new EntityState();
    out.copyFrom(this);
    return out;
  }

  get number(): number {
    return this.words[ES.number];
  }

  set number(v: number) {
    this.words[ES.number] = v;
  }

  get eType(): number {
    return this.words[ES.eType];
  }

  get eFlags(): number {
    return this.words[ES.eFlags];
  }

  get clientNum(): number {
    return this.words[ES.clientNum];
  }

  get weapon(): number {
    return this.words[ES.weapon];
  }

  get modelindex(): number {
    return this.words[ES.modelindex];
  }

  get modelindex2(): number {
    return this.words[ES.modelindex2];
  }

  get frame(): number {
    return this.words[ES.frame];
  }

  get legsAnim(): number {
    return this.words[ES.legsAnim];
  }

  get torsoAnim(): number {
    return this.words[ES.torsoAnim];
  }

  get groundEntityNum(): number {
    return this.words[ES.groundEntityNum];
  }

  get event(): number {
    return this.words[ES.event];
  }

  get eventParm(): number {
    return this.words[ES.eventParm];
  }

  get otherEntityNum(): number {
    return this.words[ES.otherEntityNum];
  }

  get otherEntityNum2(): number {
    return this.words[ES.otherEntityNum2];
  }

  get constantLight(): number {
    return this.words[ES.constantLight];
  }

  get loopSound(): number {
    return this.words[ES.loopSound];
  }

  get powerups(): number {
    return this.words[ES.powerups];
  }

  get generic1(): number {
    return this.words[ES.generic1];
  }

  get solid(): number {
    return this.words[ES.solid];
  }

  get time(): number {
    return this.words[ES.time];
  }

  get time2(): number {
    return this.words[ES.time2];
  }

  /** `es.origin`. NOT the drawn position for a moving entity -- that comes
   *  from evaluating `pos` at the current time. */
  get origin(): [number, number, number] {
    return [this.floats[ES.origin_0], this.floats[ES.origin_1], this.floats[ES.origin_2]];
  }

  get origin2(): [number, number, number] {
    return [this.floats[ES.origin2_0], this.floats[ES.origin2_1], this.floats[ES.origin2_2]];
  }

  get angles(): [number, number, number] {
    return [this.floats[ES.angles_0], this.floats[ES.angles_1], this.floats[ES.angles_2]];
  }

  get angles2(): [number, number, number] {
    return [this.floats[ES.angles2_0], this.floats[ES.angles2_1], this.floats[ES.angles2_2]];
  }

  /** `es.pos` -- position over time. */
  get pos(): WireTrajectory {
    return {
      trType: this.words[ES.pos_trType],
      trTime: this.words[ES.pos_trTime],
      trDuration: this.words[ES.pos_trDuration],
      trBase: [
        this.floats[ES.pos_trBase_0],
        this.floats[ES.pos_trBase_1],
        this.floats[ES.pos_trBase_2],
      ],
      trDelta: [
        this.floats[ES.pos_trDelta_0],
        this.floats[ES.pos_trDelta_1],
        this.floats[ES.pos_trDelta_2],
      ],
    };
  }

  /** `es.apos` -- angles over time. */
  get apos(): WireTrajectory {
    return {
      trType: this.words[ES.apos_trType],
      trTime: this.words[ES.apos_trTime],
      trDuration: this.words[ES.apos_trDuration],
      trBase: [
        this.floats[ES.apos_trBase_0],
        this.floats[ES.apos_trBase_1],
        this.floats[ES.apos_trBase_2],
      ],
      trDelta: [
        this.floats[ES.apos_trDelta_0],
        this.floats[ES.apos_trDelta_1],
        this.floats[ES.apos_trDelta_2],
      ],
    };
  }
}

/** `MAX_STATS` and friends -- all four arrays are 16 long. */
export const PS_ARRAY_LENGTH = 16;

/** `playerState_t`, the POV client's own state in every snapshot. */
export class DemoPlayerState extends WireState {
  readonly stats = new Int32Array(PS_ARRAY_LENGTH);
  readonly persistant = new Int32Array(PS_ARRAY_LENGTH);
  readonly ammo = new Int32Array(PS_ARRAY_LENGTH);
  readonly powerups = new Int32Array(PS_ARRAY_LENGTH);

  constructor() {
    super(PLAYER_SLOTS);
  }

  clone(): DemoPlayerState {
    const out = new DemoPlayerState();
    out.copyFrom(this);
    out.stats.set(this.stats);
    out.persistant.set(this.persistant);
    out.ammo.set(this.ammo);
    out.powerups.set(this.powerups);
    return out;
  }

  get commandTime(): number {
    return this.words[PS.commandTime];
  }

  get pm_type(): number {
    return this.words[PS.pm_type];
  }

  get pm_flags(): number {
    return this.words[PS.pm_flags];
  }

  get pm_time(): number {
    return this.words[PS.pm_time];
  }

  get bobCycle(): number {
    return this.words[PS.bobCycle];
  }

  get weapon(): number {
    return this.words[PS.weapon];
  }

  get weaponstate(): number {
    return this.words[PS.weaponstate];
  }

  get weaponTime(): number {
    return this.words[PS.weaponTime];
  }

  get legsAnim(): number {
    return this.words[PS.legsAnim];
  }

  get torsoAnim(): number {
    return this.words[PS.torsoAnim];
  }

  get movementDir(): number {
    return this.words[PS.movementDir];
  }

  get groundEntityNum(): number {
    return this.words[PS.groundEntityNum];
  }

  get clientNum(): number {
    return this.words[PS.clientNum];
  }

  get eFlags(): number {
    return this.words[PS.eFlags];
  }

  get eventSequence(): number {
    return this.words[PS.eventSequence];
  }

  get externalEvent(): number {
    return this.words[PS.externalEvent];
  }

  get externalEventParm(): number {
    return this.words[PS.externalEventParm];
  }

  get gravity(): number {
    return this.words[PS.gravity];
  }

  get speed(): number {
    return this.words[PS.speed];
  }

  get viewheight(): number {
    return this.words[PS.viewheight];
  }

  get jumppad_ent(): number {
    return this.words[PS.jumppad_ent];
  }

  /** `ps.events[MAX_PS_EVENTS]`. */
  get events(): [number, number] {
    return [this.words[PS.events_0], this.words[PS.events_1]];
  }

  get eventParms(): [number, number] {
    return [this.words[PS.eventParms_0], this.words[PS.eventParms_1]];
  }

  get origin(): [number, number, number] {
    return [this.floats[PS.origin_0], this.floats[PS.origin_1], this.floats[PS.origin_2]];
  }

  get velocity(): [number, number, number] {
    return [this.floats[PS.velocity_0], this.floats[PS.velocity_1], this.floats[PS.velocity_2]];
  }

  get viewangles(): [number, number, number] {
    return [
      this.floats[PS.viewangles_0],
      this.floats[PS.viewangles_1],
      this.floats[PS.viewangles_2],
    ];
  }

  get delta_angles(): [number, number, number] {
    return [
      this.words[PS.delta_angles_0],
      this.words[PS.delta_angles_1],
      this.words[PS.delta_angles_2],
    ];
  }

  get grapplePoint(): [number, number, number] {
    return [
      this.floats[PS.grapplePoint_0],
      this.floats[PS.grapplePoint_1],
      this.floats[PS.grapplePoint_2],
    ];
  }
}

/**
 * `MSG_ReadDeltaEntity`.
 *
 * The entity number has already been read by the caller -- that is how `from`
 * was found -- so it comes in as an argument rather than off the wire.
 *
 * Returns true if the entity was REMOVED, which the caller has to distinguish
 * from a normal update: id signals it by setting `to->number` to
 * `MAX_GENTITIES - 1` and leaving the rest zeroed, and `CL_ParsePacketEntities`
 * then simply does not add it to the new snapshot.
 */
export function readDeltaEntity(
  msg: MsgReader,
  from: EntityState,
  to: EntityState,
  number: number,
): boolean {
  if (number < 0 || number >= MAX_GENTITIES) {
    throw new Error(`Bad delta entity number: ${number}`);
  }

  // check for a remove
  if (msg.readBits(1) === 1) {
    to.clear();
    to.number = MAX_GENTITIES - 1;
    return true;
  }

  // check for no delta
  if (msg.readBits(1) === 0) {
    to.copyFrom(from);
    to.number = number;
    return false;
  }

  const lc = msg.readByte();
  to.number = number;

  for (let i = 0; i < lc; i++) {
    const field = ENTITY_FIELDS[i];
    const slot = field.slot;
    if (!msg.readBits(1)) {
      // no change
      to.words[slot] = from.words[slot];
      continue;
    }
    if (field.bits === 0) {
      // Float. Nested rather than chained as `else if`, matching the C:
      // each `readBits(1)` CONSUMES a bit, so the two tests are reading
      // different bits and flattening them would read the same one twice.
      if (msg.readBits(1) === 0) {
        to.floats[slot] = 0;
      } else {
        if (msg.readBits(1) === 0) {
          // integral float, biased so the range covers both signs
          const trunc = msg.readBits(FLOAT_INT_BITS) - FLOAT_INT_BIAS;
          to.floats[slot] = trunc;
        } else {
          // full floating point value, as a raw word
          to.words[slot] = msg.readBits(32);
        }
      }
    } else {
      if (msg.readBits(1) === 0) {
        to.words[slot] = 0;
      } else {
        to.words[slot] = msg.readBits(field.bits);
      }
    }
  }
  // Everything past the change count is carried forward untouched.
  for (let i = lc; i < ENTITY_FIELDS.length; i++) {
    const slot = ENTITY_FIELDS[i].slot;
    to.words[slot] = from.words[slot];
  }
  return false;
}

/**
 * `MSG_ReadDeltaPlayerstate`.
 *
 * `from` may be null (`&dummy`, zeroed) on the first snapshot of a demo.
 */
export function readDeltaPlayerState(
  msg: MsgReader,
  from: DemoPlayerState | null,
  to: DemoPlayerState,
): void {
  const base = from ?? EMPTY_PLAYER_STATE;
  to.copyFrom(base);
  to.stats.set(base.stats);
  to.persistant.set(base.persistant);
  to.ammo.set(base.ammo);
  to.powerups.set(base.powerups);

  const lc = msg.readByte();

  for (let i = 0; i < lc; i++) {
    const field = PLAYER_FIELDS[i];
    const slot = field.slot;
    if (!msg.readBits(1)) {
      to.words[slot] = base.words[slot];
      continue;
    }
    if (field.bits === 0) {
      // Float -- and note there is NO zero case here, unlike the entity
      // reader. See the file header's table.
      if (msg.readBits(1) === 0) {
        const trunc = msg.readBits(FLOAT_INT_BITS) - FLOAT_INT_BIAS;
        to.floats[slot] = trunc;
      } else {
        to.words[slot] = msg.readBits(32);
      }
    } else {
      // Integer -- again with no zero case.
      to.words[slot] = msg.readBits(field.bits);
    }
  }
  for (let i = lc; i < PLAYER_FIELDS.length; i++) {
    const slot = PLAYER_FIELDS[i].slot;
    to.words[slot] = base.words[slot];
  }

  // the arrays, each behind its own changed bit
  if (msg.readBits(1)) {
    if (msg.readBits(1)) {
      const bits = msg.readShort();
      for (let i = 0; i < PS_ARRAY_LENGTH; i++) {
        if (bits & (1 << i)) {
          to.stats[i] = msg.readShort();
        }
      }
    }
    if (msg.readBits(1)) {
      const bits = msg.readShort();
      for (let i = 0; i < PS_ARRAY_LENGTH; i++) {
        if (bits & (1 << i)) {
          to.persistant[i] = msg.readShort();
        }
      }
    }
    if (msg.readBits(1)) {
      const bits = msg.readShort();
      for (let i = 0; i < PS_ARRAY_LENGTH; i++) {
        if (bits & (1 << i)) {
          to.ammo[i] = msg.readShort();
        }
      }
    }
    if (msg.readBits(1)) {
      // The powerups bitmask is read as a SHORT and each entry as a LONG --
      // powerups hold absolute expiry times, not durations.
      const bits = msg.readShort();
      for (let i = 0; i < PS_ARRAY_LENGTH; i++) {
        if (bits & (1 << i)) {
          to.powerups[i] = msg.readLong();
        }
      }
    }
  }
}

/** The zeroed `playerState_t` a first snapshot deltas against (`&dummy`). */
const EMPTY_PLAYER_STATE = new DemoPlayerState();

/** A zeroed `entityState_t`, for a baseline that was never sent. */
export const EMPTY_ENTITY_STATE = new EntityState();

/**
 * `MSG_WriteDeltaEntity`. Test-only, like `MsgWriter` -- see `msg.ts`.
 *
 * `to === null` is the delta-remove message.
 */
export function writeDeltaEntity(
  msg: MsgWriter,
  from: EntityState,
  to: EntityState | null,
  force: boolean,
): void {
  if (to === null) {
    msg.writeBits(from.number, 10);
    msg.writeBits(1, 1);
    return;
  }

  let lc = 0;
  for (let i = 0; i < ENTITY_FIELDS.length; i++) {
    const slot = ENTITY_FIELDS[i].slot;
    if (from.words[slot] !== to.words[slot]) {
      lc = i + 1;
    }
  }

  if (lc === 0) {
    if (!force) {
      return;
    }
    msg.writeBits(to.number, 10);
    msg.writeBits(0, 1);
    msg.writeBits(0, 1);
    return;
  }

  msg.writeBits(to.number, 10);
  msg.writeBits(0, 1);
  msg.writeBits(1, 1);
  msg.writeByte(lc);

  for (let i = 0; i < lc; i++) {
    const field = ENTITY_FIELDS[i];
    const slot = field.slot;
    if (from.words[slot] === to.words[slot]) {
      msg.writeBits(0, 1);
      continue;
    }
    msg.writeBits(1, 1);
    if (field.bits === 0) {
      const fullFloat = to.floats[slot];
      const trunc = Math.trunc(fullFloat);
      if (fullFloat === 0) {
        msg.writeBits(0, 1);
      } else {
        msg.writeBits(1, 1);
        if (
          trunc === fullFloat &&
          trunc + FLOAT_INT_BIAS >= 0 &&
          trunc + FLOAT_INT_BIAS < 1 << FLOAT_INT_BITS
        ) {
          msg.writeBits(0, 1);
          msg.writeBits(trunc + FLOAT_INT_BIAS, FLOAT_INT_BITS);
        } else {
          msg.writeBits(1, 1);
          msg.writeBits(to.words[slot], 32);
        }
      }
    } else {
      if (to.words[slot] === 0) {
        msg.writeBits(0, 1);
      } else {
        msg.writeBits(1, 1);
        msg.writeBits(to.words[slot], field.bits);
      }
    }
  }
}

/** `MSG_WriteDeltaPlayerstate`. Test-only. */
export function writeDeltaPlayerState(
  msg: MsgWriter,
  from: DemoPlayerState | null,
  to: DemoPlayerState,
): void {
  const base = from ?? EMPTY_PLAYER_STATE;

  let lc = 0;
  for (let i = 0; i < PLAYER_FIELDS.length; i++) {
    const slot = PLAYER_FIELDS[i].slot;
    if (base.words[slot] !== to.words[slot]) {
      lc = i + 1;
    }
  }

  msg.writeByte(lc);

  for (let i = 0; i < lc; i++) {
    const field = PLAYER_FIELDS[i];
    const slot = field.slot;
    if (base.words[slot] === to.words[slot]) {
      msg.writeBits(0, 1);
      continue;
    }
    msg.writeBits(1, 1);
    if (field.bits === 0) {
      const fullFloat = to.floats[slot];
      const trunc = Math.trunc(fullFloat);
      if (
        trunc === fullFloat &&
        trunc + FLOAT_INT_BIAS >= 0 &&
        trunc + FLOAT_INT_BIAS < 1 << FLOAT_INT_BITS
      ) {
        msg.writeBits(0, 1);
        msg.writeBits(trunc + FLOAT_INT_BIAS, FLOAT_INT_BITS);
      } else {
        msg.writeBits(1, 1);
        msg.writeBits(to.words[slot], 32);
      }
    } else {
      msg.writeBits(to.words[slot], field.bits);
    }
  }

  let statsbits = 0;
  let persistantbits = 0;
  let ammobits = 0;
  let powerupbits = 0;
  for (let i = 0; i < PS_ARRAY_LENGTH; i++) {
    if (to.stats[i] !== base.stats[i]) {
      statsbits |= 1 << i;
    }
    if (to.persistant[i] !== base.persistant[i]) {
      persistantbits |= 1 << i;
    }
    if (to.ammo[i] !== base.ammo[i]) {
      ammobits |= 1 << i;
    }
    if (to.powerups[i] !== base.powerups[i]) {
      powerupbits |= 1 << i;
    }
  }

  if (!statsbits && !persistantbits && !ammobits && !powerupbits) {
    msg.writeBits(0, 1);
    return;
  }
  msg.writeBits(1, 1);

  writeArray(msg, statsbits, to.stats, false);
  writeArray(msg, persistantbits, to.persistant, false);
  writeArray(msg, ammobits, to.ammo, false);
  writeArray(msg, powerupbits, to.powerups, true);
}

function writeArray(msg: MsgWriter, bits: number, values: Int32Array, long: boolean): void {
  if (!bits) {
    msg.writeBits(0, 1);
    return;
  }
  msg.writeBits(1, 1);
  msg.writeShort(bits);
  for (let i = 0; i < PS_ARRAY_LENGTH; i++) {
    if (bits & (1 << i)) {
      if (long) {
        msg.writeLong(values[i]);
      } else {
        msg.writeShort(values[i]);
      }
    }
  }
}
