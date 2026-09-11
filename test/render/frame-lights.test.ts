/**
 * `FrameLights` against the two inline builders it replaced.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The game (`main.ts`) and a recording (`playback-session.ts`) each used to
 * assemble this frame's `DynamicLight[]` themselves, off the same constants,
 * and had already drifted apart in small ways by the time they were merged.
 * The risk in merging them is not that the new code fails to compile -- it is
 * that one of those two pictures changes by a hair and nobody notices until a
 * recording of a run looks unlike the run.
 *
 * So this is a DIFFERENTIAL test, not an expectation test. The two functions
 * below are the pre-merge builders copied verbatim, with the one part that is
 * not a pure function of the inputs -- `Math.random()` in the game's flicker
 * -- lifted into an argument. Every case asserts that `FrameLights`, driven
 * the way its caller now drives it, produces exactly what the old code did.
 * If a "tidy-up" ever reorders a push, drops a `shadows: true`, or decides
 * the muzzle flash should scale with `?missilelight` too, one of these fails.
 *
 * The grid is deliberately dull and wide rather than clever: both explosion
 * ramps, both sides of the 300ms hold/fade boundary, both `?missilelight`
 * settings, all three projectile kinds (one of which must add nothing), and
 * every weapon (one of which must add nothing).
 */

import { describe, it, expect } from 'vitest';
import {
  FLASH_DLIGHT_COLOR,
  MUZZLE_FLASH_LIGHT,
  MUZZLE_FLASH_TIME,
  Weapon,
} from '../../src/game/weapons.js';
import {
  PLASMA_EXPLOSION_LIGHT,
  PLASMA_LIGHT_COLOR,
  PLASMA_MISSILE_LIGHT,
  ROCKET_EXPLOSION_LIGHT,
  ROCKET_LIGHT_COLOR,
  ROCKET_MISSILE_LIGHT,
} from '../../src/render/dynamic-lights.js';
import type { DynamicLight } from '../../src/render/dynamic-lights.js';
import { EXPLOSION_LIGHT_TIME, FrameLights } from '../../src/render/frame-lights.js';

type Flash = { at: [number, number, number]; time: number; weapon: Weapon } | null;

/** What `main.ts` kept per burst, including the redundant `end` it used to carry. */
interface GameExplosion {
  origin: number[];
  classname: string;
  start: number;
  end: number;
}

/** What `playback-session.ts` keeps per burst: clip time, no `end`. */
interface ClipExplosion {
  origin: [number, number, number];
  classname: string;
  start: number;
}

/** `main.ts`'s `updateLights`, verbatim as of before the extraction. */
function legacyGameLights(
  missiles: readonly { classname: string; currentOrigin: number[] }[],
  litExplosions: GameExplosion[],
  muzzleFlash: Flash,
  nowMs: number,
  missileLightScale: number,
  flicker: number,
): DynamicLight[] {
  const live: DynamicLight[] = [];

  for (const m of missiles) {
    if (m.classname === 'rocket') {
      live.push({
        origin: m.currentOrigin,
        radius: ROCKET_MISSILE_LIGHT * missileLightScale,
        color: ROCKET_LIGHT_COLOR,
        shadows: true,
      });
    } else if (m.classname === 'plasma') {
      live.push({
        origin: m.currentOrigin,
        radius: PLASMA_MISSILE_LIGHT * missileLightScale,
        color: PLASMA_LIGHT_COLOR,
        shadows: true,
      });
    }
  }

  for (let i = litExplosions.length - 1; i >= 0; i--) {
    const e = litExplosions[i];
    if (nowMs >= e.end) {
      litExplosions.splice(i, 1);
      continue;
    }
    const t = (nowMs - e.start) / (e.end - e.start);
    const scale = t < 0.5 ? 1 : 1 - (t - 0.5) * 2;
    const isPlasma = e.classname === 'plasma';
    live.push({
      origin: e.origin,
      radius:
        (isPlasma ? PLASMA_EXPLOSION_LIGHT : ROCKET_EXPLOSION_LIGHT) * scale * missileLightScale,
      color: isPlasma ? PLASMA_LIGHT_COLOR : ROCKET_LIGHT_COLOR,
      shadows: true,
    });
  }

  if (muzzleFlash && nowMs - muzzleFlash.time < MUZZLE_FLASH_TIME) {
    const color = FLASH_DLIGHT_COLOR[muzzleFlash.weapon];
    if (color[0] || color[1] || color[2]) {
      live.push({
        origin: muzzleFlash.at,
        radius: MUZZLE_FLASH_LIGHT + flicker,
        color,
      });
    }
  }

  return live;
}

/** `playback-session.ts`'s inline builder, verbatim as of before the extraction. */
function legacyClipLights(
  sightings: readonly { kind: string; origin: readonly [number, number, number] }[],
  litExplosions: ClipExplosion[],
  muzzleFlash: Flash,
  t: number,
  missileLightScale: number,
  flicker: number,
): DynamicLight[] {
  const liveLights: DynamicLight[] = [];
  for (const m of sightings) {
    if (m.kind === 'rocket') {
      liveLights.push({
        origin: m.origin,
        radius: ROCKET_MISSILE_LIGHT * missileLightScale,
        color: ROCKET_LIGHT_COLOR,
        shadows: true,
      });
    } else if (m.kind === 'plasma') {
      liveLights.push({
        origin: m.origin,
        radius: PLASMA_MISSILE_LIGHT * missileLightScale,
        color: PLASMA_LIGHT_COLOR,
        shadows: true,
      });
    }
  }
  for (let i = litExplosions.length - 1; i >= 0; i--) {
    const e = litExplosions[i]!;
    const since = t - e.start;
    if (since < 0 || since >= 600) {
      litExplosions.splice(i, 1);
      continue;
    }
    const f = since / 600;
    const scale = f < 0.5 ? 1 : 1 - (f - 0.5) * 2;
    const isPlasma = e.classname === 'plasma';
    liveLights.push({
      origin: e.origin,
      radius:
        (isPlasma ? PLASMA_EXPLOSION_LIGHT : ROCKET_EXPLOSION_LIGHT) * scale * missileLightScale,
      color: isPlasma ? PLASMA_LIGHT_COLOR : ROCKET_LIGHT_COLOR,
      shadows: true,
    });
  }
  if (muzzleFlash) {
    const since = t - muzzleFlash.time;
    if (since >= 0 && since < MUZZLE_FLASH_TIME) {
      const color = FLASH_DLIGHT_COLOR[muzzleFlash.weapon];
      if (color[0] || color[1] || color[2]) {
        liveLights.push({
          origin: muzzleFlash.at,
          radius: MUZZLE_FLASH_LIGHT + flicker,
          color,
        });
      }
    }
  }
  return liveLights;
}

/** The game's call sequence as `updateLights` now has it. */
function gameLights(
  missiles: readonly { classname: string; currentOrigin: number[] }[],
  litExplosions: { origin: number[]; classname: string; start: number }[],
  muzzleFlash: Flash,
  nowMs: number,
  missileLightScale: number,
  flicker: number,
): DynamicLight[] {
  const frame = new FrameLights(missileLightScale);
  for (const m of missiles) {
    frame.addMissile(m.classname, m.currentOrigin);
  }
  for (let i = litExplosions.length - 1; i >= 0; i--) {
    const e = litExplosions[i];
    const since = nowMs - e.start;
    if (since >= EXPLOSION_LIGHT_TIME) {
      litExplosions.splice(i, 1);
      continue;
    }
    frame.addExplosion(e.classname, e.origin, since);
  }
  if (muzzleFlash && nowMs - muzzleFlash.time < MUZZLE_FLASH_TIME) {
    frame.addMuzzleFlash(muzzleFlash.weapon, muzzleFlash.at, flicker);
  }
  return frame.lights;
}

/** Playback's call sequence as `renderAt` now has it. */
function clipLights(
  sightings: readonly { kind: string; origin: readonly [number, number, number] }[],
  litExplosions: ClipExplosion[],
  muzzleFlash: Flash,
  t: number,
  missileLightScale: number,
  flicker: number,
): DynamicLight[] {
  const frame = new FrameLights(missileLightScale);
  for (const m of sightings) {
    frame.addMissile(m.kind, m.origin);
  }
  for (let i = litExplosions.length - 1; i >= 0; i--) {
    const e = litExplosions[i]!;
    const since = t - e.start;
    if (since < 0 || since >= EXPLOSION_LIGHT_TIME) {
      litExplosions.splice(i, 1);
      continue;
    }
    frame.addExplosion(e.classname, e.origin, since);
  }
  if (muzzleFlash) {
    const since = t - muzzleFlash.time;
    if (since >= 0 && since < MUZZLE_FLASH_TIME) {
      frame.addMuzzleFlash(muzzleFlash.weapon, muzzleFlash.at, flicker);
    }
  }
  return frame.lights;
}

const KINDS = ['rocket', 'plasma', 'grenade'];
const SCALES = [1, 4];
/** Both sides of the 300ms hold/fade boundary, plus the expiry edges. */
const SINCE = [0, 1, 150, 299, 300, 301, 450, 599, 600, 601];
const WEAPONS = [
  Weapon.NONE,
  Weapon.ROCKET_LAUNCHER,
  Weapon.GRENADE_LAUNCHER,
  Weapon.PLASMAGUN,
  Weapon.MACHINEGUN,
  Weapon.RAILGUN,
  Weapon.SHOTGUN,
];

describe('FrameLights matches the game builder it replaced', () => {
  it('agrees on every projectile kind, burst age and light scale', () => {
    const now = 100_000;
    for (const scale of SCALES) {
      for (const kind of KINDS) {
        for (const since of SINCE) {
          const missiles = [{ classname: kind, currentOrigin: [10, 20, 30] }];
          const legacyList: GameExplosion[] = [
            { origin: [1, 2, 3], classname: kind, start: now - since, end: now - since + 600 },
          ];
          const list = [{ origin: [1, 2, 3], classname: kind, start: now - since }];
          const flash: Flash = { at: [4, 5, 6], time: now - 10, weapon: Weapon.ROCKET_LAUNCHER };

          expect(gameLights(missiles, list, flash, now, scale, 7)).toStrictEqual(
            legacyGameLights(missiles, legacyList, flash, now, scale, 7),
          );
          // The sweep is the caller's, and an expired burst has to be gone
          // from the list as well as from the frame.
          expect(list.length).toBe(legacyList.length);
        }
      }
    }
  });

  it('agrees on every weapon, including the one whose flash adds no light', () => {
    const now = 5_000;
    for (const weapon of WEAPONS) {
      const flash: Flash = { at: [4, 5, 6], time: now - 5, weapon };
      expect(gameLights([], [], flash, now, 1, 31)).toStrictEqual(
        legacyGameLights([], [], flash, now, 1, 31),
      );
    }
    // `Weapon.NONE` is the case that proves the `flashDlightColor` guard
    // survived the move: a black light is not the same as no light.
    expect(FLASH_DLIGHT_COLOR[Weapon.NONE]).toStrictEqual([0, 0, 0]);
    expect(gameLights([], [], { at: [0, 0, 0], time: now, weapon: Weapon.NONE }, now, 1, 0)).toHaveLength(0);
  });

  it('agrees with the flash outside its window, and with no flash at all', () => {
    const now = 5_000;
    const flash: Flash = { at: [4, 5, 6], time: now - MUZZLE_FLASH_TIME, weapon: Weapon.RAILGUN };
    expect(gameLights([], [], flash, now, 1, 3)).toStrictEqual(
      legacyGameLights([], [], flash, now, 1, 3),
    );
    expect(gameLights([], [], null, now, 1, 3)).toStrictEqual(
      legacyGameLights([], [], null, now, 1, 3),
    );
  });
});

describe('FrameLights matches the playback builder it replaced', () => {
  it('agrees on every projectile kind, burst age and light scale', () => {
    const t = 12_345;
    for (const scale of SCALES) {
      for (const kind of KINDS) {
        for (const since of SINCE) {
          const sightings = [{ kind, origin: [10, 20, 30] as [number, number, number] }];
          const mk = (): ClipExplosion[] => [
            { origin: [1, 2, 3], classname: kind, start: t - since },
          ];
          const a = mk();
          const b = mk();
          const flash: Flash = { at: [4, 5, 6], time: t - 10, weapon: Weapon.PLASMAGUN };

          expect(clipLights(sightings, a, flash, t, scale, 7)).toStrictEqual(
            legacyClipLights(sightings, b, flash, t, scale, 7),
          );
          expect(a.length).toBe(b.length);
        }
      }
    }
  });

  it('agrees on a burst and a flash stamped in the FUTURE, which a scrub can do', () => {
    // The game's clock only rises, so this case exists on the playback side
    // alone -- and it is the one that would silently go wrong if the shared
    // builder had swallowed the window test.
    const t = 1_000;
    const a: ClipExplosion[] = [{ origin: [1, 2, 3], classname: 'rocket', start: t + 200 }];
    const b: ClipExplosion[] = [{ origin: [1, 2, 3], classname: 'rocket', start: t + 200 }];
    const flash: Flash = { at: [4, 5, 6], time: t + 50, weapon: Weapon.MACHINEGUN };

    expect(clipLights([], a, flash, t, 4, 9)).toStrictEqual(legacyClipLights([], b, flash, t, 4, 9));
    expect(clipLights([], a, flash, t, 4, 9)).toHaveLength(0);
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(0);
  });
});

describe('the parts of the list that are not the fade', () => {
  it('keeps missiles, then explosions, then the flash', () => {
    // `DynamicLights.set` keeps the first eight in the caller's order and, on
    // overflow, sorts by distance with a stable sort -- so insertion order is
    // observable in both paths and is not free to change.
    const frame = new FrameLights(1);
    frame.addMissile('rocket', [1, 0, 0]);
    frame.addExplosion('rocket', [2, 0, 0], 0);
    frame.addMuzzleFlash(Weapon.MACHINEGUN, [3, 0, 0], 0);
    expect(frame.lights.map((l) => l.origin[0])).toStrictEqual([1, 2, 3]);
  });

  it('does not scale the muzzle flash by ?missilelight', () => {
    // The knob is a RADIUS multiplier for projectile and explosion lights, so
    // a moving shadow is findable on a side camera. The flash is a 20ms strobe
    // at the player's own gun and is never the thing that is hard to find --
    // neither caller scaled it, and neither does this.
    const frame = new FrameLights(4);
    frame.addMuzzleFlash(Weapon.MACHINEGUN, [0, 0, 0], 5);
    expect(frame.lights[0].radius).toBe(MUZZLE_FLASH_LIGHT + 5);
    frame.addMissile('rocket', [0, 0, 0]);
    expect(frame.lights[1].radius).toBe(ROCKET_MISSILE_LIGHT * 4);
  });

  it('holds an explosion at full brightness for half its life, then fades', () => {
    // cg_localents.c, and the HOLD is the half worth pinning: without it a
    // rocket hit fades in rather than flashing.
    const at = (since: number): number => {
      const frame = new FrameLights(1);
      frame.addExplosion('rocket', [0, 0, 0], since);
      return frame.lights[0].radius;
    };
    expect(at(0)).toBe(ROCKET_EXPLOSION_LIGHT);
    expect(at(299)).toBe(ROCKET_EXPLOSION_LIGHT);
    expect(at(300)).toBeCloseTo(ROCKET_EXPLOSION_LIGHT, 10);
    expect(at(450)).toBeCloseTo(ROCKET_EXPLOSION_LIGHT * 0.5, 10);
    expect(at(599)).toBeLessThan(ROCKET_EXPLOSION_LIGHT * 0.01);
    expect(EXPLOSION_LIGHT_TIME).toBe(600);
  });

  it('gives a grenade no light, as Quake gives only the rocket a missileDlight', () => {
    const frame = new FrameLights(1);
    frame.addMissile('grenade', [0, 0, 0]);
    frame.addMissile('rail', [0, 0, 0]);
    expect(frame.lights).toHaveLength(0);
  });
});
