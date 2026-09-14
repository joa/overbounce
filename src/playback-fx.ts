/**
 * Sound and decals for playback.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ## Why this exists at all
 *
 * `runCourse` plays every sound and stamps every mark inline in its own tick
 * loop, reading a `GameFrame` field by field. Playback needs the same
 * answers from the same fields, and it is not `runCourse`: it has no
 * `usercmd`, no HUD, no pointer lock and its clock runs backwards on demand.
 * So the consumer is written once here against a clip rather than a game,
 * and the session hands it whatever its source could tell it.
 *
 * ## A ghost hears more than a demo, and that is not a bug
 *
 * A ghost is re-simulated, so the whole `GameFrame` is available: every
 * rocket, every ricochet, every pellet mark, every door. A `.dm_68` is a
 * recording of what a server SAID, and what it said about the POV is a
 * two-slot event ring plus one `externalEvent` slot -- footsteps, landings,
 * a jump, a weapon fire, and the item it just ran over. Entity events (the
 * rocket that exploded across the room) live on the entities themselves and
 * `CG_EntityEvent` is not ported, so a demo plays the POV's own sounds and
 * nothing else. The alternative is inventing sounds the demo never
 * contained, which is exactly what "a demo can never be improved by
 * re-simulating it" rules out.
 *
 * One consequence worth knowing before chasing it as a bug: a powerup taken
 * in a demo plays `n_health.wav` and NOT `quaddamage.wav`. The second sound
 * is `EV_GLOBAL_ITEM_PICKUP`, which `Touch_Item` sends as a broadcast
 * `G_TempEntity` (`g_items.c:488`) rather than on the playerstate, so it is
 * an entity event and arrives through the door this file does not open.
 * `demoPickupSounds` maps it anyway -- it is correct and costs nothing -- but
 * reaching it means teaching `DemoClip.eventsBetween` to surface `ET_EVENTS`
 * entities, which is a deliberate omission there and not a line to change in
 * passing.
 *
 * ## Scrubbing, and the three things a sound can do
 *
 * An event is a thing that HAPPENED. Emission is gated on playing forward:
 * a paused frame is silent, and a backward scrub clears the marks, because a
 * rocket that goes off at 4s has no business on the wall at 2s. That gate is
 * the caller's -- see `SoundEmit` -- because only the session knows whether
 * the clock moved and which way.
 *
 * The gate has THREE states rather than two, and the third is what a video
 * export needs. World STATE (a decal, a burst) is stamped on any forward
 * move, scrubs and exports included, because a mark belongs on the wall
 * wherever the playhead is. A SOUND is an event, so it is emitted only while
 * the clip is genuinely running -- dragging the scrubber across four seconds
 * would otherwise fire every footstep in them at once, and an export, which
 * renders as fast as the encoder drains, would play the whole run in however
 * long the encode took. But an export still has to END UP with that audio in
 * the file. So `'capture'` is a mode of its own: the same sounds, chosen and
 * attenuated by the same code, recorded against clip time instead of being
 * heard. `audio/offline-render.ts` turns that list into the exported track.
 *
 * ## Nothing here may roll a die
 *
 * Quake varies its footsteps by picking one of four at random and jittering
 * the pitch, and `rand()` is right in a live game. It is wrong in a
 * recording: an export must render the same range identically every run, the
 * way `frameTimes` guarantees for the picture, and a paused clip must hold
 * still rather than shimmer. Every random term here is therefore a hash of
 * the event's own CLIP time -- same instant, same footstep, forever -- which
 * is the same trick `render/view-weapon.ts` plays for the muzzle flash's roll
 * and `playback-session.ts` for the flash light's flicker. It is not
 * conditional on capture mode, and that is the point: what the viewer hears
 * while watching has to be what lands in the file.
 */

import { SOUNDS, itemPickupSounds, playerSounds } from './audio/sound.js';
import {
  APP_SFX,
  OB_SOUND_COOLDOWN_MS,
  SoundCooldown,
} from './audio/app-sfx.js';
import type { SoundSystem } from './audio/sound.js';
import type { Decals } from './render/decals.js';
import { byteToDir } from './math/dirs.js';
import type { Effects } from './render/effects.js';
import type { ExplosionFx } from './render/explosion-fx.js';
import type { PlaybackTickFx } from './playback/clip.js';
import type { PlaybackEvent } from './playback/clip.js';
import { EntityEvent, demoEventSound, entityEventOf } from './playback/events.js';
import type { MoveSound } from './playback/events.js';
import { PmEvent } from './physics/types.js';
import { ObLandingWatch } from './game/overbounce.js';
import { Weapon } from './game/weapons.js';
import { ITEMS, ItemType } from './game/items.js';
import type { Item } from './game/items.js';

/**
 * What a frame's sounds are allowed to do.
 *
 * `'off'` is a paused frame or a scrub, `'play'` is a clip actually running,
 * and `'capture'` is a video export: the same sounds, recorded against clip
 * time by `SoundSystem`'s capture mode and never heard. See this file's
 * header. Marks and bursts are NOT gated by this -- they are world state.
 */
export type SoundEmit = 'off' | 'play' | 'capture';

/**
 * A `rand()` that is a pure function of the clip clock, plus a salt.
 *
 * Thomas Wang's 32-bit integer hash -- the same mixer `view-weapon.ts` uses
 * for `cgFlashRoll`, and copied rather than shared because that module is
 * renderer-side and this one must not grow a dependency on it for four
 * lines of arithmetic. It is here for the property that mixer has and a
 * multiply-only one does not: it avalanches on the LOW bits, so consecutive
 * milliseconds give unrelated values rather than a visibly marching sequence.
 *
 * `salt` separates two draws taken at the same instant. A footstep picks
 * WHICH of four samples and then a pitch; drawn from the same seed those two
 * would be perfectly correlated, so step3 would always be the fast one.
 */
function fxRand(timeMs: number, salt: number): number {
  let x = (Math.trunc(timeMs) + Math.imul(salt, 0x9e3779b1)) | 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return x >>> 0;
}

/** `fxRand` as a fraction in [0, 1) -- Quake's `random()`, made reproducible. */
function fxRandom(timeMs: number, salt: number): number {
  return fxRand(timeMs, salt) / 0x1_0000_0000;
}

/** Which sample of a set. Its own salt, so it does not track the pitch. */
const SALT_PICK = 1;
/** The pitch jitter. */
const SALT_RATE = 2;

/**
 * The footstep pitch jitter, `0.94 + random() * 0.12`.
 *
 * The live game rolls this per step (main.ts) and it is what stops a run of
 * footsteps sounding like a loop. Keyed on the step's own clip time here --
 * see this file's header on why nothing in a recording may roll a die.
 */
function footstepRate(timeMs: number): number {
  return 0.94 + fxRandom(timeMs, SALT_RATE) * 0.12;
}

/** `PmEvent` -> the same small vocabulary `demoEventSound` speaks. */
function ghostEventSound(event: number): MoveSound {
  switch (event) {
    case PmEvent.JUMP:
      return 'jump';
    case PmEvent.FOOTSTEP:
      return 'footstep';
    case PmEvent.FOOTSTEP_METAL:
      return 'footstep-metal';
    case PmEvent.FOOTSPLASH:
      return 'footsplash';
    case PmEvent.FALL_SHORT:
      return 'land';
    case PmEvent.FALL_MEDIUM:
    case PmEvent.FALL_FAR:
      return 'land-hard';
    default:
      return null;
  }
}

/** The fire sound for a weapon, in Overbounce numbering. */
function fireSound(weapon: Weapon): string {
  switch (weapon) {
    case Weapon.GRENADE_LAUNCHER:
      return SOUNDS.grenadeFire;
    case Weapon.PLASMAGUN:
      return SOUNDS.plasmaFire;
    case Weapon.MACHINEGUN:
      return SOUNDS.machinegunFire;
    case Weapon.RAILGUN:
      return SOUNDS.railgunFire;
    case Weapon.SHOTGUN:
      return SOUNDS.shotgunFire;
    default:
      return SOUNDS.rocketFire;
  }
}

const NO_SOUNDS: readonly string[] = [];

/**
 * `bg_itemlist[eventParm]`, with id's own bounds check.
 *
 * `ITEMS` is `bg_itemlist` with the leading placeholder dropped -- the C table
 * opens with a `{NULL}` entry carrying the comment "leave index 0 alone" and
 * closes with a `{NULL}` terminator, so `bg_numItems` is 52 for 51 real items
 * and the only legal `eventParm` values are 1..51. Subtracting one is
 * therefore not an off-by-one to be tidied away; it is the difference between
 * the two tables, and getting it backwards hands out the neighbouring item's
 * sound, which is the kind of wrong that sounds nearly right.
 *
 * `if ( index < 1 || index >= bg_numItems ) break;` -- cg_event.c:679 and
 * again at 724 -- is `parm < 1 || parm > ITEMS.length` here, the same window.
 */
/**
 * Which impact a weapon leaves behind: the mark, the burst and the sound.
 *
 * `CG_MissileHitWall`'s switch (`cg_weapons.c:1781`) in the three cases this
 * project draws, plus its `default:` -- which falls through to the rocket,
 * and is therefore the right answer for an event whose weapon the wire did
 * not carry. `weapon` is optional on a `PlaybackEvent` precisely because a
 * POV event has none, and a missing one here is the same case id's `default`
 * covers rather than a reason to skip the explosion.
 */
function impactClassname(weapon: Weapon | undefined): string {
  switch (weapon) {
    case Weapon.PLASMAGUN:
      return 'plasma';
    case Weapon.RAILGUN:
      return 'rail';
    case Weapon.GRENADE_LAUNCHER:
      return 'grenade';
    default:
      return 'rocket';
  }
}

function pickupItem(eventParm: number): Item | null {
  if (eventParm < 1 || eventParm > ITEMS.length) {
    return null;
  }
  return ITEMS[eventParm - 1];
}

/**
 * The sound a demo's pickup event makes, in the order Quake plays it.
 *
 * Quake splits one pickup across TWO events and they play different sounds,
 * which is why implementing either alone leaves a hole:
 *
 *     case EV_ITEM_PICKUP:                                  // cg_event.c:671
 *         index = es->eventParm;        // player predicted
 *         if ( index < 1 || index >= bg_numItems ) break;
 *         item = &bg_itemlist[ index ];
 *         // powerups and team items will have a separate global sound, this
 *         // one will be played at prediction time
 *         if ( item->giType == IT_POWERUP || item->giType == IT_TEAM) {
 *             trap_S_StartSound (NULL, es->number, CHAN_AUTO, cgs.media.n_healthSound );
 *         } else if (item->giType == IT_PERSISTANT_POWERUP) {
 *     #ifdef MISSIONPACK
 *             ...scoutSound / guardSound / doublerSound / ammoregenSound...
 *     #endif
 *         } else {
 *             trap_S_StartSound (NULL, es->number, CHAN_AUTO,
 *                 trap_S_RegisterSound( item->pickup_sound, qfalse ) );
 *         }
 *
 *     case EV_GLOBAL_ITEM_PICKUP:                           // cg_event.c:716
 *         ...same bounds check...
 *         // powerup pickups are global
 *         if( item->pickup_sound ) {
 *             trap_S_StartSound (NULL, cg.snap->ps.clientNum, CHAN_AUTO,
 *                 trap_S_RegisterSound( item->pickup_sound, qfalse ) );
 *         }
 *
 * So an ordinary item is ONE sound, its own, on the picker. A powerup or a
 * flag is TWO: `n_health.wav` locally the instant the client predicts the
 * touch, and then the item's real sound (quaddamage.wav, haste.wav) as a
 * broadcast everyone hears wherever they are. `EV_ITEM_PICKUP` deliberately
 * does NOT play a powerup's own sound, because the broadcast will.
 *
 * The persistent-powerup arm is empty outside MISSIONPACK -- the `#ifdef`
 * wraps the whole body, so a baseq3 client picking up a Scout makes no local
 * noise at all. Overbounce is baseq3, so this returns nothing there too.
 * That is not an omission; adding a sound would be inventing one.
 *
 * `sound.ts`'s `itemPickupSounds` answers the merged question -- "everything
 * grabbing this item sounds like" -- because the LIVE game has no wire and no
 * two events to be told apart, only a `pickup` in a `GameFrame`. A demo does
 * have them, separately and at their own times, so it must not use that one:
 * a clip carrying only half the pair has to play only half the sound.
 *
 * `event` is the RAW wire value, bits and all -- see `entityEventOf`.
 */
export function demoPickupSounds(event: number, eventParm: number): readonly string[] {
  const which = entityEventOf(event);
  if (which !== EntityEvent.ITEM_PICKUP && which !== EntityEvent.GLOBAL_ITEM_PICKUP) {
    return NO_SOUNDS;
  }
  const item = pickupItem(eventParm);
  if (!item) {
    return NO_SOUNDS;
  }
  if (which === EntityEvent.GLOBAL_ITEM_PICKUP) {
    return item.pickupSound ? [item.pickupSound] : NO_SOUNDS;
  }
  if (item.type === ItemType.POWERUP || item.type === ItemType.TEAM) {
    return [SOUNDS.itemPickupLocal];
  }
  if (item.type === ItemType.PERSISTANT_POWERUP) {
    // The `#ifdef MISSIONPACK` arm. Empty in baseq3, and so is this.
    return NO_SOUNDS;
  }
  return item.pickupSound ? [item.pickupSound] : NO_SOUNDS;
}

/**
 * Every sound any pickup can make, for the preload.
 *
 * `SoundSystem.play` DROPS a sound it has not decoded, so an un-preloaded
 * pickup is silent the first time it happens -- and in a speedrun demo the
 * first time is usually the only time. The live game scopes its preload to
 * the items the map actually placed (`mapPickupSounds`, main.ts:1885); a
 * demo could scope it to the `CS_ITEMS` bitstring, which says which of the 51
 * the server registered, but `preloadList` is called by the session with no
 * clip in hand and that plumbing would have to cross `playback-session.ts`.
 * The whole table is nineteen distinct short wavs and `load` caches a miss as
 * null, so the unscoped list costs a handful of reads against a pak that
 * already has to be mounted, and nothing at all if it does not.
 */
const PICKUP_SOUNDS: readonly string[] = [
  ...new Set(ITEMS.flatMap((item) => itemPickupSounds(item))),
];

export interface PlaybackFxOptions {
  sound: SoundSystem;
  decals: Decals | null;
  /**
   * The detonation, drawn.
   *
   * `explosions` is the real sprite-based burst and `fallback` is the
   * flat-colour one `Effects` draws when the pak has no explosion art. A
   * clip that had neither played the sound and stamped the scorch with
   * nothing in between, which reads as the rocket having done nothing --
   * and on a rocket JUMP, where the missile lives for two or three frames,
   * the burst is essentially the whole of what there is to see.
   */
  explosions: ExplosionFx | null;
  fallback: Effects | null;
  /** The subject's player model, for its voice. `''` uses the default. */
  playerModel: string;
}

export interface PlaybackFx {
  /**
   * Everything to preload, so the first jump of a clip is not silent.
   *
   * `SoundSystem.play` DROPS a sound it has not decoded yet, which makes
   * every one-shot in a recording a first-time-only event and therefore
   * silent unless it is on this list.
   */
  preloadList(): readonly string[];
  /** Where the ear is, once a frame, before anything is played. */
  listen(origin: ArrayLike<number>, right?: ArrayLike<number>): void;
  /**
   * Play a sample's POV events.
   *
   * `demo` picks the numbering space -- see `playback/events.ts` for why
   * that cannot be inferred from the number itself.
   *
   * `emit` is the gate, and it is INSIDE rather than at the call site so that
   * both entry points speak one vocabulary: a caller that wrapped this in its
   * own `if` would have no way to say "record these without sounding them".
   * It defaults to `'play'` for the callers that have nothing to say about
   * it -- tests, and anything that only reaches here when it already decided
   * the clip was running.
   */
  playEvents(
    events: readonly PlaybackEvent[],
    demo: boolean,
    weapon: Weapon,
    emit?: SoundEmit,
  ): void;
  /**
   * `CG_EntityEvent`, for the events a DEMO's non-POV entities raise.
   *
   * Separate from `playEvents` because the two obey different gates, and the
   * difference is the one `playFx` already documents: a decal and a burst are
   * world STATE and belong on the wall whenever the playhead is past the
   * rocket, including after a forward scrub and including in an export frame;
   * a sound is an EVENT. `playEvents` returns early on `emit === 'off'`,
   * which is right for something that is only ever sound and would silently
   * drop every explosion mark on a scrub.
   *
   * It returns the detonations it stamped so the session can light them --
   * the same list `runCourse` builds from `GameFrame.explosions`, so a demo's
   * rocket and a ghost's throw the same light.
   */
  playEntityEvents(
    events: readonly PlaybackEvent[],
    emit: SoundEmit,
  ): readonly { origin: [number, number, number]; classname: string; time: number }[];
  /**
   * Stamp a ghost's per-tick effects, and sound them according to `emit`.
   *
   * Marks and sounds are gated differently on purpose. A mark is world
   * STATE -- it should be on the wall whenever the playhead is past the
   * rocket, including after a forward scrub, and including in a frame an
   * exporter rendered as fast as the encoder would take it. A sound is an
   * EVENT: firing one on a scrub drag turns a drag across four seconds into
   * a burst of every footstep in it, and firing one during an export plays
   * the whole clip's audio compressed into however long the encode ran.
   *
   * Which leaves the export needing its audio anyway, and that is
   * `'capture'` -- see `SoundEmit`.
   */
  playFx(fx: readonly PlaybackTickFx[], emit: SoundEmit): void;
  /**
   * Overbounces a DEMO crossed, at their own clip times.
   *
   * A ghost's are found inside `playFx`, from the per-tick `GameFrame` it
   * already carries -- the same 8ms observation the live game makes. A demo
   * has no ticks and its sampled playerstate is interpolated, which destroys
   * the very jump the test looks for (`CG_InterpolatePlayerState` lerps
   * velocity), so `DemoClip` runs the test across its own un-interpolated
   * snapshots and hands the answers here. See `playback/demo-clip.ts`'s
   * `takeOverbounces`.
   */
  playOverbounces(times: readonly number[], emit: SoundEmit): void;
  /** Age the bursts. Clip time, like everything else the picture is made of. */
  update(timeMs: number, dtMs: number): void;
  /** A backward scrub: the marks from the discarded future are removed. */
  reset(): void;
}

export function createPlaybackFx(options: PlaybackFxOptions): PlaybackFx {
  const { sound, decals, explosions, fallback } = options;
  const voice = playerSounds(options.playerModel || 'sarge');

  /**
   * The overbounce test, over a GHOST's ticks. Demos never touch it -- see
   * `playOverbounces`.
   *
   * `reset()` drops its baseline, which is what stops a seek inventing one:
   * a watch that remembered "airborne at 900ups" from before the scrub would
   * fire on the first grounded tick after it, on a landing that the playhead
   * never actually crossed.
   */
  const obLanding = new ObLandingWatch();

  /**
   * ...and how often it is allowed to say so, on CLIP time.
   *
   * Clip time and not the wall clock, like every other clock in this file: a
   * paused clip must not serve out its cooldown, and an export -- which
   * renders as fast as the encoder drains -- has to gate on the same
   * milliseconds the viewer will hear, or the file and the screen disagree
   * about which overbounces got announced.
   */
  const obSound = new SoundCooldown(OB_SOUND_COOLDOWN_MS);

  /**
   * Stamp the clip time the sounds about to be played happened at.
   *
   * Only capture mode cares -- a live `play` starts at the context's own
   * `currentTime` and always has. Called per EVENT and per TICK rather than
   * once a frame: a 60fps frame is two 8ms ticks wide, and stamping both with
   * the frame's time would land two footsteps on the same instant. The
   * session sets the frame's time first and this refines it; whoever knows
   * better sets it last.
   */
  const stamp = (emit: SoundEmit, timeMs: number): void => {
    if (emit === 'capture') {
      sound.setCaptureTime(timeMs);
    }
  };

  /** One overbounce, heard or recorded but never on a paused or scrubbing clip. */
  const playOverbounce = (emit: SoundEmit, timeMs: number): void => {
    if (emit === 'off') {
      return;
    }
    // The gate is INSIDE the emit check on purpose: a scrub crosses
    // overbounces without sounding them, and those must not arm a cooldown
    // that then silences the first real one after the clip resumes.
    if (!obSound.ready(timeMs)) {
      return;
    }
    stamp(emit, timeMs);
    sound.play(APP_SFX.overbounce, { volume: 0.8 });
  };

  /**
   * `timeMs` is the event's OWN clip time, and it is not decoration: it is
   * the seed every random term in here is drawn from, and the instant a
   * captured sound is scheduled at.
   */
  const playMove = (
    what: MoveSound,
    timeMs: number,
    weapon: Weapon = Weapon.ROCKET_LAUNCHER,
  ): void => {
    switch (what) {
      case 'jump':
        sound.play(voice.jump, { volume: 0.7 });
        break;
      case 'footstep':
        sound.playOneOf(
          SOUNDS.footsteps,
          { volume: 0.35, rate: footstepRate(timeMs) },
          fxRandom(timeMs, SALT_PICK),
        );
        break;
      case 'footstep-metal':
        sound.playOneOf(
          SOUNDS.footstepsMetal,
          { volume: 0.35, rate: footstepRate(timeMs) },
          fxRandom(timeMs, SALT_PICK),
        );
        break;
      case 'footsplash':
        sound.playOneOf(
          SOUNDS.footstepsSplash,
          { volume: 0.4 },
          fxRandom(timeMs, SALT_PICK),
        );
        break;
      case 'land':
        sound.play(SOUNDS.land, { volume: 0.6 });
        break;
      case 'land-hard':
        sound.play(voice.fall, { volume: 0.8 });
        sound.play(SOUNDS.land, { volume: 0.7 });
        break;
      case 'jumppad':
        sound.play(SOUNDS.jumppad, { volume: 0.7 });
        break;
      case 'teleport':
        sound.play(SOUNDS.teleport, { volume: 0.7 });
        break;
      case 'death':
        // `CG_Obituary` picks one of three at random; keyed on the moment of
        // death, so the same clip dies the same way every time it is watched.
        sound.playOneOf(voice.death, { volume: 0.85 }, fxRandom(timeMs, SALT_PICK));
        break;
      case 'fire':
        // A demo's `EV_FIRE_WEAPON` says only THAT the gun fired. Which gun
        // is the POV's `ps.weapon`, which the IR carries and maps out of
        // `weapon_t` on the way in -- so the caller passes it in rather than
        // this guessing at the rocket.
        sound.play(fireSound(weapon), {
          volume: weapon === Weapon.MACHINEGUN ? 0.4 : 0.7,
        });
        break;
      default:
        break;
    }
  };

  return {
    preloadList(): readonly string[] {
      return [
        ...SOUNDS.footsteps,
        ...SOUNDS.footstepsMetal,
        ...SOUNDS.footstepsSplash,
        SOUNDS.land,
        SOUNDS.jumppad,
        SOUNDS.teleport,
        SOUNDS.rocketFire,
        SOUNDS.rocketExplode,
        SOUNDS.grenadeFire,
        SOUNDS.grenadeBounce,
        SOUNDS.plasmaFire,
        SOUNDS.plasmaExplode,
        SOUNDS.machinegunFire,
        SOUNDS.railgunFire,
        SOUNDS.shotgunFire,
        SOUNDS.bulletRicochet,
        ...PICKUP_SOUNDS,
        // Overbounce's own, which is in no pak at all -- a recording of a run
        // through a spot is exactly where it should be heard, and `play`
        // drops what it has not decoded.
        APP_SFX.overbounce,
        ...APP_SFX.start,
        voice.jump,
        voice.fall,
        ...voice.death,
      ];
    },

    listen(origin, right): void {
      sound.setListener(origin, right);
    },

    playEvents(events, demo, weapon, emit = 'play'): void {
      if (emit === 'off') {
        return;
      }
      for (const e of events) {
        // The EVENT's own clip time, not the frame's: a footstep 12ms into a
        // 16ms frame belongs 12ms in, and it is also what its pitch and its
        // choice of sample are drawn from.
        stamp(emit, e.time);
        playMove(demo ? demoEventSound(e.event) : ghostEventSound(e.event), e.time, weapon);
        if (!demo) {
          // A ghost's pickups are not events at all -- it is re-simulated, so
          // they arrive as `GameFrame.items` and are played in `playFx`.
          continue;
        }
        /*
         * Pickups, unfiltered by `e.number`, and that is not an oversight.
         *
         * In Quake you DO hear the player next to you take an item:
         * `EV_ITEM_PICKUP` starts its sound on `es->number`, the picker
         * (cg_event.c:687 and 706), so it is positional and attenuated rather
         * than silent. But nothing but the POV can reach here. `DemoClip`'s
         * `eventsBetween` reads only `ps.events[]` and `ps.externalEvent`,
         * and stamps every one of them with the POV's own client number;
         * another player's pickup is an entity event in the snapshot, which
         * the clip decodes but deliberately does not turn into effects
         * (`CG_EntityEvent` is not ported -- see this file's header). So a
         * `number` test would be a filter that can never reject anything,
         * and adding the POV's client number to this signature would mean
         * touching `playback-session.ts`.
         *
         * The volume is the live game's (main.ts, 0.75) and unpositioned,
         * which is right for both halves: the local sound is the viewer's
         * own and the global one is a broadcast, and Quake plays neither
         * attenuated for the client who took the item.
         */
        for (const path of demoPickupSounds(e.event, e.eventParm)) {
          sound.play(path, { volume: 0.75 });
        }
      }
    },

    /**
     * `CG_EntityEvent`, for the three impacts and the two teleports a demo's
     * own entities raise. See the interface for why this is not `playEvents`.
     *
     * The cases are the ones the one real demo on hand actually contains --
     * `EV_MISSILE_MISS` fourteen times and `EV_PLAYER_TELEPORT_IN` once. The
     * rail, shotgun and bullet impacts are real events and are NOT here,
     * deliberately: they are absent from that demo, so they would be written
     * from recall and verified against nothing, which is the exact mistake
     * `.agent/plans/PLAYBACK-ENTITIES.md` opens by warning about.
     */
    playEntityEvents(events, emit) {
      const audible = emit !== 'off';
      const lit: { origin: [number, number, number]; classname: string; time: number }[] = [];
      for (const e of events) {
        const which = entityEventOf(e.event);
        if (
          which === EntityEvent.MISSILE_HIT ||
          which === EntityEvent.MISSILE_MISS ||
          which === EntityEvent.MISSILE_MISS_METAL
        ) {
          const classname = impactClassname(e.weapon);
          const origin: [number, number, number] = [e.origin[0], e.origin[1], e.origin[2]];
          /*
           * The impact NORMAL, out of the 162-entry table -- `eventParm` is
           * `DirToByte(normal)` and is an index, not an encoding.
           *
           * A zero vector means the index was out of range, which is how the
           * wire says "no direction" (`EV_RAILTRAIL` sends 255 for exactly
           * that). A mark needs a plane to lie in, so there is nothing to
           * stamp; the burst still happens, because something did explode.
           */
          const d = byteToDir(e.eventParm);
          const normal: [number, number, number] | null =
            d[0] === 0 && d[1] === 0 && d[2] === 0 ? null : [d[0], d[1], d[2]];

          stamp(emit, e.time);
          if (audible) {
            // `cg_weapons.c:1846,1855` -- the rail and the plasma share the
            // plasma explosion sound; everything else uses the rocket's.
            sound.play(
              classname === 'plasma' || classname === 'rail'
                ? SOUNDS.plasmaExplode
                : SOUNDS.rocketExplode,
              { volume: 0.8, at: origin },
            );
          }
          // The same radii `playFx` uses for a ghost, so a demo's rocket and
          // a ghost's make the same size of hole.
          const splashRadius = classname === 'plasma' ? 20 : classname === 'rail' ? 24 : 120;
          if (explosions) {
            explosions.spawnExplosion(classname, origin, e.time, splashRadius, normal ?? undefined);
          } else {
            fallback?.spawnExplosion(origin, e.time, splashRadius, normal ?? undefined);
          }
          if (normal) {
            decals?.spawnFor(classname, origin, normal, e.time);
          }
          lit.push({ origin, classname, time: e.time });
          continue;
        }
        if (
          which === EntityEvent.PLAYER_TELEPORT_IN ||
          which === EntityEvent.PLAYER_TELEPORT_OUT
        ) {
          // `cg_event.c:849,855`: both are a positional sound at the event's
          // own origin. The particle effect id draws with them is
          // `CG_SpawnEffect`, which this project has no equivalent of.
          if (audible) {
            stamp(emit, e.time);
            sound.play(SOUNDS.teleport, {
              volume: 0.7,
              at: [e.origin[0], e.origin[1], e.origin[2]],
            });
          }
        }
      }
      return lit;
    },

    playFx(fx, emit): void {
      const audible = emit !== 'off';
      for (const { frame, time } of fx) {
        // Everything this tick produced happened at the TICK's time. See
        // `stamp`: a frame-granular stamp would pile two ticks onto one
        // instant, and the ticks a drained queue hands over can be many
        // frames old.
        stamp(emit, time);
        /*
         * CLIP time, not `performance.now()`, for every mark.
         *
         * A decal ages and fades against the clock it was born on. Given the
         * wall clock, a paused clip would watch its marks fade out of a
         * frozen picture, and an export would place each mark's fade
         * according to how long the frames before it took to ENCODE -- which
         * is the one thing `frameTimes` exists to rule out. Born at the
         * tick's own time, a rocket at 1.3s drained by a forward seek to
         * 2.0s is already 700ms old, which is exactly right.
         */
        const now = time;
        /*
         * The overbounce, from the same 8ms tick the live game reads it on.
         *
         * A ghost is re-simulated, so this is not an approximation of what
         * `runCourse` heard -- it is the identical test over the identical
         * `GameFrame`, which is the whole reason `ObLandingWatch` is shared
         * rather than reimplemented on each side.
         *
         * Observed unconditionally and SOUNDED conditionally: the watch has to
         * see every tick the playhead crosses to keep its baseline honest,
         * even across a silent export frame or a paused one.
         */
        // Pmove's own velocity, for the reason `GameFrame` gives on those two
        // fields: a jump pad rewrites `frame.velocity` after pmove has run and
        // `frame.onGround` still says "grounded".
        if (obLanding.observe(frame.onGround, frame.pmoveSpeed, frame.pmoveVelocityZ)) {
          playOverbounce(emit, time);
        }
        // The subject's own gun, at full volume -- Quake plays the view
        // entity's sounds unattenuated, and the machine gun is quieter
        // because at ten rounds a second it drowns the course otherwise.
        if (frame.fired && audible) {
          sound.play(fireSound(frame.weapon), {
            volume: frame.weapon === Weapon.MACHINEGUN ? 0.4 : 0.7,
          });
        }
        for (const e of frame.explosions) {
          // `cg_weapons.c:1853`: the rail's impact is the plasma's sound.
          const isRail = e.classname === 'rail';
          if (audible) {
            sound.play(
              e.classname === 'plasma' || isRail ? SOUNDS.plasmaExplode : SOUNDS.rocketExplode,
              { volume: 0.8, at: e.origin },
            );
          }
          /*
           * Sized to the real splash radius, so the burst shows what was
           * hit: plasma is 20, a rail's ring is its mark (24), and a rocket
           * or grenade is the full 120.
           */
          const splashRadius = e.classname === 'plasma' ? 20 : isRail ? 24 : 120;
          if (explosions) {
            explosions.spawnExplosion(e.classname, e.origin, now, splashRadius, e.normal);
          } else {
            fallback?.spawnExplosion(e.origin, now, splashRadius, e.normal);
          }
          if (e.normal) {
            decals?.spawnFor(e.classname, e.origin, e.normal, now);
          }
        }
        if (audible) {
          for (const b of frame.bounces) {
            sound.play(SOUNDS.grenadeBounce, { volume: 0.5, at: b.origin });
          }
        }
        for (const hit of frame.impacts) {
          decals?.spawnFor('bullet', hit.origin, hit.normal, now);
          if (audible) {
            sound.play(SOUNDS.bulletRicochet, { volume: 0.25, at: hit.origin });
          }
        }
        // Pellet marks are SILENT: `CG_MissileHitWall` sets `sfx = 0` for
        // `WP_SHOTGUN` (cg_weapons.c:1876), which is why they are not folded
        // in with `impacts` above.
        for (const b of frame.shotgun) {
          for (const p of b.pellets) {
            decals?.spawnFor('shotgun', p.origin, p.normal, now);
          }
        }
        /*
         * A ghost's pickups.
         *
         * The other half of the demo case in `playEvents`, and it has to be
         * here rather than there because the two sources do not agree on what
         * a pickup IS. A demo has the wire's `EV_ITEM_PICKUP` with an index
         * into `bg_itemlist`; a ghost is re-simulated, so `Game` hands over
         * the `ItemEvent` with the placed item already resolved -- which is
         * also why this one may use `itemPickupSounds` directly. That helper
         * merges id's two events (see `demoPickupSounds`) and merging is
         * correct exactly here: there is no wire, nothing to be told apart,
         * and the subject is always inside the global broadcast.
         *
         * The respawn tick (`e.kind === 'respawn'`) is not played. It is a
         * different event with a different rule -- positional, at the item,
         * not at the ear -- and it is not what a silent pickup was.
         */
        for (const e of audible ? frame.items : []) {
          if (e.kind !== 'pickup') {
            continue;
          }
          for (const path of itemPickupSounds(e.placed.item)) {
            sound.play(path, { volume: 0.75 });
          }
        }
        for (const c of audible ? frame.course : []) {
          if (c.kind === 'jumppad') {
            playMove('jumppad', time);
          } else if (c.kind === 'teleport') {
            playMove('teleport', time);
          } else if (c.kind === 'start') {
            /*
             * Where Quake would say "FIGHT!". Picked from the clip clock
             * rather than rolled, like every other random term in this file --
             * a recording must sound the same every time it is played or
             * exported.
             */
            sound.playOneOf(APP_SFX.start, { volume: 0.9 }, fxRandom(time, SALT_PICK));
          } else if (c.kind === 'speaker' && c.noise) {
            // Whatever the map named -- except Quake's fight sound, which
            // `SoundSystem.play` substitutes rather than plays. See
            // `isFightSound`.
            sound.play(c.noise, { volume: 0.8 });
          }
        }
        // Doors and buttons. `G_AddEvent(ent, EV_GENERAL_SOUND, ...)` puts
        // the event on the MOVER, so the distance term is what makes a door
        // across the map quieter than the one in front of you.
        for (const m of audible ? frame.moverEvents : []) {
          if (m.kind === 'sound' && m.sound && m.origin) {
            sound.play(m.sound, { at: m.origin });
          }
        }
      }
    },

    update(timeMs, dtMs): void {
      // CLIP time and a clip-time delta, so a paused burst holds and an
      // export renders the same frame however long the encoder took -- the
      // same rule the decals and the shader clock follow.
      explosions?.update(timeMs, dtMs / 1000);
      fallback?.update(timeMs, dtMs / 1000);
    },

    playOverbounces(times, emit): void {
      for (const time of times) {
        playOverbounce(emit, time);
      }
    },

    reset(): void {
      // The overbounce baseline goes with the marks: see `obLanding`. So does
      // the cooldown -- a backward scrub means the next overbounce the
      // playhead reaches is one it is crossing afresh.
      obLanding.reset();
      obSound.reset();
      decals?.clear();
      // The bursts go with the marks. A fireball whose rocket has not been
      // fired yet is not just wrong to look at -- until `ExplosionFx` clamped
      // its own `life`, a sprite left alive across a backward seek indexed
      // its frame array with a negative number and crashed the renderer.
      explosions?.clear();
      fallback?.clear();
    },
  };
}
