/**
 * The CTF flag run: take a flag, reach the other one, that is the clock.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A `ctf` map has no `target_startTimer`, so it loads here as FREERUN and
 * there is nothing to beat on it. DeFRaG's answer is the obvious one: the
 * flags are the gates. Take either flag, reach the other team's, and the time
 * between is the run.
 *
 * **Symmetric, deliberately.** Red to blue and blue to red are one run and
 * share one personal best. The owner who asked for this was explicit that they
 * did not know which direction is canonical and that both modes exist, and on
 * a route that is the same route backwards, two sets of records buy nothing.
 *
 * **This rule is DeFRaG's, and DeFRaG is closed source.** It is here as a
 * specification, the same standing as this project's CPM constants and its
 * `target_init` spawnflags: implemented to what was asked for, never described
 * as a verified port. What IS ported, and cited where it is used, is the
 * mechanism underneath it -- `Touch_Item`'s "a zero respawn means nothing
 * happened, leave the item alone" and its negative-respawn convention, both of
 * which `g_items.c` has and both of which exist in id's source precisely
 * because CTF flags needed them.
 *
 * See `.agent/plans/FLAG-RUN.md`.
 */

import { Powerup } from './items.js';
import type { Item } from './items.js';
import type { PlayerState } from '../physics/types.js';
import type { Gametype } from './entities.js';

/**
 * The two flags a run can run between.
 *
 * `team_CTF_neutralflag` is deliberately not one of them. One-flag CTF has no
 * "the other team's flag" to reach, so a map carrying only a neutral flag is
 * not a flag-run map.
 */
export type FlagTeam = 'red' | 'blue';

/** Which `powerup_t` slot holds each flag, exactly as Quake stores it. */
export const FLAG_POWERUP: Record<FlagTeam, Powerup> = {
  red: Powerup.REDFLAG,
  blue: Powerup.BLUEFLAG,
};

export const FLAG_CLASSNAME: Record<FlagTeam, string> = {
  red: 'team_CTF_redflag',
  blue: 'team_CTF_blueflag',
};

/**
 * How long a carried flag lasts, in the `ps.powerups` expiry the rest of the
 * powerup code reads.
 *
 * `INT_MAX`, which is Quake's own value for it (`Pickup_Team` sets
 * `client->ps.powerups[PW_REDFLAG] = INT_MAX`) and means simply: a flag does
 * not wear off. `ps.powerups` is an `Int32Array`, so this is the largest value
 * that survives the store -- `Number.MAX_SAFE_INTEGER` would not.
 *
 * The HUD's wear-off blink ignores anything further away than
 * `POWERUP_BLINKS * POWERUP_BLINK_TIME`, so a carried flag never blinks or
 * plays the expiry sound.
 */
export const FLAG_CARRY_UNTIL = 2147483647;

/** Which flag this `powerup_t` slot is, or null for anything else. */
export function flagTeamOfPowerup(tag: number): FlagTeam | null {
  if (tag === Powerup.REDFLAG) {
    return 'red';
  }
  if (tag === Powerup.BLUEFLAG) {
    return 'blue';
  }
  return null;
}

/** Which flag this item is, or null -- including for the neutral flag. */
export function flagTeamOfItem(item: Item): FlagTeam | null {
  return flagTeamOfPowerup(item.tag);
}

/** The one you have to reach while carrying the other. */
export function otherFlag(team: FlagTeam): FlagTeam {
  return team === 'red' ? 'blue' : 'red';
}

/**
 * Is this map timed by its flags?
 *
 * Both flags have to be there -- one is a decoration, and a neutral flag is
 * one-flag CTF, which this mode has no answer for.
 *
 * The caller is responsible for the other half of the test: a map with a real
 * `target_startTimer` is an ordinary course and stays one, however many flags
 * a mapper hung on its walls. `isFlagRunMap` is about the flags alone so that
 * the two conditions read separately at both call sites (`course-world.ts`,
 * `course-scan.ts`) instead of one predicate quietly deciding both.
 *
 * Takes classnames rather than entities because those two call sites hold
 * different things: one has parsed `MapEntity`s, the other the raw key/value
 * dictionaries `readEntityLump` gives before a `Course` exists. The test is
 * the same test and must not be written twice.
 */
export function isFlagRunMap(classnames: Iterable<string | undefined>): boolean {
  let red = false;
  let blue = false;
  for (const classname of classnames) {
    if (classname === FLAG_CLASSNAME.red) {
      red = true;
    } else if (classname === FLAG_CLASSNAME.blue) {
      blue = true;
    }
  }
  return red && blue;
}

/**
 * Which gametype to spawn a map's entities for -- the ONE place that decides.
 *
 * `'ctf'` when the map's entity lump has both flags and no `target_startTimer`,
 * which is precisely the flag-run test; `'ffa'` otherwise. A defrag map with a
 * real start gate and flags hung on it as decoration is an ordinary course and
 * stays free-for-all, because its own gates are the ones that count.
 *
 * **Read the RAW lump, before any filtering.** That is the whole point: on
 * q3ctf1 the flags are marked `notfree`, so filtering as free-for-all first
 * and asking afterwards answers "no flags, therefore not CTF, therefore filter
 * as free-for-all" -- which is how a CTF map loaded with no flags in it at all
 * (see `entities.ts`'s `wantedFor`). The question has to be asked of what the
 * mapper wrote, not of what one guess at the gametype left behind.
 *
 * One function rather than the same three lines in `course-world.ts` and
 * `course-scan.ts`, so the badge on the course card and the map the player
 * actually loads cannot disagree about which mode it is.
 */
export function mapGametype(classnames: Iterable<string | undefined>): Gametype {
  let red = false;
  let blue = false;
  for (const classname of classnames) {
    if (classname === 'target_startTimer') {
      return 'ffa';
    }
    if (classname === FLAG_CLASSNAME.red) {
      red = true;
    } else if (classname === FLAG_CLASSNAME.blue) {
      blue = true;
    }
  }
  return red && blue ? 'ctf' : 'ffa';
}

/**
 * What touching a flag does, given what the player is already carrying.
 *
 * Split out from the pickup itself so the rule can be read, and tested,
 * without a `Game`: it is the one piece of this feature that is a decision
 * rather than a mechanism.
 *
 * - Carrying nothing: **take** it. The flag leaves its stand.
 * - Carrying the other flag: **capture**. The run ends here; this flag never
 *   leaves its stand, which is why a capture is a touch and not a pickup.
 * - Carrying this same flag: nothing. It cannot happen while a taken flag is
 *   off its stand, but it is the third case and answering it is cheaper than
 *   assuming it away.
 */
export function flagTouch(carrying: FlagTeam | null, touched: FlagTeam): FlagAction | null {
  if (carrying === null) {
    return 'take';
  }
  if (carrying === otherFlag(touched)) {
    return 'capture';
  }
  return null;
}

export type FlagAction = 'take' | 'capture';

/** What the player is carrying, read out of `ps.powerups` where Quake keeps it. */
export function carriedFlag(ps: PlayerState): FlagTeam | null {
  if (ps.powerups[Powerup.REDFLAG] > 0) {
    return 'red';
  }
  if (ps.powerups[Powerup.BLUEFLAG] > 0) {
    return 'blue';
  }
  return null;
}

/**
 * Put a flag in the player's hands, or take it back out.
 *
 * Written straight into `ps.powerups` rather than into a field of this
 * module's own, because that is where Quake keeps it and because everything
 * that already clears player state clears it for free -- `ClientSpawn`'s
 * `ps.powerups.fill(0)` is what makes dying drop the flag, and neither this
 * module nor `Game` has to know that happened.
 */
export function setCarriedFlag(ps: PlayerState, team: FlagTeam, carried: boolean): void {
  ps.powerups[FLAG_POWERUP[team]] = carried ? FLAG_CARRY_UNTIL : 0;
}
