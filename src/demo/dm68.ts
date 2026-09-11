/**
 * Reading a Quake III Arena `.dm_68` demo.
 * Ported from Quake III Arena's code/client/cl_main.c and code/client/cl_parse.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A demo is not a recording of the game. It is a recording of the NETWORK
 * STREAM the game was told about -- the same server-to-client messages a live
 * client got, written to disk verbatim. So playing one back is not simulation
 * and never can be: the server already decided where everything was, twenty
 * times a second, and this file's whole job is to recover those decisions.
 * What happens between two of them is interpolation, which is `playback/`'s
 * problem, not this one's.
 *
 * ## The file
 *
 * `CL_WriteDemoMessage` / `CL_ReadDemoMessage`:
 *
 * ```
 * repeat:
 *   int32  sequence      the server message sequence number
 *   int32  length        -1 ends the demo
 *   byte   data[length]  one server message, Huffman-coded
 * ```
 *
 * The sequence number is not decoration. Snapshots delta against an older
 * snapshot addressed as `messageNum - deltaNum`, and `messageNum` IS the
 * file's sequence number for that message. Lose it and nothing after the
 * first uncompressed snapshot decodes.
 *
 * ## Decoding is one sequential pass, and only then random access
 *
 * `CL_ParseSnapshot` looks its delta parent up in a 32-entry ring
 * (`PACKET_MASK`). A snapshot cannot be decoded without its parent already
 * decoded, and its parent's ENTITIES cannot be recovered without the parent's
 * entity list, which is itself a delta. There is therefore no such thing as
 * seeking into a demo file: this reads the whole thing once, expands every
 * snapshot into a standalone entity list, and hands back an array. Everything
 * downstream indexes that array.
 *
 * The memory cost is real and bounded: a snapshot's entity list is a few
 * dozen `entityState_t` at 208 bytes each, twenty times a second. A
 * six-second DeFRaG run is nothing; a half-hour match is tens of megabytes,
 * and the answer then is to drop entity types the viewer never draws at
 * decode time -- not to make decode lazy, which the format does not allow.
 *
 * ## What is decoded
 *
 * `svc_gamestate` (configstrings and entity baselines), `svc_snapshot`,
 * `svc_serverCommand` (only far enough to apply a mid-demo `cs` -- a
 * configstring genuinely changes during a run, which is how a DeFRaG server
 * publishes a finish time), `svc_nop`, `svc_EOF`. `svc_download` in a demo is
 * an error; `svc_configstring`/`svc_baseline` appear only inside a gamestate.
 *
 * ## Protocol 68 only
 *
 * Anything else is refused by name. 66 and 67 (Q3 1.27 and 1.29) have
 * different netfield tables; 71/73 and the various mod protocols (CPMA, OSP)
 * have their own again. Each is a separate port, not a flag -- and a demo
 * decoded with the wrong table produces plausible garbage rather than an
 * error, which is exactly the failure worth refusing loudly.
 */

import { MsgReader, GENTITYNUM_BITS, MAX_GENTITIES } from './msg.js';
import {
  DemoPlayerState,
  EntityState,
  EMPTY_ENTITY_STATE,
  readDeltaEntity,
  readDeltaPlayerState,
} from './state.js';

/** `svc_ops_e`. */
export const enum Svc {
  BAD = 0,
  NOP = 1,
  GAMESTATE = 2,
  CONFIGSTRING = 3,
  BASELINE = 4,
  SERVERCOMMAND = 5,
  DOWNLOAD = 6,
  SNAPSHOT = 7,
  EOF = 8,
}

/** The protocol this reader understands. `.dm_68`'s 68. */
export const PROTOCOL_DM68 = 68;

export const MAX_CONFIGSTRINGS = 1024;
export const MAX_CLIENTS = 64;
export const MAX_MODELS = 256;
export const MAX_SOUNDS = 256;

/** Configstring indices (`q_shared.h`, `bg_public.h`). */
export const CS = {
  SERVERINFO: 0,
  SYSTEMINFO: 1,
  MUSIC: 2,
  MESSAGE: 3,
  MOTD: 4,
  WARMUP: 5,
  SCORES1: 6,
  SCORES2: 7,
  GAME_VERSION: 20,
  LEVEL_START_TIME: 21,
  INTERMISSION: 22,
  ITEMS: 27,
  MODELS: 32,
  SOUNDS: 32 + MAX_MODELS,
  PLAYERS: 32 + MAX_MODELS + MAX_SOUNDS,
} as const;

/** `PACKET_BACKUP` -- the snapshot ring a delta can reach back into. */
const PACKET_BACKUP = 32;
const PACKET_MASK = PACKET_BACKUP - 1;

/** `SNAPFLAG_*`. */
export const SNAPFLAG_RATE_DELAYED = 1;
export const SNAPFLAG_NOT_ACTIVE = 2;
/** The server restarted -- entities are not continuous across this. */
export const SNAPFLAG_SERVERCOUNT = 4;

/** One fully expanded snapshot. */
export interface DemoSnapshot {
  /** The demo file's sequence number for the message that carried it. */
  messageNum: number;
  /** Which snapshot this deltas from, or -1 for an uncompressed one. */
  deltaNum: number;
  snapFlags: number;
  /** Server time in milliseconds. The playback clock. */
  serverTime: number;
  ps: DemoPlayerState;
  /** Every entity the server said was visible, expanded -- not a delta. */
  entities: EntityState[];
  /** How many server commands had arrived by this snapshot, so a command can
   *  be attributed to a moment. */
  serverCommandNum: number;
}

/** A server command as it appeared, with the snapshot it arrived before. */
export interface DemoCommand {
  sequence: number;
  text: string;
  /** Index into `snapshots` of the first snapshot at or after this command. */
  atSnapshot: number;
}

export interface Dm68Demo {
  protocol: number;
  /** The POV client's index, from the gamestate. */
  clientNum: number;
  /** Configstrings as they were at the END of the demo -- see `configStringsAt`. */
  configStrings: (string | undefined)[];
  /** Configstrings exactly as the gamestate delivered them, before any
   *  mid-demo `cs` command changed one. */
  initialConfigStrings: (string | undefined)[];
  snapshots: DemoSnapshot[];
  commands: DemoCommand[];
  /** Messages that were read but not understood, by opcode. Diagnostic. */
  unknownOps: number[];
  /**
   * Whether decoding reached the end of the file cleanly.
   *
   * False means the demo was cut short -- a recorder killed mid-write, which
   * is an ordinary way for a demo to end, OR a decode that hit garbage and
   * kept what it had. The two are indistinguishable from inside, which is
   * exactly why this is surfaced: without it, "decoded the whole file" and
   * "died on message 4000 of 5740" look identical to a caller, and a test
   * asserting the former would silently pass for the latter.
   */
  complete: boolean;
  /** How many messages were decoded before stopping. */
  messagesRead: number;
  /** Why decoding stopped early, when it did. */
  stoppedBecause: string | null;
}

/**
 * Parse an info string -- `\key\value\key\value`, Quake's `Info_ValueForKey`
 * format, which is what `CS_SERVERINFO` and a player's configstring both are.
 *
 * Duplicate keys keep the FIRST, matching `Info_ValueForKey`'s scan-and-stop.
 */
export function parseInfoString(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = s.split('\\');
  // A leading backslash means parts[0] is empty; a string with no leading
  // backslash still pairs up correctly from index 0, which is why this walks
  // pairs rather than assuming the empty head.
  const start = parts[0] === '' ? 1 : 0;
  for (let i = start; i + 1 < parts.length; i += 2) {
    const key = parts[i];
    if (key && !(key in out)) {
      out[key] = parts[i + 1];
    }
  }
  return out;
}

/** `Info_ValueForKey`. */
export function infoValue(s: string, key: string): string {
  return parseInfoString(s)[key] ?? '';
}

/** Raised for a demo this reader will not attempt. */
export class DemoFormatError extends Error {}

/** One message's worth of framing, off the front of the file. */
interface RawMessage {
  sequence: number;
  data: Uint8Array;
}

/**
 * `CL_ReadDemoMessage`'s framing loop. Stops at a length of -1, at a
 * truncated tail, or at the end of the buffer -- all three are ordinary ways
 * for a demo to end (a player quitting mid-recording truncates), so none of
 * them throws.
 */
function* readMessages(buffer: Uint8Array, report: { endMarker: boolean; truncated: boolean }): Generator<RawMessage> {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let at = 0;
  for (;;) {
    if (at + 8 > buffer.length) {
      // Ran out mid-header. Only a clean end if we are exactly at the end.
      report.truncated = at !== buffer.length;
      return;
    }
    const sequence = view.getInt32(at, true);
    const length = view.getInt32(at + 4, true);
    at += 8;
    if (length === -1 || length < 0) {
      // The end-of-demo marker id writes on a clean stop.
      report.endMarker = true;
      return;
    }
    if (at + length > buffer.length) {
      // "Demo file was truncated." -- what has been read is still good, but
      // the caller deserves to know the file was cut off.
      report.truncated = true;
      return;
    }
    yield { sequence, data: buffer.subarray(at, at + length) };
    at += length;
  }
}

/**
 * The decoder's running state -- what `clc`/`cl` hold in the C, minus
 * everything to do with actually being connected to a server.
 */
class DemoParser {
  readonly configStrings: (string | undefined)[] = new Array<string | undefined>(
    MAX_CONFIGSTRINGS,
  ).fill(undefined);
  initialConfigStrings: (string | undefined)[] = [];
  readonly baselines: EntityState[] = [];
  /** `cl.snapshots[PACKET_BACKUP]`, the delta ring. */
  private readonly ring: (DemoSnapshot | null)[] = new Array<DemoSnapshot | null>(
    PACKET_BACKUP,
  ).fill(null);
  readonly snapshots: DemoSnapshot[] = [];
  readonly commands: DemoCommand[] = [];
  readonly unknownOps: number[] = [];
  clientNum = -1;
  protocol = 0;
  serverCommandSequence = 0;
  private sawGamestate = false;

  /** The sequence number of the message being parsed -- a snapshot's
   *  `messageNum`, and what its `deltaNum` is measured back from. */
  messageNum = 0;

  baseline(number: number): EntityState {
    return this.baselines[number] ?? EMPTY_ENTITY_STATE;
  }

  /** `CL_ParseServerMessage`. */
  parseMessage(msg: MsgReader): void {
    msg.bitstream();
    // reliableAcknowledge. Meaningless in a demo, but it is on the wire and
    // skipping it would misalign everything after.
    msg.readLong();

    for (;;) {
      if (msg.readcount > msg.cursize) {
        throw new DemoFormatError('read past end of server message');
      }
      const cmd = msg.readByte();
      if (cmd === Svc.EOF || cmd === -1) {
        return;
      }
      switch (cmd) {
        case Svc.NOP:
          break;
        case Svc.SERVERCOMMAND:
          this.parseCommandString(msg);
          break;
        case Svc.GAMESTATE:
          this.parseGamestate(msg);
          break;
        case Svc.SNAPSHOT:
          this.parseSnapshot(msg);
          break;
        case Svc.DOWNLOAD:
          throw new DemoFormatError('svc_download in a demo');
        default:
          // id calls this "Illegible server message" and drops the
          // connection. Same here: once the opcode stream is wrong, every
          // byte after it is too, so continuing would invent data.
          this.unknownOps.push(cmd);
          throw new DemoFormatError(`illegible server message: opcode ${cmd}`);
      }
    }
  }

  /** `CL_ParseCommandString`. */
  private parseCommandString(msg: MsgReader): void {
    const seq = msg.readLong();
    const text = msg.readString();
    if (this.serverCommandSequence >= seq) {
      return;
    }
    this.serverCommandSequence = seq;
    this.commands.push({ sequence: seq, text, atSnapshot: this.snapshots.length });
    this.applyCommand(text);
  }

  /**
   * The only server command that changes what playback shows: `cs <index>
   * "<value>"`, a configstring update.
   *
   * Everything else (`print`, `chat`, `scores`, `tinfo`, a mod's own) is kept
   * verbatim in `commands` and interpreted by nobody here. A demo viewer that
   * wants to show chat reads that list; this layer stays out of it.
   */
  private applyCommand(text: string): void {
    if (!text.startsWith('cs ')) {
      return;
    }
    const rest = text.slice(3).trimStart();
    const space = rest.indexOf(' ');
    if (space < 0) {
      return;
    }
    const index = Number.parseInt(rest.slice(0, space), 10);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_CONFIGSTRINGS) {
      return;
    }
    let value = rest.slice(space + 1);
    // `Cmd_TokenizeString` strips the quotes a `cs` command's value is sent
    // in. An unquoted value is left as-is.
    if (value.startsWith('"')) {
      const end = value.lastIndexOf('"');
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    }
    this.configStrings[index] = value;
  }

  /** `CL_ParseGamestate`. */
  private parseGamestate(msg: MsgReader): void {
    this.serverCommandSequence = msg.readLong();

    for (;;) {
      const cmd = msg.readByte();
      if (cmd === Svc.EOF || cmd === -1) {
        break;
      }
      if (cmd === Svc.CONFIGSTRING) {
        const i = msg.readShort();
        if (i < 0 || i >= MAX_CONFIGSTRINGS) {
          throw new DemoFormatError(`configstring index out of range: ${i}`);
        }
        this.configStrings[i] = msg.readBigString();
      } else if (cmd === Svc.BASELINE) {
        const newnum = msg.readBits(GENTITYNUM_BITS);
        if (newnum < 0 || newnum >= MAX_GENTITIES) {
          throw new DemoFormatError(`baseline number out of range: ${newnum}`);
        }
        const es = new EntityState();
        readDeltaEntity(msg, EMPTY_ENTITY_STATE, es, newnum);
        this.baselines[newnum] = es;
      } else {
        throw new DemoFormatError(`bad command byte in gamestate: ${cmd}`);
      }
    }

    this.clientNum = msg.readLong();
    // checksumFeed. Read and discarded: it exists so a client can verify its
    // own pak set, and nothing here loads paks.
    msg.readLong();

    // There is deliberately no protocol read here: the protocol number is NOT
    // in the stream. `CL_SystemInfoChanged` gets it from the connection, and a
    // demo gets it from its own file extension -- which is the whole reason
    // the extension carries it. `parseDm68` takes it as an argument for that
    // reason, rather than pretending to discover it.

    this.initialConfigStrings = [...this.configStrings];
    this.sawGamestate = true;
  }

  /** `CL_ParseSnapshot`. */
  private parseSnapshot(msg: MsgReader): void {
    if (!this.sawGamestate) {
      throw new DemoFormatError('snapshot before gamestate');
    }
    const serverTime = msg.readLong();
    const messageNum = this.messageNum;

    const deltaByte = msg.readByte();
    const deltaNum = deltaByte === 0 ? -1 : messageNum - deltaByte;
    const snapFlags = msg.readByte();

    let old: DemoSnapshot | null = null;
    if (deltaNum > 0) {
      const candidate = this.ring[deltaNum & PACKET_MASK];
      // id warns and carries on with an invalid parent, then throws the
      // snapshot away after reading it. Here the parent is either the right
      // one or there is nothing to delta from -- a demo that hits this is
      // corrupt in a way that would decode into nonsense, so it is refused.
      if (!candidate || candidate.messageNum !== deltaNum) {
        throw new DemoFormatError(
          `snapshot ${messageNum} deltas from ${deltaNum}, which is not in the ring`,
        );
      }
      old = candidate;
    }

    // areamask -- which areaportals are open. Read to stay aligned; playback
    // draws everything the server sent regardless.
    const areamaskLen = msg.readByte();
    msg.readData(areamaskLen);

    const ps = new DemoPlayerState();
    readDeltaPlayerState(msg, old ? old.ps : null, ps);

    const entities = this.parsePacketEntities(msg, old);

    const snap: DemoSnapshot = {
      messageNum,
      deltaNum,
      snapFlags,
      serverTime,
      ps,
      entities,
      serverCommandNum: this.serverCommandSequence,
    };

    // Clear the ring slots between the last snapshot and this one, so a gap
    // in the demo cannot be mistaken for a valid delta parent when the ring
    // wraps. id does this with a `valid` flag; nulling the slot is the same
    // thing with one fewer field.
    const last = this.snapshots[this.snapshots.length - 1];
    let oldMessageNum = (last ? last.messageNum : messageNum - 1) + 1;
    if (messageNum - oldMessageNum >= PACKET_BACKUP) {
      oldMessageNum = messageNum - (PACKET_BACKUP - 1);
    }
    for (; oldMessageNum < messageNum; oldMessageNum++) {
      this.ring[oldMessageNum & PACKET_MASK] = null;
    }

    this.ring[messageNum & PACKET_MASK] = snap;
    this.snapshots.push(snap);
  }

  /**
   * `CL_ParsePacketEntities`.
   *
   * The wire form is a sorted merge, not a list: entity numbers arrive in
   * ascending order, and every number in the OLD snapshot that the new one
   * skips past is implicitly unchanged and has to be carried over. Reading
   * only the numbers that appear on the wire gives a snapshot that loses
   * every entity that simply did not move -- which, on a speedrun map, is
   * most of them.
   *
   * **An unchanged entity is SHARED between snapshots, not copied.** That is
   * the one place this diverges from `CL_DeltaEntity`, which copies into a
   * ring buffer because a live client's ring gets overwritten. Nothing here
   * ever writes to a parsed `EntityState` again -- `readDeltaEntity` only
   * ever reads its `from` and writes a freshly allocated `to` -- so sharing
   * is invisible in the values and saves the large majority of the
   * allocations in a decode: a speedrun map's snapshot is mostly speakers and
   * triggers that never move, repeated at the snapshot rate for the whole
   * demo. Treat every `EntityState` reachable from a `Dm68Demo` as immutable;
   * clone before mutating.
   */
  private parsePacketEntities(msg: MsgReader, oldframe: DemoSnapshot | null): EntityState[] {
    const out: EntityState[] = [];
    const oldEntities = oldframe ? oldframe.entities : [];
    let oldindex = 0;
    const NONE = 99999;
    let oldstate: EntityState | null = oldEntities[0] ?? null;
    let oldnum = oldframe && oldstate ? oldstate.number : NONE;

    const advanceOld = (): void => {
      oldindex++;
      oldstate = oldEntities[oldindex] ?? null;
      oldnum = oldstate ? oldstate.number : NONE;
    };

    for (;;) {
      const newnum = msg.readBits(GENTITYNUM_BITS);
      if (newnum === MAX_GENTITIES - 1) {
        break;
      }
      if (msg.readcount > msg.cursize) {
        throw new DemoFormatError('end of message in packet entities');
      }

      while (oldnum < newnum) {
        // Unchanged: carried straight over. SHARED, not cloned -- see
        // `parsePacketEntities`'s own note on immutability.
        if (oldstate) {
          out.push(oldstate);
        }
        advanceOld();
      }

      if (oldnum === newnum) {
        // delta from the previous state
        const state = new EntityState();
        const removed = readDeltaEntity(msg, oldstate ?? EMPTY_ENTITY_STATE, state, newnum);
        if (!removed) {
          out.push(state);
        }
        advanceOld();
        continue;
      }

      // oldnum > newnum: delta from the baseline
      const state = new EntityState();
      const removed = readDeltaEntity(msg, this.baseline(newnum), state, newnum);
      if (!removed) {
        out.push(state);
      }
    }

    // anything left in the old frame is unchanged
    while (oldnum !== NONE) {
      if (oldstate) {
        out.push(oldstate);
      }
      advanceOld();
    }

    return out;
  }
}

/**
 * Read a whole `.dm_68` demo.
 *
 * @param buffer the file's bytes.
 * @param protocol which protocol the caller believes this is, normally from
 *   the `.dm_NN` extension. Anything but 68 is refused rather than attempted:
 *   see the file header.
 */
export function parseDm68(buffer: Uint8Array, protocol = PROTOCOL_DM68): Dm68Demo {
  if (protocol !== PROTOCOL_DM68) {
    throw new DemoFormatError(
      `protocol ${protocol} is not supported -- this reader is protocol 68 (.dm_68) only`,
    );
  }

  const parser = new DemoParser();
  let messages = 0;
  const framing = { endMarker: false, truncated: false };
  let stoppedBecause: string | null = null;

  for (const raw of readMessages(buffer, framing)) {
    parser.messageNum = raw.sequence;
    const msg = new MsgReader(raw.data);
    try {
      parser.parseMessage(msg);
    } catch (err) {
      if (messages === 0) {
        // Nothing decoded at all: the file is not a protocol 68 demo, or is
        // not a demo. Say so rather than handing back an empty one.
        throw err;
      }
      // A demo truncated mid-message (the recorder was killed) is common and
      // everything before the break is still good. Stop, keep what parsed --
      // but record WHY, so a caller can tell this apart from a clean decode.
      stoppedBecause = err instanceof Error ? err.message : String(err);
      break;
    }
    messages++;
  }
  if (!stoppedBecause && framing.truncated) {
    stoppedBecause = 'file ends mid-message';
  }
  if (!stoppedBecause && !framing.endMarker) {
    stoppedBecause = 'no end-of-demo marker';
  }

  if (parser.clientNum < 0) {
    throw new DemoFormatError('no gamestate in demo');
  }

  /*
   * Cross-check against what the SERVER said the protocol was.
   *
   * `CS_SERVERINFO` carries a `protocol` key (Q3 puts `com_protocol` in the
   * serverinfo; the sample DeFRaG demo has `protocol\68`). It is not how the
   * protocol is decided -- the file extension is, which is why `protocol` is
   * an argument -- but a demo that decoded far enough to have configstrings
   * and then disagrees about its own protocol is a demo being read with the
   * wrong netfield tables. That failure is otherwise silent: wrong tables
   * still parse, still produce snapshots, and fill them with nonsense.
   *
   * Absent is fine and common. Only a stated mismatch is refused.
   */
  const stated = Number.parseInt(infoValue(parser.configStrings[CS.SERVERINFO] ?? '', 'protocol'), 10);
  if (Number.isInteger(stated) && stated !== protocol) {
    throw new DemoFormatError(
      `demo says protocol ${stated} but is being read as ${protocol} -- ` +
        `the netfield tables differ between protocols, so this would decode into nonsense`,
    );
  }

  return {
    protocol,
    clientNum: parser.clientNum,
    configStrings: parser.configStrings,
    initialConfigStrings: parser.initialConfigStrings,
    snapshots: parser.snapshots,
    commands: parser.commands,
    unknownOps: parser.unknownOps,
    complete: stoppedBecause === null,
    messagesRead: messages,
    stoppedBecause,
  };
}

/**
 * The configstrings as they stood at `snapshotIndex`, replaying the `cs`
 * commands that had arrived by then over the gamestate's originals.
 *
 * The plain `configStrings` field is the END state, which is what a library
 * listing wants (a DeFRaG finish time is published near the end of a run).
 * Anything drawn DURING playback -- a scoreboard, a warmup notice -- wants
 * this instead.
 */
export function configStringsAt(demo: Dm68Demo, snapshotIndex: number): (string | undefined)[] {
  const out = [...demo.initialConfigStrings];
  for (const command of demo.commands) {
    if (command.atSnapshot > snapshotIndex) {
      break;
    }
    if (!command.text.startsWith('cs ')) {
      continue;
    }
    const rest = command.text.slice(3).trimStart();
    const space = rest.indexOf(' ');
    if (space < 0) {
      continue;
    }
    const index = Number.parseInt(rest.slice(0, space), 10);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_CONFIGSTRINGS) {
      continue;
    }
    let value = rest.slice(space + 1);
    if (value.startsWith('"')) {
      const end = value.lastIndexOf('"');
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    }
    out[index] = value;
  }
  return out;
}
