/**
 * The CTF flag run: take a flag, reach the other one, that is the clock.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Driven through a real `Game` rather than by calling the rule directly,
 * because the rule is the easy half. The half that can be wrong invisibly is
 * the plumbing: whether a flag comes off its stand, whether the flag that
 * ends the run stays on its, whether the tick after a capture quietly starts
 * a new run, and whether the events reach the frame at all. None of that is
 * observable from `flagTouch`.
 *
 * The flags are placed 400 units apart and the player is teleported between
 * them, rather than walked. Walking there is a movement test and this is not
 * one -- what matters is the ORDER of touches and what each one did.
 */

import { describe, it, expect } from 'vitest';
import { Game } from '../../src/game/game.js';
import { buildEntities } from '../../src/game/entities.js';
import { Powerup } from '../../src/game/items.js';
import { carriedFlag, flagTouch, isFlagRunMap } from '../../src/game/flag-run.js';
import { Weapon } from '../../src/game/weapons.js';
import { flatWorld } from '../physics/world.js';
import type { GameFrame } from '../../src/game/game.js';

const RED_AT = '0 0 40';
const BLUE_AT = '400 0 40';

/** Both flags on a flat floor, 400 units apart. */
function ctfGame(classnames: readonly { classname: string; origin: string }[] = [
  { classname: 'team_CTF_redflag', origin: RED_AT },
  { classname: 'team_CTF_blueflag', origin: BLUE_AT },
]): Game {
  return new Game({
    world: flatWorld(),
    origin: [-400, 0, 40],
    weapon: Weapon.MACHINEGUN,
    entities: buildEntities([...classnames]),
    spawn: { origin: [-400, 0, 40], yaw: 0 },
  });
}

/** Put the player on a flag's stand and step once. Returns the frame. */
function stepAt(g: Game, x: number): GameFrame {
  g.ps.origin[0] = x;
  g.ps.origin[1] = 0;
  // Items rest 24 above the floor and the touch is box-against-box; standing
  // on the floor at the same x/y is inside it.
  g.ps.origin[2] = 24;
  return g.step({});
}

/** Step in place, touching nothing new. */
function stepAway(g: Game): GameFrame {
  g.ps.origin[0] = -400;
  return g.step({});
}

describe('isFlagRunMap', () => {
  it('needs both flags', () => {
    expect(isFlagRunMap(['team_CTF_redflag', 'team_CTF_blueflag'])).toBe(true);
    expect(isFlagRunMap(['team_CTF_redflag'])).toBe(false);
    expect(isFlagRunMap(['team_CTF_blueflag'])).toBe(false);
    expect(isFlagRunMap([])).toBe(false);
  });

  it('is not satisfied by the neutral flag', () => {
    // One-flag CTF: there is no "the other team's flag" to reach.
    expect(isFlagRunMap(['team_CTF_neutralflag'])).toBe(false);
    expect(isFlagRunMap(['team_CTF_neutralflag', 'team_CTF_redflag'])).toBe(false);
  });

  it('tolerates an entity with no classname at all', () => {
    expect(isFlagRunMap([undefined, 'team_CTF_redflag', 'team_CTF_blueflag'])).toBe(true);
  });
});

describe('flagTouch', () => {
  it('is symmetric: either flag starts, the other finishes', () => {
    expect(flagTouch(null, 'red')).toBe('take');
    expect(flagTouch(null, 'blue')).toBe('take');
    expect(flagTouch('red', 'blue')).toBe('capture');
    expect(flagTouch('blue', 'red')).toBe('capture');
  });

  it('does nothing for the flag already in hand', () => {
    expect(flagTouch('red', 'red')).toBe(null);
    expect(flagTouch('blue', 'blue')).toBe(null);
  });
});

describe('a flag run through a real Game', () => {
  it('starts the course timer on the first flag and stops it on the second', () => {
    const g = ctfGame();
    expect(g.course?.runState).toBe('idle');

    const take = stepAt(g, 0);
    expect(take.items.some((e) => e.flag?.action === 'take')).toBe(true);
    expect(g.course?.runState).toBe('running');
    // The same event a `target_startTimer` raises -- which is the whole
    // reason records, splits and the results screen need no idea this mode
    // exists.
    expect(take.course.some((e) => e.kind === 'start')).toBe(true);
    expect(carriedFlag(g.ps)).toBe('red');

    // Time passes between the gates.
    for (let i = 0; i < 50; i++) {
      stepAway(g);
    }

    const capture = stepAt(g, 400);
    expect(capture.items.some((e) => e.flag?.action === 'capture')).toBe(true);
    expect(g.course?.runState).toBe('finished');
    const finish = capture.course.find((e) => e.kind === 'finish');
    expect(finish).toBeDefined();
    expect(finish!.elapsed).toBeGreaterThan(0);
    expect(carriedFlag(g.ps)).toBe(null);
  });

  it('runs blue to red as well as red to blue', () => {
    const g = ctfGame();
    stepAt(g, 400);
    expect(carriedFlag(g.ps)).toBe('blue');
    expect(g.course?.runState).toBe('running');

    stepAway(g);
    const capture = stepAt(g, 0);
    expect(capture.items.some((e) => e.flag?.action === 'capture')).toBe(true);
    expect(g.course?.runState).toBe('finished');
  });

  it('does NOT start a new run while still standing on the flag it finished on', () => {
    // The trap this whole edge-detection exists for. `ItemWorld.update` fires
    // on every tick the boxes overlap; the tick after a capture the player is
    // still inside the finish flag's box, carrying nothing, with that flag
    // present -- which is a TAKE. Without an edge the run would go finished
    // -> running before the results screen ever opened.
    const g = ctfGame();
    stepAt(g, 0);
    stepAway(g);
    stepAt(g, 400);
    expect(g.course?.runState).toBe('finished');

    for (let i = 0; i < 20; i++) {
      const f = stepAt(g, 400);
      expect(f.items.some((e) => e.flag)).toBe(false);
    }
    expect(g.course?.runState).toBe('finished');
    expect(carriedFlag(g.ps)).toBe(null);
  });

  it('lets a fresh run start by walking OUT of the flag and back in', () => {
    // The other side of the same coin: the edge is what makes a second
    // attempt possible at all, so it had better still fire.
    const g = ctfGame();
    stepAt(g, 0);
    stepAway(g);
    stepAt(g, 400);
    expect(g.course?.runState).toBe('finished');

    stepAway(g);
    const again = stepAt(g, 400);
    expect(again.items.some((e) => e.flag?.action === 'take')).toBe(true);
    expect(g.course?.runState).toBe('running');
    expect(carriedFlag(g.ps)).toBe('blue');
  });

  it('takes a flag off its stand and puts it back on a capture', () => {
    const g = ctfGame();
    const red = g.itemWorld!.items.find((p) => p.entity.classname === 'team_CTF_redflag')!;
    const blue = g.itemWorld!.items.find((p) => p.entity.classname === 'team_CTF_blueflag')!;

    stepAt(g, 0);
    expect(red.present).toBe(false);
    // "A negative respawn time means to never respawn this item (but don't
    // delete it)" -- g_items.c. Nothing but a capture or a restart brings it
    // back, so a run cannot be undone by standing around.
    expect(red.respawnAt).toBe(Number.POSITIVE_INFINITY);
    expect(blue.present).toBe(true);

    stepAway(g);
    stepAt(g, 400);
    // Both home again the moment the clock stops, so the next attempt can
    // start from either end without waiting.
    expect(red.present).toBe(true);
    expect(blue.present).toBe(true);
  });

  it('drops the flag and resets the clock when the player dies carrying it', () => {
    const g = ctfGame();
    stepAt(g, 0);
    expect(g.course?.runState).toBe('running');
    expect(g.ps.powerups[Powerup.REDFLAG]).toBeGreaterThan(0);

    g.ps.health = 0;
    g.step({});

    // `ClientSpawn` wipes `ps.powerups`, which is exactly why the carried flag
    // lives there and not in a field of this feature's own.
    expect(carriedFlag(g.ps)).toBe(null);
    expect(g.course?.runState).toBe('idle');
    const red = g.itemWorld!.items.find((p) => p.entity.classname === 'team_CTF_redflag')!;
    expect(red.present).toBe(true);
  });

  it('leaves a one-flag map alone', () => {
    // No second gate, so the flag is scenery. It must not start a clock that
    // can never be stopped.
    const g = ctfGame([{ classname: 'team_CTF_redflag', origin: RED_AT }]);
    const f = stepAt(g, 0);
    // The touch still does what a touch does -- there is nothing map-level
    // here refusing it -- but `course-world.ts` never calls such a map timed,
    // so no run is ever recorded on it. What must NOT happen is a capture.
    expect(f.items.some((e) => e.flag?.action === 'capture')).toBe(false);
  });

  it('ignores the neutral flag entirely', () => {
    const g = ctfGame([
      { classname: 'team_CTF_neutralflag', origin: RED_AT },
      { classname: 'team_CTF_blueflag', origin: BLUE_AT },
    ]);
    const f = stepAt(g, 0);
    expect(f.items.some((e) => e.flag)).toBe(false);
    expect(carriedFlag(g.ps)).toBe(null);
    expect(g.course?.runState).toBe('idle');
  });
});
