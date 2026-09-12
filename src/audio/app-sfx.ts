/**
 * Overbounce's own sound effects — the ones that are not Quake's.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Everything in `SOUNDS` is a Quake III file at its Quake III path, played
 * where `cg_*.c` plays it, and every entry there can be pointed at a line of
 * id's source. Nothing in here can. These were recorded for this project, they
 * ship with it, and they answer events Quake has no opinion about: switching
 * the renderer to Faithful 1999, hitting an overbounce, beating your own time.
 *
 * They are a separate table for exactly that reason. Dropping them into
 * `SOUNDS` would make the provenance of every entry in it a question that has
 * to be answered file by file, and this project's whole claim rests on that
 * question having one answer.
 *
 * ## Not in a pak
 *
 * A player mounts their own `.pk3`s and Quake's sounds come out of them. These
 * cannot: they are the game's, not the player's, and a player who has mounted
 * nothing at all (`assets.paks` is nullable all through `playback-session.ts`)
 * must still hear them. So they live in `public/sfx/` and `SoundSystem.load`
 * fetches anything under `SFX_PREFIX` over HTTP instead of reading it out of
 * the virtual filesystem. Everything after the fetch — decode, cache, the
 * cached-null-for-a-miss rule — is the shared path, which is what makes them
 * obey the master volume and land in an exported video without a line written
 * for either.
 *
 * `public/`, not `assets/`: `/assets/` is gitignored (it is where
 * `npm run download-assets` puts fetched third-party content) and Vite does
 * not serve it. See `.agent/plans/OWN-SFX.md`.
 */

/**
 * What marks a path as ours rather than a pak's.
 *
 * A Quake sound path always starts `sound/` (`sound/player/...`,
 * `sound/weapons/...`), so there is no overlap to worry about and no pak can
 * shadow one of these.
 */
export const SFX_PREFIX = 'sfx/';

export const APP_SFX = {
  /**
   * The first — and only the first — time the player switches the renderer to
   * Faithful 1999. See `ui/faithful-sting.ts`.
   */
  faithful: 'sfx/faithful.webm',
  /**
   * A landing that converted fall speed into horizontal speed: the mechanic
   * this game is named after. Played in a live run and in playback alike; see
   * `game/overbounce.ts`'s `ObLandingWatch`.
   */
  overbounce: 'sfx/overbounce.webm',
  /**
   * The run starting: where Quake would say "FIGHT!".
   *
   * Uniform, not weighted: there are three and you hear one at the top of
   * every attempt, which is exactly the rhythm a weighting would spoil.
   */
  start: ['sfx/start/do-it.webm', 'sfx/start/fast.webm', 'sfx/start/run.webm'],
  /**
   * A new personal best, picked at random so the twentieth PB of an evening
   * does not sound like the first. Live runs only — a recording of a run is
   * not a run.
   */
  personalBest: [
    'sfx/pb/99-problems.webm',
    'sfx/pb/easy-peasy.webm',
    'sfx/pb/exquisite.webm',
    'sfx/pb/gg-easy.webm',
    'sfx/pb/new-pb.webm',
    'sfx/pb/nice-moves.webm',
    'sfx/pb/smooth-operator.webm',
  ],
} as const;

/**
 * Finishing a course WITHOUT beating your own time.
 *
 * The counterpart to `APP_SFX.personalBest`, and it needs to behave
 * differently: a PB is rare and every line in that set is a compliment, while
 * this one plays on most attempts and the lines are not all equally welcome
 * the twentieth time. So each carries a WEIGHT, and the weight lives in the
 * filename -- `100_cute.webm` comes up a hundred times as often as
 * `1_kah.webm`.
 *
 * The filename is deliberately the source of truth rather than a table here.
 * Re-weighting a line is then a rename, and adding one is a single path in
 * the list below with its weight already attached; a number repeated in two
 * places is a number that eventually disagrees with itself.
 */
const ATTEMPT_FILES: readonly string[] = [
  'sfx/attempt/100_cute.webm',
  'sfx/attempt/100_impressive.webm',
  'sfx/attempt/100_medium-rare.webm',
  'sfx/attempt/25_moms-spaghetti.webm',
  'sfx/attempt/25_send-help.webm',
  'sfx/attempt/10_go-outside.webm',
  'sfx/attempt/10_i-hate-ai.webm',
  'sfx/attempt/5_du-bist-gut-genug.webm',
  'sfx/attempt/5_touch-some-grass.webm',
  'sfx/attempt/1_kah.webm',
];

/** A candidate and how often it should come up relative to the others. */
export interface WeightedSfx {
  readonly path: string;
  readonly weight: number;
}

/**
 * The leading `<weight>_` of a filename, or 0 when there is not one.
 *
 * 0 is a real answer and it means "never play this", which is why a file that
 * does not follow the convention gets it: a typo should silence one line, not
 * hand it an arbitrary share of every other one.
 */
export function sfxWeight(path: string): number {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const match = /^(\d+)_/.exec(name);
  if (!match) {
    return 0;
  }
  const weight = Number(match[1]);
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

/**
 * The weighted set, zero-weight entries already dropped.
 *
 * Dropped rather than kept at zero: an entry with no width still has a
 * cumulative boundary, and a roll of exactly 0 would land on it. Removing it
 * is the only way "0 never plays" is true at every roll rather than almost
 * every roll.
 */
export const ATTEMPT_SFX: readonly WeightedSfx[] = ATTEMPT_FILES.map((path) => ({
  path,
  weight: sfxWeight(path),
})).filter((entry) => entry.weight > 0);

/** Every attempt line, weights aside -- for the preload. */
export const ATTEMPT_SFX_PATHS: readonly string[] = ATTEMPT_SFX.map((e) => e.path);

/**
 * Running totals, so a pick is a binary search rather than a walk.
 *
 * `CUMULATIVE[i]` is the weight of everything up to and including `i`, so the
 * entries partition `[0, total)` into one interval each, sized by weight, in
 * order. Finding which interval a roll fell into is then the classic
 * lower-bound search: the FIRST index whose running total is strictly greater
 * than the roll.
 *
 * Built once. The list is fixed at module load and a linear scan of ten
 * entries would be free, but the search is the shape that stays right when
 * the set grows, and it is two lines.
 */
const CUMULATIVE: readonly number[] = ATTEMPT_SFX.reduce<number[]>((acc, entry, i) => {
  acc.push((i === 0 ? 0 : acc[i - 1]) + entry.weight);
  return acc;
}, []);

/** The sum of every weight in `ATTEMPT_SFX`. */
export const ATTEMPT_SFX_TOTAL_WEIGHT = CUMULATIVE.length
  ? CUMULATIVE[CUMULATIVE.length - 1]
  : 0;

/**
 * Pick one, weighted. `roll` is a fraction in [0, 1); null when there is
 * nothing to pick.
 *
 * `roll` is a parameter rather than a `Math.random()` inside, for the same
 * reason `SoundSystem.playOneOf` takes one: it makes the distribution
 * testable, which for a weighted pick is the only way to know it is weighted
 * at all rather than merely random.
 *
 * The roll is clamped, and the search result is clamped to the last index.
 * A `roll` of exactly 1 -- which `Math.random()` never returns but a caller
 * might pass -- would otherwise fall off the end of every interval.
 */
export function pickWeightedSfx(
  entries: readonly WeightedSfx[] = ATTEMPT_SFX,
  roll: number = Math.random(),
): string | null {
  if (entries.length === 0) {
    return null;
  }
  // The shared table for the default set; a caller passing its own (the test)
  // gets one built here.
  const cumulative =
    entries === ATTEMPT_SFX
      ? CUMULATIVE
      : entries.reduce<number[]>((acc, entry, i) => {
          acc.push((i === 0 ? 0 : acc[i - 1]) + Math.max(0, entry.weight));
          return acc;
        }, []);
  const total = cumulative[cumulative.length - 1];
  if (!(total > 0)) {
    return null;
  }
  const target = Math.min(1, Math.max(0, roll)) * total;

  // Lower bound: the first interval whose running total is past the target.
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] > target) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return entries[lo].path;
}

/**
 * `cgs.media.countFightSound` -- Quake's "FIGHT!", registered in cg_main.c.
 *
 * Overbounce never plays it. Not "does not currently call it": `SoundSystem`
 * refuses the path outright and plays one of `APP_SFX.start` in its place, so
 * the promise holds even for the one route this codebase does not control --
 * a map's `target_speaker` names an arbitrary `noise`, and both the live game
 * (`main.ts`) and playback (`playback-fx.ts`) play it verbatim out of whatever
 * pak is mounted. A guarantee that depends on nobody ever writing the call is
 * not a guarantee.
 */
export const FIGHT_SOUND = 'sound/feedback/fight.wav';

/**
 * Is this Quake's fight sound, however it was spelled?
 *
 * Case-insensitive, because that is how a pak resolves paths -- a map author
 * writing `sound/feedback/FIGHT.wav` means the same file. Matched on the
 * BASENAME rather than the full path on purpose: a pak that ships it under
 * some other directory is still shipping it, and the point here is that the
 * player never hears it.
 */
export function isFightSound(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return name === 'fight.wav';
}

/** Is this one of ours, i.e. does `SoundSystem.load` fetch it rather than read it? */
export function isAppSfx(path: string): boolean {
  return path.startsWith(SFX_PREFIX);
}

/**
 * Where it actually is.
 *
 * `BASE_URL`, not a bare `/` — a GitHub Pages project site serves from
 * `/overbounce/`, and this is the same reason `course-world.ts` and
 * `course-select.ts` build their fetches the way they do.
 */
export function appSfxUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}

/**
 * How long the overbounce sound holds its tongue after playing, in ms.
 *
 * Overbounces cluster. A vertical one is near-perfectly elastic, so the player
 * comes back to the height they fell from, lands on the same spot and does it
 * again -- a sticky spot can chatter several times a second, and the sound was
 * reported as "quite noisy" for exactly that reason. The mechanic is still
 * worth announcing; the fourth announcement inside a second is not.
 *
 * Three seconds is the owner's number.
 */
export const OB_SOUND_COOLDOWN_MS = 3000;

/**
 * "Has long enough passed?" against a caller-supplied clock.
 *
 * The clock is a parameter, not a `performance.now()` inside, because the two
 * callers do not share one and neither should be using the wall clock: the
 * live game rate-limits on SIMULATION time (so a pause does not quietly serve
 * out the cooldown) and playback on CLIP time (so a paused or exporting clip
 * behaves like a playing one). Both are already in hand at the call site.
 *
 * Time running BACKWARDS is ready, not blocked. That is a backward scrub in
 * playback, and the sound it is about to allow is one the playhead is crossing
 * again rather than one it just played.
 */
export class SoundCooldown {
  private last: number | null = null;

  constructor(private readonly intervalMs: number) {}

  /** True if the sound may play now -- and if so, starts the interval. */
  ready(nowMs: number): boolean {
    if (this.last !== null && nowMs >= this.last && nowMs - this.last < this.intervalMs) {
      return false;
    }
    this.last = nowMs;
    return true;
  }

  /** Forget the last play: a new run, a seek, a clip swapped out. */
  reset(): void {
    this.last = null;
  }
}
