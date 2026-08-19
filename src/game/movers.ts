/**
 * Binary movers: `func_door` and `func_button`.
 * Ported from Quake III Arena's code/game/g_mover.c, plus `G_FindTeams` from
 * code/game/g_main.c and `G_SetMovedir` from code/game/g_utils.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ---------------------------------------------------------------------------
 * WHAT A DOOR ACTUALLY IS
 * ---------------------------------------------------------------------------
 * A `func_door` is not one feature. It is five that interlock, and skipping any
 * one of them leaves a door that looks finished and is not:
 *
 *  1. A *brush submodel* that has to be solid. It is not in the world BSP tree,
 *     so the trace has to be told about it — `src/collision/clip.ts`.
 *  2. A *trajectory*, so its position is a closed-form function of level time
 *     rather than something integrated per frame — `src/game/trajectory.ts`.
 *  3. A *binary mover state machine* shared with `func_button`: pos1, pos2, and
 *     the two transitions, which can be reversed mid-flight.
 *  4. An *auto-generated touch trigger*, spawned 100ms after the map loads,
 *     which is the only reason walking at a door opens it. A door with a
 *     `targetname` gets no trigger at all and can only be opened by whatever
 *     targets it.
 *  5. *Pushing*: the mover carries or crushes whatever is in its way, and backs
 *     itself out of the move entirely if it cannot.
 *
 * Which of those a map needs is not a matter of taste — see
 * `.agent/plans/DOORS.md` for the entity census that set the scope, and for the
 * list of what is deliberately absent (`func_plat`, `func_train`, shootable
 * movers, rotating solids).
 *
 * ---------------------------------------------------------------------------
 * SHAPE OF THE PORT
 * ---------------------------------------------------------------------------
 * id dispatches through function pointers on `gentity_t` (`think`, `touch`,
 * `use`, `blocked`, `reached`). Those are kept as string-tagged enums rather
 * than closures so the state is plain data, comparable in a test and printable
 * in a dump. Everything else keeps id's names and id's ordering.
 */

import type { Vec3 } from '../math/vec3.js';
import {
  vec3,
  vectorAdd,
  vectorCopy,
  vectorLength,
  vectorMA,
  vectorScale,
  vectorSubtract,
} from '../math/vec3.js';
import { angleVectors } from '../math/angles.js';
import type { ClipEntity } from '../collision/clip.js';
import { traceWithEntities } from '../collision/clip.js';
import type { CollisionModel } from '../collision/model.js';
import { MASK_PLAYERSOLID } from '../physics/constants.js';
import type { PlayerState, TraceResult } from '../physics/types.js';
import { createTrace } from '../physics/types.js';
import type { MapEntity } from './entities.js';
import { entityFloat } from './entities.js';
import type { Trajectory } from './trajectory.js';
import { TrType, createTrajectory, evaluateTrajectory } from './trajectory.js';

const fround = Math.fround;

/** `moverState_t`. */
export const enum MoverState {
  POS1 = 0,
  POS2 = 1,
  ONETOTWO = 2,
  TWOTOONE = 3,
}

/**
 * `SP_func_door`'s spawnflags. Only these two exist in code.
 *
 * The `/*QUAKED*` + `/` comment above `SP_func_door` also describes TOGGLE and
 * NOMONSTER, but nothing reads either bit — the flag list in that comment is
 * literally `? START_OPEN x CRUSHER`, and `x` is bit 2. Do not add a TOGGLE
 * branch on the strength of the documentation.
 */
const START_OPEN = 1;
const CRUSHER = 4;

/** `FRAMETIME` from g_local.h — one 10Hz server frame, in milliseconds. */
const FRAMETIME = 100;

/** The pending `ent->think`, as a tag rather than a function pointer. */
const enum MoverThink {
  NONE = 0,
  RETURN_TO_POS1 = 1,
  SPAWN_NEW_DOOR_TRIGGER = 2,
  MATCH_TEAM = 3,
}

/** The auto-generated `door_trigger` from `Think_SpawnNewDoorTrigger`. */
export interface DoorTrigger {
  mins: Vec3;
  maxs: Vec3;
  /** `other->count` — the thinnest axis, remembered but only used by the
   *  spectator branch, which is not ported. Kept because it is free and it
   *  documents which axis was expanded. */
  count: number;
}

/** One `func_door` or `func_button`. `gentity_t`, cut down to what movers use. */
export interface Mover {
  /** `s.number`. Stamped on traces so ground/touch bookkeeping can find it. */
  entityNum: number;
  entity: MapEntity;
  /** `s.modelindex` — index into `CollisionModel.submodels`. */
  submodel: number;

  /** `r.mins` / `r.maxs` from `CM_ModelBounds`. Already spread by a pixel by
   *  `CMod_LoadSubmodels`, which is why a door travels 2 units further than its
   *  brush is wide. */
  mins: Vec3;
  maxs: Vec3;

  pos1: Vec3;
  pos2: Vec3;
  movedir: Vec3;
  /** `s.pos`. */
  pos: Trajectory;
  /** `r.currentOrigin`. Shared by reference with the ClipEntity. */
  currentOrigin: Vec3;

  moverState: MoverState;
  speed: number;
  /** Already multiplied by 1000 — `ent->wait *= 1000` in the spawn function. */
  wait: number;
  /** `ent->damage`, the crush damage. */
  damage: number;
  spawnflags: number;

  think: MoverThink;
  nextthink: number;

  /** `G_FindTeams` chain. The master is the head; slaves hang off teamchain. */
  teamchain: Mover | null;
  teammaster: Mover | null;
  /** `FL_TEAMSLAVE`. */
  teamslave: boolean;

  /** Promoted from a slave by `G_FindTeams` if the slave carried it. */
  targetname: string | null;
  target: string | null;

  /** Only a door with no targetname and no health gets one. */
  trigger: DoorTrigger | null;

  /**
   * `G_SoundIndex` paths, as `.wav` names rather than indices.
   *
   * Quake registers these into a numbered table and sends the number; there is
   * no such table here, so the path IS the handle. Null where id leaves the
   * field zero -- and that matters: `SP_func_button` sets `sound1to2` ONLY
   * (g_mover.c:1204), so a button clicks when it is pressed and is silent when
   * it returns. A door sets all four (g_mover.c:952).
   */
  sound1to2: string | null;
  sound2to1: string | null;
  soundPos1: string | null;
  soundPos2: string | null;
}

/** The one thing a mover can push. Overbounce has exactly one: the player. */
export interface PushTarget {
  entityNum: number;
  /** `client->ps` — pushed by writing `ps.origin` directly, as id does. */
  ps: PlayerState;
  mins: Vec3;
  maxs: Vec3;
  /**
   * `check->s.groundEntityNum` — the *entityState*, not the playerState.
   *
   * `G_TryPushingEntity` clears this to -1 when it pushes someone who was not
   * riding ("may have pushed them off an edge"), and it is worth being precise
   * about what that does: it writes the entityState, which
   * `BG_PlayerStateToEntityState` overwrites from `ps.groundEntityNum` at the
   * end of every frame. So it never reaches pmove and never makes the player
   * fall; it only affects a second `G_MoverPush` within the same frame, which
   * is what a multi-part door team is. Ported as its own field for that reason
   * — merging it into `ps.groundEntityNum` would be a behaviour change.
   */
  groundEntityNum: number;
}

/** What `G_UseTargets` fires, reported out so the Game can react. */
export interface MoverEvent {
  kind: 'reached' | 'used' | 'sound';
  /** Set for `sound`: the `.wav` path to play. */
  sound?: string;
  /**
   * Set for `sound`: where it comes from, in Q3 coordinates.
   *
   * `G_AddEvent` puts the event on the ENTITY, and the client plays it at
   * `cent->lerpOrigin` -- so a door at the far end of the map is quiet. The
   * mover's own current origin is that point.
   */
  origin?: [number, number, number];
  entityNum: number;
  /** The mover's own `target`, for `reached` — its targets fire on arrival. */
  target: string | null;
  time: number;
}

const MOVER_CLASSNAMES = ['func_door', 'func_button'];

/** `SP_func_door` (g_mover.c:952). Both directions share one start sound. */
const DOOR_SOUND_START = 'sound/movers/doors/dr1_strt.wav';
/** ...and both ends share one stop sound. */
const DOOR_SOUND_END = 'sound/movers/doors/dr1_end.wav';
/** `SP_func_button` (g_mover.c:1204). Start only -- a button has no end sound. */
const BUTTON_SOUND = 'sound/movers/switches/butn2.wav';

/**
 * `G_SetMovedir` (g_utils.c).
 *
 * Note it compares the whole angles vector against the literals `{0,-1,0}` and
 * `{0,-2,0}`, not just the yaw. `entities.ts` builds exactly that from a bare
 * `angle` key (F_ANGLEHACK), so `angle "-1"` is up and `angle "-2"` is down —
 * both of which appear in the maps in rotation.
 */
export function setMovedir(angles: readonly number[], movedir: Vec3): void {
  if (angles[0] === 0 && angles[1] === -1 && angles[2] === 0) {
    movedir[0] = 0;
    movedir[1] = 0;
    movedir[2] = 1;
    return;
  }
  if (angles[0] === 0 && angles[1] === -2 && angles[2] === 0) {
    movedir[0] = 0;
    movedir[1] = 0;
    movedir[2] = -1;
    return;
  }
  angleVectors(vec3(angles[0], angles[1], angles[2]), movedir, null, null);
}

/**
 * The live movers of one map, and the clip list the trace reads.
 *
 * Construct once per map. `run` is `G_RunFrame`'s mover half and must be called
 * every tick, before the player moves — the same order `G_RunFrame` uses.
 */
export class Movers {
  readonly movers: Mover[] = [];
  /**
   * `SimulationOptions.clipEntities`. Held by the Simulation by reference; the
   * `origin` inside each entry is the mover's own `currentOrigin` array, so a
   * mover that moves is seen moved by the very next trace with no copying.
   */
  readonly clipEntities: ClipEntity[] = [];

  events: MoverEvent[] = [];

  /** `level.time`. Every think and trajectory is evaluated against this. */
  private levelTime = 0;

  private readonly world: CollisionModel;
  private readonly trace: TraceResult = createTrace();
  /** Scratch for the push, so the tick allocates nothing. */
  private readonly move: Vec3 = vec3();
  private readonly savedOrigin: Vec3 = vec3();

  constructor(world: CollisionModel, entities: readonly MapEntity[], firstEntityNum = 1) {
    this.world = world;

    for (const entity of entities) {
      if (!MOVER_CLASSNAMES.includes(entity.classname)) {
        continue;
      }
      const submodel = world.submodels[entity.submodel];
      if (entity.submodel < 0 || !submodel) {
        continue; // trap_SetBrushModel would Com_Error; a broken map just loses the door
      }

      const mover: Mover = {
        entityNum: firstEntityNum + this.movers.length,
        entity,
        submodel: entity.submodel,
        mins: vec3(submodel.mins[0], submodel.mins[1], submodel.mins[2]),
        maxs: vec3(submodel.maxs[0], submodel.maxs[1], submodel.maxs[2]),
        pos1: vec3(),
        pos2: vec3(),
        movedir: vec3(),
        pos: createTrajectory(),
        currentOrigin: vec3(),
        moverState: MoverState.POS1,
        speed: 0,
        wait: 0,
        damage: 0,
        spawnflags: entity.spawnflags,
        think: MoverThink.NONE,
        nextthink: 0,
        teamchain: null,
        teammaster: null,
        teamslave: false,
        targetname: entity.targetname,
        target: entity.target,
        trigger: null,
        sound1to2: null,
        sound2to1: null,
        soundPos1: null,
        soundPos2: null,
      };
      this.movers.push(mover);
    }

    // `G_FindTeams` runs after every entity is spawned and before any of them
    // thinks, so the chain is in place by the time SP_func_door's think fires.
    this.findTeams();

    for (const mover of this.movers) {
      if (mover.entity.classname === 'func_door') {
        this.spawnFuncDoor(mover);
      } else {
        this.spawnFuncButton(mover);
      }
    }

    for (const mover of this.movers) {
      this.clipEntities.push({
        entityNum: mover.entityNum,
        submodel: mover.submodel,
        origin: mover.currentOrigin,
        // `SV_SetBrushModel`: "we don't know exactly what is in the brushes".
        contents: -1,
        mins: mover.mins,
        maxs: mover.maxs,
      });
    }
  }

  /**
   * `G_FindTeams` (g_main.c).
   *
   * Two details that are easy to lose and both matter for q3dm2's pair:
   *
   *  - the chain is built by PREPENDING (`e2->teamchain = e->teamchain;
   *    e->teamchain = e2;`), so a master A with later slaves B and C chains
   *    A -> C -> B, not A -> B -> C. Nothing in the mover code depends on the
   *    order, but a test that asserts one will read wrong if this is "tidied";
   *  - a slave's `targetname` is moved onto the master ("make sure that targets
   *    only point at the master"). Without that promotion, a team whose second
   *    brush carried the targetname would be un-openable, since only the master
   *    is ever used.
   */
  private findTeams(): void {
    for (let i = 0; i < this.movers.length; i++) {
      const e = this.movers[i];
      const team = e.entity.raw['team'];
      if (!team || e.teamslave) {
        continue;
      }
      e.teammaster = e;
      for (let j = i + 1; j < this.movers.length; j++) {
        const e2 = this.movers[j];
        const team2 = e2.entity.raw['team'];
        if (!team2 || e2.teamslave) {
          continue;
        }
        if (team === team2) {
          e2.teamchain = e.teamchain;
          e.teamchain = e2;
          e2.teammaster = e;
          e2.teamslave = true;

          // make sure that targets only point at the master
          if (e2.targetname) {
            e.targetname = e2.targetname;
            e2.targetname = null;
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // spawn functions
  // -------------------------------------------------------------------------

  /** `SP_func_door`. */
  private spawnFuncDoor(ent: Mover): void {
    // `ent->sound1to2 = ent->sound2to1 = G_SoundIndex(".../dr1_strt.wav");`
    // `ent->soundPos1 = ent->soundPos2 = G_SoundIndex(".../dr1_end.wav");`
    ent.sound1to2 = DOOR_SOUND_START;
    ent.sound2to1 = DOOR_SOUND_START;
    ent.soundPos1 = DOOR_SOUND_END;
    ent.soundPos2 = DOOR_SOUND_END;

    // default speed of 400
    ent.speed = entityFloat(ent.entity, 'speed', 0) || 400;

    // default wait of 2 seconds
    ent.wait = entityFloat(ent.entity, 'wait', 0) || 2;
    ent.wait *= 1000;

    // default lip of 8 units
    const lip = entityFloat(ent.entity, 'lip', 8);

    // default damage of 2 points
    ent.damage = Math.trunc(entityFloat(ent.entity, 'dmg', 2));

    // first position at start
    vectorCopy(originOf(ent), ent.pos1);

    // calculate second position
    setMovedir(ent.entity.angles, ent.movedir);
    const distance = moveDistance(ent, lip);
    vectorMA(ent.pos1, distance, ent.movedir, ent.pos2);

    // if "start_open", reverse position 1 and 2
    if (ent.spawnflags & START_OPEN) {
      const temp = vec3();
      vectorCopy(ent.pos2, temp);
      vectorCopy(originOf(ent), ent.pos2);
      vectorCopy(temp, ent.pos1);
    }

    this.initMover(ent);

    // `ent->nextthink = level.time + FRAMETIME` — the door trigger is spawned
    // one server frame after the map loads, not at spawn time, because every
    // part of a team has to exist first.
    ent.nextthink = this.levelTime + FRAMETIME;

    if (!ent.teamslave) {
      // `G_SpawnInt( "health", "0", &health )` — note this is a LOCAL in id's
      // source, never `ent->health`, so a shootable door has zero health and
      // dies on the first hit. See .agent/docs/movers.md; shootable movers are
      // deliberately not implemented, but the trigger suppression they cause IS
      // ported, because it changes whether the door has a touch field at all.
      const health = Math.trunc(entityFloat(ent.entity, 'health', 0));
      if (ent.targetname || health) {
        // non touch/shoot doors
        ent.think = MoverThink.MATCH_TEAM;
      } else {
        ent.think = MoverThink.SPAWN_NEW_DOOR_TRIGGER;
      }
    }
  }

  /** `SP_func_button`. */
  private spawnFuncButton(ent: Mover): void {
    // `ent->sound1to2 = G_SoundIndex(".../butn2.wav");` and nothing else. A
    // button clicks going in and is silent coming back out.
    ent.sound1to2 = BUTTON_SOUND;

    ent.speed = entityFloat(ent.entity, 'speed', 0) || 40;
    ent.wait = entityFloat(ent.entity, 'wait', 0) || 1;
    ent.wait *= 1000;

    // first position
    vectorCopy(originOf(ent), ent.pos1);

    const lip = entityFloat(ent.entity, 'lip', 4);

    setMovedir(ent.entity.angles, ent.movedir);
    const distance = moveDistance(ent, lip);
    vectorMA(ent.pos1, distance, ent.movedir, ent.pos2);

    // `if (ent->health) { takedamage } else { ent->touch = Touch_Button; }`.
    // A shootable button is not implemented (see the note in spawnFuncDoor),
    // but it must still not get a touch field, or acc_fuzzle's eighteen
    // shoot-only buttons would all become walk-into buttons.
    this.initMover(ent);
  }

  /** `InitMover`. Sound, light and model2 are not ported. */
  private initMover(ent: Mover): void {
    ent.moverState = MoverState.POS1;
    vectorCopy(ent.pos1, ent.currentOrigin);

    ent.pos.trType = TrType.STATIONARY;
    vectorCopy(ent.pos1, ent.pos.trBase);

    // calculate time to reach second position from speed
    const move = vec3();
    vectorSubtract(ent.pos2, ent.pos1, move);
    const distance = vectorLength(move);
    if (!ent.speed) {
      ent.speed = 100;
    }
    // id scales trDelta by `speed` here, which is wrong by a factor of
    // `distance` — but harmless, because SetMoverState overwrites trDelta
    // before the mover ever moves. Kept, so the port matches line for line.
    vectorScale(move, ent.speed, ent.pos.trDelta);
    // `trDuration` is an int, so this truncates.
    ent.pos.trDuration = Math.trunc(fround(fround(distance * 1000) / ent.speed));
    if (ent.pos.trDuration <= 0) {
      ent.pos.trDuration = 1;
    }
  }

  // -------------------------------------------------------------------------
  // the binary mover state machine
  // -------------------------------------------------------------------------

  /** `SetMoverState`. */
  private setMoverState(ent: Mover, moverState: MoverState, time: number): void {
    ent.moverState = moverState;
    ent.pos.trTime = time;

    switch (moverState) {
      case MoverState.POS1:
        vectorCopy(ent.pos1, ent.pos.trBase);
        ent.pos.trType = TrType.STATIONARY;
        break;
      case MoverState.POS2:
        vectorCopy(ent.pos2, ent.pos.trBase);
        ent.pos.trType = TrType.STATIONARY;
        break;
      case MoverState.ONETOTWO: {
        vectorCopy(ent.pos1, ent.pos.trBase);
        const delta = vec3();
        vectorSubtract(ent.pos2, ent.pos1, delta);
        const f = fround(1000.0 / ent.pos.trDuration);
        vectorScale(delta, f, ent.pos.trDelta);
        ent.pos.trType = TrType.LINEAR_STOP;
        break;
      }
      case MoverState.TWOTOONE: {
        vectorCopy(ent.pos2, ent.pos.trBase);
        const delta = vec3();
        vectorSubtract(ent.pos1, ent.pos2, delta);
        const f = fround(1000.0 / ent.pos.trDuration);
        vectorScale(delta, f, ent.pos.trDelta);
        ent.pos.trType = TrType.LINEAR_STOP;
        break;
      }
    }

    // Note this evaluates at the CURRENT level time, not at `time` — so a mover
    // told to start 50ms in the future sits at trBase until that time arrives.
    evaluateTrajectory(ent.pos, this.levelTime, ent.currentOrigin);
  }

  /** `MatchTeam` — everything on the team moves pos1 to pos2 in the same time. */
  private matchTeam(teamLeader: Mover, moverState: MoverState, time: number): void {
    for (let slave: Mover | null = teamLeader; slave; slave = slave.teamchain) {
      this.setMoverState(slave, moverState, time);
    }
  }

  /** `G_AddEvent( ent, EV_GENERAL_SOUND, ... )`, reported rather than played. */
  private sound(ent: Mover, path: string | null): void {
    if (!path) {
      return;
    }
    this.events.push({
      kind: 'sound',
      entityNum: ent.entityNum,
      target: null,
      time: this.levelTime,
      sound: path,
      origin: [ent.currentOrigin[0], ent.currentOrigin[1], ent.currentOrigin[2]],
    });
  }

  /** `ReturnToPos1`. */
  private returnToPos1(ent: Mover): void {
    this.matchTeam(ent, MoverState.TWOTOONE, this.levelTime);
    // starting sound
    this.sound(ent, ent.sound2to1);
  }

  /** `Reached_BinaryMover`. */
  private reachedBinaryMover(ent: Mover): void {
    if (ent.moverState === MoverState.ONETOTWO) {
      // reached pos2
      this.setMoverState(ent, MoverState.POS2, this.levelTime);

      // play sound
      this.sound(ent, ent.soundPos2);

      // return to pos1 after a delay
      ent.think = MoverThink.RETURN_TO_POS1;
      ent.nextthink = this.levelTime + ent.wait;

      // fire targets
      //
      // A button's targets fire HERE, on arrival, not on touch — which is why
      // a slow button has a visible delay before the door it opens moves, and
      // why `speed` on a button is a gameplay number rather than a cosmetic one.
      this.events.push({
        kind: 'reached',
        entityNum: ent.entityNum,
        target: ent.target,
        time: this.levelTime,
      });
      this.useTargets(ent.target);
    } else if (ent.moverState === MoverState.TWOTOONE) {
      // reached pos1
      this.setMoverState(ent, MoverState.POS1, this.levelTime);
      // play sound
      this.sound(ent, ent.soundPos1);
    } else {
      throw new Error('Reached_BinaryMover: bad moverState');
    }
  }

  /**
   * `Use_BinaryMover`.
   *
   * The `+ 50` is id's, and its comment explains it: "start moving 50 msec
   * later, becase if this was player triggered, level.time hasn't been advanced
   * yet". It is a wall-clock constant and does NOT scale with this project's
   * 8ms tick — see .agent/plans/DOORS.md section 6.
   */
  useBinaryMover(ent: Mover): void {
    // only the master should be used
    if (ent.teamslave && ent.teammaster) {
      this.useBinaryMover(ent.teammaster);
      return;
    }

    if (ent.moverState === MoverState.POS1) {
      // start moving 50 msec later, becase if this was player
      // triggered, level.time hasn't been advanced yet
      this.matchTeam(ent, MoverState.ONETOTWO, this.levelTime + 50);

      // starting sound -- note it plays NOW, not in 50ms. Quake fires the
      // event on the same frame it schedules the move, so a door is heard
      // starting slightly before it starts.
      this.sound(ent, ent.sound1to2);
      return;
    }

    // if all the way up, just delay before coming down
    if (ent.moverState === MoverState.POS2) {
      ent.nextthink = this.levelTime + ent.wait;
      return;
    }

    // only partway down before reversing
    if (ent.moverState === MoverState.TWOTOONE) {
      const total = ent.pos.trDuration;
      let partial = this.levelTime - ent.pos.trTime;
      if (partial > total) {
        partial = total;
      }
      this.matchTeam(ent, MoverState.ONETOTWO, this.levelTime - (total - partial));
      this.sound(ent, ent.sound1to2);
      return;
    }

    // only partway up before reversing
    if (ent.moverState === MoverState.ONETOTWO) {
      const total = ent.pos.trDuration;
      let partial = this.levelTime - ent.pos.trTime;
      if (partial > total) {
        partial = total;
      }
      this.matchTeam(ent, MoverState.TWOTOONE, this.levelTime - (total - partial));
      this.sound(ent, ent.sound2to1);
    }
  }

  /** `Blocked_Door`. Returns the crush damage to apply, or 0. */
  private blockedDoor(ent: Mover): number {
    const damage = ent.damage;

    if (ent.spawnflags & CRUSHER) {
      return damage; // crushers don't reverse
    }

    // reverse direction
    this.useBinaryMover(ent);
    return damage;
  }

  /**
   * `Think_SpawnNewDoorTrigger`.
   *
   * The expansion is **120 units on the single thinnest axis**. Not 60, and not
   * on two axes — that is the Quake II value and the wrong shape besides. The
   * thin axis is the one you walk through, so expanding it is what gives the
   * door a reach in front of and behind itself while keeping the trigger flush
   * with the door frame on the other two.
   */
  private thinkSpawnNewDoorTrigger(ent: Mover): void {
    // find the bounds of everything on the team
    const mins = vec3();
    const maxs = vec3();
    vectorAdd(ent.currentOrigin, ent.mins, mins);
    vectorAdd(ent.currentOrigin, ent.maxs, maxs);

    for (let other = ent.teamchain; other; other = other.teamchain) {
      for (let i = 0; i < 3; i++) {
        const lo = other.currentOrigin[i] + other.mins[i];
        const hi = other.currentOrigin[i] + other.maxs[i];
        if (lo < mins[i]) mins[i] = lo;
        if (lo > maxs[i]) maxs[i] = lo;
        if (hi < mins[i]) mins[i] = hi;
        if (hi > maxs[i]) maxs[i] = hi;
      }
    }

    // find the thinnest axis, which will be the one we expand
    let best = 0;
    for (let i = 1; i < 3; i++) {
      if (maxs[i] - mins[i] < maxs[best] - mins[best]) {
        best = i;
      }
    }
    maxs[best] += 120;
    mins[best] -= 120;

    ent.trigger = { mins, maxs, count: best };

    this.matchTeam(ent, ent.moverState, this.levelTime);
  }

  // -------------------------------------------------------------------------
  // the frame
  // -------------------------------------------------------------------------

  /**
   * `G_RunFrame`'s mover half: `G_RunMover` for every entity.
   *
   * Call once per tick BEFORE the player's pmove, which is the order
   * `G_RunFrame` establishes (it runs entities, then clients think). Returns the
   * crush damage the player took this tick, so the Game can apply it without
   * this module reaching into health.
   */
  run(time: number, msec: number, target: PushTarget | null): number {
    this.levelTime = time;
    this.events = [];
    let crush = 0;

    for (const ent of this.movers) {
      // if not a team captain, don't do anything, because
      // the captain will handle everything
      if (ent.teamslave) {
        continue;
      }

      // if stationary at one of the positions, don't move anything
      if (ent.pos.trType !== TrType.STATIONARY) {
        crush += this.moverTeam(ent, msec, target);
      }

      this.runThink(ent);
    }

    return crush;
  }

  /** `G_RunThink`. */
  private runThink(ent: Mover): void {
    const thinktime = ent.nextthink;
    if (thinktime <= 0) {
      return;
    }
    if (thinktime > this.levelTime) {
      return;
    }
    ent.nextthink = 0;

    switch (ent.think) {
      case MoverThink.RETURN_TO_POS1:
        this.returnToPos1(ent);
        break;
      case MoverThink.SPAWN_NEW_DOOR_TRIGGER:
        this.thinkSpawnNewDoorTrigger(ent);
        break;
      case MoverThink.MATCH_TEAM:
        this.matchTeam(ent, ent.moverState, this.levelTime);
        break;
      case MoverThink.NONE:
        break;
    }
    ent.think = MoverThink.NONE;
  }

  /** `G_MoverTeam`. Returns crush damage dealt to `target`. */
  private moverTeam(ent: Mover, msec: number, target: PushTarget | null): number {
    // make sure all team slaves can move before commiting
    // any moves or calling any think functions
    // if the move is blocked, all moved objects will be backed out
    let blocked: Mover | null = null;
    const origin = vec3();

    for (let part: Mover | null = ent; part; part = part.teamchain) {
      // get current position
      evaluateTrajectory(part.pos, this.levelTime, origin);
      vectorSubtract(origin, part.currentOrigin, this.move);
      if (!this.moverPush(part, this.move, target)) {
        blocked = part;
        break; // move was blocked
      }
    }

    if (blocked) {
      // go back to the previous position
      for (let part: Mover | null = ent; part; part = part.teamchain) {
        part.pos.trTime += msec;
        evaluateTrajectory(part.pos, this.levelTime, part.currentOrigin);
      }
      // if the pusher has a "blocked" function, call it. Note the argument is
      // the TEAM MASTER, not the part that was blocked.
      return this.blockedDoor(ent);
    }

    // the move succeeded
    for (let part: Mover | null = ent; part; part = part.teamchain) {
      // call the reached function if time is at or past end point
      if (part.pos.trType === TrType.LINEAR_STOP) {
        if (this.levelTime >= part.pos.trTime + part.pos.trDuration) {
          this.reachedBinaryMover(part);
        }
      }
    }

    return 0;
  }

  /**
   * `G_MoverPush`, for the single entity Overbounce can push: the player.
   *
   * Items are not pushed. In Quake they are (`ET_ITEM` passes the eType test),
   * but Overbounce's items are static spawn points owned by `ItemWorld` with no
   * physics of their own, so there is nothing to move. Missiles are not pushed
   * in Quake either.
   *
   * The rotation path is skipped outright rather than half-implemented: no
   * mover in rotation has an `amove`, and `boxTraceSubmodel` is translation
   * only, so a rotating pusher could not be collided with even if it were
   * pushed correctly.
   */
  private moverPush(pusher: Mover, move: Vec3, target: PushTarget | null): boolean {
    // move the pusher to its final position
    vectorAdd(pusher.currentOrigin, move, pusher.currentOrigin);

    if (!target) {
      return true;
    }

    // see if any solid entities are inside the final position
    //
    // mins/maxs are the pusher's bounds AT THE DESTINATION -- currentOrigin has
    // already been advanced above, so absmin/absmax are the destination bounds.
    if (target.groundEntityNum !== pusher.entityNum) {
      // see if the ent needs to be tested
      const amin = target.ps.origin;
      if (
        amin[0] + target.mins[0] >= pusher.currentOrigin[0] + pusher.maxs[0] ||
        amin[1] + target.mins[1] >= pusher.currentOrigin[1] + pusher.maxs[1] ||
        amin[2] + target.mins[2] >= pusher.currentOrigin[2] + pusher.maxs[2] ||
        amin[0] + target.maxs[0] <= pusher.currentOrigin[0] + pusher.mins[0] ||
        amin[1] + target.maxs[1] <= pusher.currentOrigin[1] + pusher.mins[1] ||
        amin[2] + target.maxs[2] <= pusher.currentOrigin[2] + pusher.mins[2]
      ) {
        return true;
      }
      // see if the ent's bbox is inside the pusher's final position
      // this does allow a fast moving object to pass through a thin entity...
      if (!this.testEntityPosition(target)) {
        return true;
      }
    }

    // the entity needs to be pushed
    if (this.tryPushingEntity(target, pusher, move)) {
      return true;
    }

    // The move was blocked. id does NOT undo the pusher's origin here — it only
    // restores the entities it pushed (already done inside tryPushingEntity),
    // and leaves the pusher advanced. `G_MoverTeam` then rewinds `trTime` and
    // re-evaluates `currentOrigin` for every part, which is what puts the
    // pusher back. Subtracting `move` here would be redundant at best and a
    // divergence at worst.
    return false;
  }

  /** `G_TryPushingEntity`, translation only (`amove` is always zero here). */
  private tryPushingEntity(check: PushTarget, pusher: Mover, move: Vec3): boolean {
    // save off the old position
    vectorCopy(check.ps.origin, this.savedOrigin);

    // add movement
    vectorAdd(check.ps.origin, move, check.ps.origin);

    // may have pushed them off an edge
    if (check.groundEntityNum !== pusher.entityNum) {
      check.groundEntityNum = -1;
    }

    if (!this.testEntityPosition(check)) {
      return true; // pushed ok
    }

    // if it is ok to leave in the old position, do it
    // this is only relevent for riding entities, not pushed
    // Sliding trapdoors can cause this.
    vectorCopy(this.savedOrigin, check.ps.origin);
    if (!this.testEntityPosition(check)) {
      check.groundEntityNum = -1;
      return true;
    }

    // blocked
    return false;
  }

  /** `G_TestEntityPosition` — true when the entity is stuck in something. */
  private testEntityPosition(check: PushTarget): boolean {
    traceWithEntities(
      this.world,
      this.trace,
      check.ps.origin,
      check.mins,
      check.maxs,
      check.ps.origin,
      MASK_PLAYERSOLID,
      this.clipEntities,
      check.entityNum,
    );
    return this.trace.startsolid;
  }

  // -------------------------------------------------------------------------
  // activation
  // -------------------------------------------------------------------------

  /**
   * `Touch_DoorTrigger`, driven from `G_TouchTriggers`.
   *
   * The trigger is an axis-aligned box, not a brush model, so this is a plain
   * bounds overlap — `SV_AreaEntities` plus `trap_EntityContact`, which for a
   * non-bmodel is exactly `SV_EntityContact`'s box case.
   *
   * The `moverState != MOVER_1TO2` test is what stops a door being re-used on
   * every frame the player stands in the trigger while it opens. Standing in an
   * OPEN door (MOVER_POS2) *does* re-use it, which is how a door holds itself
   * open for as long as someone is in the doorway.
   */
  touchDoorTriggers(ps: PlayerState, mins: Vec3, maxs: Vec3): void {
    for (const ent of this.movers) {
      const trigger = ent.trigger;
      if (!trigger) {
        continue;
      }
      if (
        ps.origin[0] + mins[0] > trigger.maxs[0] ||
        ps.origin[1] + mins[1] > trigger.maxs[1] ||
        ps.origin[2] + mins[2] > trigger.maxs[2] ||
        ps.origin[0] + maxs[0] < trigger.mins[0] ||
        ps.origin[1] + maxs[1] < trigger.mins[1] ||
        ps.origin[2] + maxs[2] < trigger.mins[2]
      ) {
        continue;
      }
      if (ent.moverState !== MoverState.ONETOTWO) {
        this.useBinaryMover(ent);
      }
    }
  }

  /**
   * `ClientImpacts` — the player bumped into solid entity `entityNum`.
   *
   * This is how a `func_button` fires. It is NOT a trigger: the button is solid
   * and the touch comes from `PM_SlideMove` recording what it clipped against.
   */
  touchEntity(entityNum: number): void {
    const ent = this.byEntityNum(entityNum);
    if (!ent || ent.entity.classname !== 'func_button') {
      return;
    }
    // `Touch_Button`. A shootable button has no touch field; none is
    // implemented, so this would fire one that should not. Suppressed here
    // rather than at spawn so the button is still solid.
    if (entityFloat(ent.entity, 'health', 0)) {
      return;
    }
    if (ent.moverState === MoverState.POS1) {
      this.useBinaryMover(ent);
    }
  }

  /**
   * `G_UseTargets` restricted to movers — everything with this `targetname` is
   * used.
   *
   * Call this when something outside the module (a `trigger_multiple`, a
   * `target_relay`) fires a target. Non-mover targets are the Course's job.
   */
  useTargets(targetname: string | null): void {
    if (!targetname) {
      return;
    }
    const wanted = targetname.toLowerCase();
    for (const ent of this.movers) {
      if (ent.targetname && ent.targetname.toLowerCase() === wanted) {
        this.events.push({
          kind: 'used',
          entityNum: ent.entityNum,
          target: ent.target,
          time: this.levelTime,
        });
        this.useBinaryMover(ent);
      }
    }
  }

  byEntityNum(entityNum: number): Mover | null {
    for (const ent of this.movers) {
      if (ent.entityNum === entityNum) {
        return ent;
      }
    }
    return null;
  }

  /**
   * Put every mover back at pos1, for a course restart.
   *
   * Not a port — Quake has no per-life map reset. It exists because a run
   * restart has to be reproducible, and a door left half open from the previous
   * attempt would make two runs of the same course incomparable, the same
   * argument `Course.reset` and `ItemWorld.reset` already make.
   *
   * A pending `SPAWN_NEW_DOOR_TRIGGER` think is left alone. Cancelling it would
   * permanently destroy the door's touch field on the rare restart inside the
   * first 100ms, and a door with no trigger and no targetname can never open.
   */
  reset(): void {
    for (const ent of this.movers) {
      ent.moverState = MoverState.POS1;
      ent.pos.trType = TrType.STATIONARY;
      ent.pos.trTime = 0;
      vectorCopy(ent.pos1, ent.pos.trBase);
      vectorCopy(ent.pos1, ent.currentOrigin);
      if (ent.think !== MoverThink.SPAWN_NEW_DOOR_TRIGGER) {
        ent.think = MoverThink.NONE;
        ent.nextthink = 0;
      }
    }
  }

  /**
   * Where each mover's submodel currently is, for the renderer.
   *
   * The render layer draws submodel `submodel` translated by `origin`. Q3
   * coordinates, Z-up — convert at the render boundary, not here.
   */
  renderStates(): { submodel: number; origin: [number, number, number] }[] {
    return this.movers.map((ent) => ({
      submodel: ent.submodel,
      origin: [ent.currentOrigin[0], ent.currentOrigin[1], ent.currentOrigin[2]],
    }));
  }
}

/** `ent->s.origin` — a bmodel with no origin brush spawns at the world origin. */
function originOf(ent: Mover): Vec3 {
  return vec3(ent.entity.origin[0], ent.entity.origin[1], ent.entity.origin[2]);
}

/**
 * `distance = DotProduct( abs_movedir, size ) - lip`.
 *
 * `size` is `r.maxs - r.mins`, and those come from `CM_ModelBounds`, which
 * returns the bounds `CMod_LoadSubmodels` already spread by a pixel each way.
 * So a door travels its brush width **plus two** minus the lip — a 64-unit door
 * on the default lip of 8 moves 58 units, not 56. That two units is not slop to
 * be cleaned up; it is the number the door's resting position depends on.
 */
function moveDistance(ent: Mover, lip: number): number {
  const size = vec3();
  vectorSubtract(ent.maxs, ent.mins, size);
  // `float distance = DotProduct( abs_movedir, size ) - lip;` is ONE expression
  // with one store into a float, so there is exactly one rounding, at the end.
  const dot =
    Math.abs(ent.movedir[0]) * size[0] +
    Math.abs(ent.movedir[1]) * size[1] +
    Math.abs(ent.movedir[2]) * size[2];
  return fround(dot - lip);
}
