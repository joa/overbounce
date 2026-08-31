/**
 * You must be able to look at your own feet after a teleporter.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `respawn.ts` already explains this bug at length and fixes it for respawns:
 * Quake's `SetClientViewAngle` sets `delta_angles = ANGLE2SHORT(angle) -
 * cmd.angles`, which is a one-time offset there because a Q3 client keeps its
 * own `cl.viewangles` accumulator — and a permanent one here, because this input
 * layer sends ABSOLUTE angles every tick.
 *
 * `teleportPlayer` was doing exactly what that file says not to do, so the bug
 * survived in the other half of the game. The arithmetic, for a player who goes
 * through a teleporter while looking 80 degrees down at a destination whose own
 * pitch is 0:
 *
 *     delta_angles[PITCH] = ANGLE2SHORT(0) - ANGLE2SHORT(80) = -14564
 *     input clamps its accumulator at 89 degrees      =  16202
 *     so the furthest down the view can ever reach    =   1638 short = 9 degrees
 *
 * Nine degrees, forever — which is what "the view is locked" means from the
 * player's seat. And looking all the way UP unsticks it, because that drives
 * `PM_UpdateViewAngles` into its own clamp, which rewrites `delta_angles` to a
 * value derived from the clamp instead of from the stale teleport offset. A bug
 * that hides whenever you go looking for it in the obvious way.
 */

import { describe, expect, it } from 'vitest';
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import type { CLeaf, CollisionModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID } from '../../src/physics/constants.js';
import { Game } from '../../src/game/game.js';
import type { MapEntity } from '../../src/game/entities.js';

/** What `input.ts` clamps its own accumulator to. */
const INPUT_PITCH_LIMIT = 89;
/** `PM_UpdateViewAngles`' clamp, 16000 short units. */
const PMOVE_PITCH_LIMIT = (16000 * 360) / 65536; // 87.890625

function world(): CollisionModel {
  const model = brushListModel([
    axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
  ]);
  const box = { mins: [96, -64, 0] as const, maxs: [160, 64, 96] as const };
  const leafbrushes = [...Array.from(model.leafbrushes), model.brushes.length];
  model.brushes.push(
    axialBrush([...box.mins], [...box.maxs], CONTENTS_SOLID),
  );
  const leaf: CLeaf = {
    cluster: -1,
    area: -1,
    firstLeafBrush: leafbrushes.length - 1,
    numLeafBrushes: 1,
    firstLeafSurface: 0,
    numLeafSurfaces: 0,
  };
  model.leafbrushes = Int32Array.from(leafbrushes);
  model.submodels = [
    { mins: [-8192, -8192, -512], maxs: [8192, 8192, 8192], leaf: model.leafs[0] },
    { mins: [...box.mins], maxs: [...box.maxs], leaf },
  ];
  return model;
}

const entities: MapEntity[] = [
  {
    classname: 'trigger_teleport',
    targetname: null,
    target: 'dest',
    origin: [0, 0, 0],
    angles: [0, 0, 0],
    submodel: 1,
    spawnflags: 0,
    raw: {},
  },
  {
    classname: 'misc_teleporter_dest',
    targetname: 'dest',
    target: null,
    origin: [-512, 256, 40],
    // Pitch 0, like every teleport destination a mapper ever places.
    angles: [0, 135, 0],
    submodel: -1,
    spawnflags: 0,
    raw: {},
  },
];

/**
 * Walk into the teleporter holding `pitch`, then report how far down the view
 * can be aimed afterwards.
 *
 * `pitch` is passed the way `input.ts` passes it: an absolute angle, clamped to
 * the accumulator's own limit, every tick.
 */
function reachAfterTeleport(pitchGoingIn: number): { teleported: boolean; maxDown: number } {
  const game = new Game({ world: world(), entities, origin: [0, 0, 24.125] });

  let teleported = false;
  for (let i = 0; i < 200 && !teleported; i++) {
    const f = game.step({ forward: 127, yaw: 0, pitch: pitchGoingIn });
    teleported = f.course.some((e) => e.kind === 'teleport');
  }

  // Now aim straight down, as hard as the input layer allows, for long enough
  // that nothing transient is being measured.
  let maxDown = -Infinity;
  for (let i = 0; i < 20; i++) {
    game.step({ pitch: INPUT_PITCH_LIMIT, yaw: 135 });
    maxDown = Math.max(maxDown, game.ps.viewangles[0]);
  }
  return { teleported, maxDown };
}

describe('view angles after a teleporter', () => {
  it('the scenario actually teleports', () => {
    expect(reachAfterTeleport(0).teleported).toBe(true);
  });

  /*
   * The regression. `pitchGoingIn` is what makes it bite: the offset left
   * behind is exactly the pitch the player was holding, so entering a
   * teleporter while looking at the floor -- which is what you are doing on any
   * map where the teleporter is at the bottom of a rocket jump -- costs you
   * almost all of your downward aim.
   */
  for (const pitchGoingIn of [0, 30, 60, 80, INPUT_PITCH_LIMIT]) {
    it(`can still aim down after teleporting while looking ${pitchGoingIn} degrees down`, () => {
      const { teleported, maxDown } = reachAfterTeleport(pitchGoingIn);
      expect(teleported).toBe(true);
      // Within a hair of pmove's own clamp, which is the real limit.
      expect(maxDown).toBeGreaterThan(PMOVE_PITCH_LIMIT - 0.5);
    });
  }

  it('can still aim up too', () => {
    const game = new Game({ world: world(), entities, origin: [0, 0, 24.125] });
    let teleported = false;
    for (let i = 0; i < 200 && !teleported; i++) {
      const f = game.step({ forward: 127, yaw: 0, pitch: -INPUT_PITCH_LIMIT });
      teleported = f.course.some((e) => e.kind === 'teleport');
    }
    expect(teleported).toBe(true);

    let maxUp = Infinity;
    for (let i = 0; i < 20; i++) {
      game.step({ pitch: -INPUT_PITCH_LIMIT, yaw: 135 });
      maxUp = Math.min(maxUp, game.ps.viewangles[0]);
    }
    expect(maxUp).toBeLessThan(-(PMOVE_PITCH_LIMIT - 0.5));
  });

  /*
   * The teleport must still SNAP the view, which is the thing `delta_angles`
   * was there to do. Zeroing it is only correct if the caller resyncs its input
   * accumulator -- so this asserts the state the caller is told to read
   * (`ps.viewangles`), which is what `main.ts` feeds to `input.setView`.
   */
  it('still faces the destination angles on arrival', () => {
    const game = new Game({ world: world(), entities, origin: [0, 0, 24.125] });
    for (let i = 0; i < 200; i++) {
      const f = game.step({ forward: 127, yaw: 0, pitch: 20 });
      if (f.course.some((e) => e.kind === 'teleport')) {
        expect(game.ps.viewangles[1]).toBeCloseTo(135, 5);
        return;
      }
    }
    throw new Error('never teleported');
  });
});
