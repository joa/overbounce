/**
 * `entity_event_t`, so a demo's events mean something.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from `refs/quake3/game/bg_public.h:347`, in order and complete
 * through `EV_SCOREPLUM` -- the values are ORDINALS of a bare C enum, so a
 * member left out in the middle would silently shift every one after it.
 * The MISSIONPACK tail is included for the same reason: it is inside the
 * same `#ifdef`-free enum as far as the wire is concerned, and a Team Arena
 * demo really does send those numbers.
 *
 * ## Why this is not `PmEvent`
 *
 * `src/physics/types.ts` has its own `PmEvent`, and its numbering is NOT
 * this one -- it is the compact set pmove itself raises, renumbered from 1.
 * That is fine and deliberate: pmove's events never go over a wire here, so
 * they never had to match. But it means `PlaybackEvent.event` is read in one
 * of two numbering spaces depending on `ClipMeta.kind`, and reading a ghost's
 * event as an `EntityEvent` turns a jump into a footstep. The clip's own
 * comment says so; this is the other half of it.
 */

/** `entity_event_t`. Ordinals matter -- see the file header. */
export const enum EntityEvent {
  NONE = 0,
  FOOTSTEP,
  FOOTSTEP_METAL,
  FOOTSPLASH,
  FOOTWADE,
  SWIM,
  STEP_4,
  STEP_8,
  STEP_12,
  STEP_16,
  FALL_SHORT,
  FALL_MEDIUM,
  FALL_FAR,
  /** "boing sound at origin, jump sound on player" -- id's own comment. */
  JUMP_PAD,
  JUMP,
  WATER_TOUCH,
  WATER_LEAVE,
  WATER_UNDER,
  WATER_CLEAR,
  ITEM_PICKUP,
  GLOBAL_ITEM_PICKUP,
  NOAMMO,
  CHANGE_WEAPON,
  FIRE_WEAPON,
  USE_ITEM0,
  USE_ITEM1,
  USE_ITEM2,
  USE_ITEM3,
  USE_ITEM4,
  USE_ITEM5,
  USE_ITEM6,
  USE_ITEM7,
  USE_ITEM8,
  USE_ITEM9,
  USE_ITEM10,
  USE_ITEM11,
  USE_ITEM12,
  USE_ITEM13,
  USE_ITEM14,
  USE_ITEM15,
  ITEM_RESPAWN,
  ITEM_POP,
  PLAYER_TELEPORT_IN,
  PLAYER_TELEPORT_OUT,
  /** `eventParm` is the sound index. */
  GRENADE_BOUNCE,
  GENERAL_SOUND,
  GLOBAL_SOUND,
  GLOBAL_TEAM_SOUND,
  BULLET_HIT_FLESH,
  BULLET_HIT_WALL,
  MISSILE_HIT,
  MISSILE_MISS,
  MISSILE_MISS_METAL,
  RAILTRAIL,
  SHOTGUN,
  BULLET,
  PAIN,
  DEATH1,
  DEATH2,
  DEATH3,
  OBITUARY,
  POWERUP_QUAD,
  POWERUP_BATTLESUIT,
  POWERUP_REGEN,
  GIB_PLAYER,
  SCOREPLUM,
}

/**
 * `EV_EVENT_BITS` -- `bg_public.h:341-343`.
 *
 *     // There is a maximum of 256 events (8 bits transmitted over network)
 *     // 2 bits at the top of the event field will be incremented with each
 *     // event, so that an identical event started twice in a row can
 *     // be distinguished.  And off the value with ~EV_EVENT_BITS
 *     #define EV_EVENT_BIT1    0x00000100
 *     #define EV_EVENT_BIT2    0x00000200
 *     #define EV_EVENT_BITS    (EV_EVENT_BIT1|EV_EVENT_BIT2)
 *
 * These bits are NOT part of the event number and are on the wire in only one
 * of the two places an event reaches us from. That asymmetry is the whole
 * reason this constant is exported rather than folded away:
 *
 *  - `ps.events[]`, the two-slot ring, is written by `PM_AddEvent` /
 *    `BG_AddPredictableEventToPlayerstate` and carries the BARE number.
 *    Masking it is a no-op, which is why every event Overbounce already
 *    played -- footsteps, landings, the jump -- worked without this.
 *  - `ps.externalEvent` is written by `G_AddEvent` (`g_utils.c:584`), which
 *    does `bits = (bits + EV_EVENT_BIT1) & EV_EVENT_BITS; ps.externalEvent =
 *    event | bits;`. So the SAME event arrives as 19, 275, 531 and 787 on
 *    four successive occurrences, and then 19 again as the counter wraps.
 *
 * That wrap is what made the old unmasked reads look like they half-worked:
 * one occurrence in four has zero bits and matched the enum by luck, and the
 * other three fell through to `default`. The sample demo is exactly this --
 * its eight `EV_ITEM_PICKUP`s arrive as 531, 787, 787, 275, 787, 531, 531,
 * 787, and every single one of them was silently discarded.
 *
 * Note that the sample's sequence is not the clean 0, 1, 2, 3 cycle the C
 * describes: its DeFRaG server sends 531 then 787 then 787 again. Whatever it
 * does with the counter, the counter is not ours to model -- the only
 * contract a reader has is "and off the value", and that is why this masks
 * rather than tracking what the bits should have been.
 *
 * And this is not only about pickups. Anything `G_AddEvent` raises on the POV
 * lands here: `EV_PAIN` (`g_active.c:75`) and `EV_DEATH1 + i`
 * (`g_combat.c:665`) among them, so a demo's death sounds were silent three
 * times in four for the same reason.
 */
export const EV_EVENT_BITS = 0x300;

/**
 * The event number, with the repeat counter taken off.
 *
 * `CG_EntityEvent` opens with exactly this (`cg_event.c:474`):
 *
 *     event = es->event & ~EV_EVENT_BITS;
 *
 * and it is deliberately done HERE rather than in `demo-clip.ts`, for the
 * same reason id does it here: the raw value with its bits is what the
 * server SAID, so it is what a `PlaybackEvent` should carry, and the mask
 * belongs to whoever interprets the number. A clip that masked on the way in
 * would lose the ability to tell two identical consecutive events apart,
 * which is the one thing the bits exist for.
 */
export function entityEventOf(raw: number): number {
  return raw & ~EV_EVENT_BITS;
}

/**
 * What a POV event sounds like, in terms both numbering spaces can express.
 *
 * A demo carries `entity_event_t` and a ghost carries `PmEvent`, and the
 * overlap that matters for sound is small: footsteps, landings and a jump.
 * Reducing both to this handful is what lets one consumer play a demo and a
 * ghost without a branch at every case.
 */
export type MoveSound =
  | 'footstep'
  | 'footstep-metal'
  | 'footsplash'
  | 'land'
  | 'land-hard'
  | 'jump'
  | 'jumppad'
  | 'teleport'
  | 'fire'
  | 'death'
  | null;

/**
 * How far the view drops for a DEMO's landing event, or null if it is not one.
 *
 * The sibling of `view-weapon.ts`'s `cgLandChangeFor`, which answers the same
 * question in the other numbering space -- and the reason there are two is
 * this file's whole header: a `PlaybackEvent.event` is read as an
 * `entity_event_t` for a demo and as a `PmEvent` for a ghost, and the two
 * enums do not share ordinals. One function reading both would need to be
 * told which space it is in, which is exactly the bug this split prevents.
 *
 * The depths themselves are id's, cg_event.c:537/547/557, and are the same
 * numbers in both spaces because they are a property of the landing rather
 * than of the event encoding.
 *
 * Masked like every other demo-side read, though no landing can currently
 * arrive with bits set: `EV_FALL_*` is raised by `PM_CrashLand` through
 * `PM_AddEvent`, so it always comes off the bare `ps.events` ring. The mask
 * is here for uniformity rather than for a bug -- do not go hunting for the
 * behaviour change, there is none.
 */
export function demoLandChange(event: number): number | null {
  switch (entityEventOf(event)) {
    case EntityEvent.FALL_SHORT:
      return -8;
    case EntityEvent.FALL_MEDIUM:
      return -16;
    case EntityEvent.FALL_FAR:
      return -24;
    default:
      return null;
  }
}

/**
 * `entity_event_t` -> what to play, for the movement vocabulary.
 *
 * Pickups are deliberately NOT here: their sound is a file path out of
 * `bg_itemlist` chosen by `eventParm`, which `MoveSound`'s closed union
 * cannot name. `playback-fx.ts`'s `demoPickupSounds` answers that half, next
 * to `fireSound`, which resolves a path for the same reason.
 */
export function demoEventSound(event: number): MoveSound {
  switch (entityEventOf(event)) {
    case EntityEvent.FOOTSTEP:
      return 'footstep';
    case EntityEvent.FOOTSTEP_METAL:
      return 'footstep-metal';
    case EntityEvent.FOOTSPLASH:
    case EntityEvent.FOOTWADE:
      return 'footsplash';
    case EntityEvent.FALL_SHORT:
      return 'land';
    case EntityEvent.FALL_MEDIUM:
    case EntityEvent.FALL_FAR:
      return 'land-hard';
    case EntityEvent.JUMP:
      return 'jump';
    case EntityEvent.JUMP_PAD:
      return 'jumppad';
    case EntityEvent.PLAYER_TELEPORT_IN:
    case EntityEvent.PLAYER_TELEPORT_OUT:
      return 'teleport';
    case EntityEvent.FIRE_WEAPON:
      return 'fire';
    case EntityEvent.DEATH1:
    case EntityEvent.DEATH2:
    case EntityEvent.DEATH3:
      return 'death';
    default:
      return null;
  }
}
