/**
 * Rocket jumping on a real defrag map.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * OPT-IN: skips unless DF_MAP points at a .bsp. No map is committed here — see
 * the README. Built against `mega_rl` ("blue powaaaa !!" by MegA-TecK), a VQ3
 * run map whose whole premise is rocket jumping:
 *
 *   info_player_deathmatch   112  0   32
 *   weapon_rocketlauncher    192 -4   24     count 200
 *   target_startTimer        344 -8  208
 *   target_checkpoint       9260 -12 632
 *   target_stopTimer        4220 13076 268
 *
 * The launcher sits 80 units from the spawn with 200 rockets, and the course
 * climbs from z=32 at the start to z=632 at the checkpoint. That is not a
 * height a player reaches by jumping.
 *
 *   DF_MAP=/path/to/mega_rl.bsp npm run test:game
 */

import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { loadCollisionModel, parseEntities, parseOrigin } from '../../src/collision/cm-load.js';
import type { CollisionModel } from '../../src/collision/model.js';
import { brushListModel } from '../../src/collision/model.js';
import { boxTrace } from '../../src/collision/trace.js';
import { createTrace } from '../../src/physics/types.js';
import { MASK_SHOT } from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';
import { Game } from '../../src/game/game.js';
import { Weapon } from '../../src/game/weapons.js';

// `npm run download-assets` unpacks mega_rl.bsp here once the .pk3 has been
// fetched. That one is a MANUAL entry in the manifest -- ws.q3df.org sits
// behind a Cloudflare JS challenge, so it cannot be scripted. DF_MAP overrides.
const DEFAULT_MAP = 'public/maps/mega_rl.bsp';
const mapPath = process.env.DF_MAP ?? DEFAULT_MAP;
const available = existsSync(mapPath);

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function spawnOf(model: CollisionModel): [number, number, number] {
  for (const e of parseEntities(model.entities)) {
    if (
      e.classname === 'info_player_deathmatch' ||
      e.classname === 'info_player_start'
    ) {
      const o = e.origin ? parseOrigin(e.origin) : null;
      if (o) {
        return o;
      }
    }
  }
  throw new Error('map has no spawn point');
}

/**
 * Find a spot near `from` with unbroken floor directly beneath it.
 *
 * mega_rl's spawn does NOT have this: a point trace straight down from
 * (112, 0) passes clean through into the void, while the player's 30-unit-wide
 * box rests happily on the surrounding surface. The spawn sits over a grate or
 * trench, so a rocket fired at your feet there flies into nothing and never
 * detonates. Real, and worth knowing — but not what a rocket-jump test should
 * be measuring.
 */
function solidGroundNear(
  model: CollisionModel,
  from: readonly [number, number, number],
): [number, number, number] {
  const tr = createTrace();
  const zero = vec3();

  /** Is there floor directly under this column? */
  const floorUnder = (x: number, y: number): boolean => {
    boxTrace(
      model,
      tr,
      vec3(x, y, from[2] + 16),
      zero,
      zero,
      vec3(x, y, from[2] - 64),
      MASK_SHOT,
    );
    return tr.fraction < 1 && tr.plane.normal[2] > 0.7;
  };

  for (let radius = 0; radius <= 128; radius += 4) {
    for (let a = 0; a < 8; a++) {
      const ang = (a * Math.PI) / 4;
      const x = from[0] + Math.cos(ang) * radius;
      const y = from[1] + Math.sin(ang) * radius;

      // Require floor across a small patch, not just one column. A rocket
      // does not fall straight down: pitch is clamped to 87.89 degrees, so it
      // drifts ~1.7 units forward over the 45 units it falls before impact.
      // Standing on the last solid pixel before a gap means the rocket sails
      // through the gap and never goes off.
      let ok = true;
      for (const ox of [-6, 0, 6]) {
        for (const oy of [-6, 0, 6]) {
          if (!floorUnder(x + ox, y + oy)) {
            ok = false;
          }
        }
      }
      if (ok) {
        return [x, y, from[2]];
      }
      if (radius === 0) {
        break;
      }
    }
  }
  return [from[0], from[1], from[2]];
}

function settle(game: Game, maxTicks = 600): boolean {
  let prevZ = game.ps.origin[2];
  for (let i = 0; i < maxTicks; i++) {
    game.step({});
    const z = game.ps.origin[2];
    if (game.onGround && Math.abs(z - prevZ) < 1e-4 && i > 0) {
      return true;
    }
    prevZ = z;
  }
  return false;
}

describe.skipIf(!available)(
  `defrag map (${available ? mapPath : 'absent — see npm run download-assets'})`,
  () => {
  const model = available
    ? loadCollisionModel(toArrayBuffer(readFileSync(mapPath!)))
    : null;

  it('loads and puts the player on solid ground at the spawn', () => {
    const game = new Game({
      world: model!,
      origin: spawnOf(model!),
      weapon: Weapon.ROCKET_LAUNCHER,
    });

    expect(settle(game)).toBe(true);
    expect(game.onGround).toBe(true);
  });

  it('carries the rocket launcher the map places next to the spawn', () => {
    const ents = parseEntities(model!.entities);
    const rl = ents.find((e) => e.classname === 'weapon_rocketlauncher');
    expect(rl).toBeDefined();

    const spawn = spawnOf(model!);
    const o = parseOrigin(rl!.origin!)!;
    const dist = Math.hypot(o[0] - spawn[0], o[1] - spawn[1], o[2] - spawn[2]);

    // A defrag rocket map hands you the weapon immediately; anything far away
    // would mean this test is aimed at the wrong map.
    expect(dist).toBeLessThan(200);
  });

  it('rocket jumps higher than any jump could reach', () => {
    const game = new Game({
      world: model!,
      origin: solidGroundNear(model!, spawnOf(model!)),
      weapon: Weapon.ROCKET_LAUNCHER,
    });
    settle(game);

    const groundZ = game.ps.origin[2];

    // Aim at the floor and fire. Pitch is clamped to 87.89 degrees by
    // PM_UpdateViewAngles, so this is as close to straight down as Q3 allows.
    game.step({ pitch: 90, attack: true });

    let apex = game.ps.origin[2];
    for (let i = 0; i < 500; i++) {
      game.step({ pitch: 90 });
      apex = Math.max(apex, game.ps.origin[2]);
      if (game.onGround && i > 10) {
        break;
      }
    }

    const rise = apex - groundZ;

    // A plain jump at 125Hz reaches ~48.5 units. The rocket must clear that by
    // a wide margin, on real map geometry, or the technique the map is built
    // around does not work.
    expect(rise).toBeGreaterThan(140);
    // And it costs half of the 100 splash damage.
    expect(game.ps.health).toBeLessThanOrEqual(50);
  });

  it('gains forward speed from a rocket fired behind and below', () => {
    const game = new Game({
      world: model!,
      origin: spawnOf(model!),
      weapon: Weapon.ROCKET_LAUNCHER,
    });
    settle(game);

    // Run forward, then jump and rocket down-and-back — the standard way to
    // convert a rocket into distance rather than height.
    game.run(60, { forward: 127, yaw: 0 });
    const beforeSpeed = game.speed;

    game.step({ forward: 127, yaw: 0, up: 127 });
    game.step({ forward: 127, yaw: 180, pitch: 90, attack: true });

    let peak = beforeSpeed;
    for (let i = 0; i < 120; i++) {
      game.step({ forward: 127, yaw: 0 });
      peak = Math.max(peak, game.speed);
    }

    expect(peak).toBeGreaterThan(beforeSpeed);
    // Past the 320 ground cap, which is the point of the manoeuvre.
    expect(peak).toBeGreaterThan(320);
  });

  it('agrees with an untreed brush list on point traces', () => {
    // Missiles are POINT traces, and the milestone 2 differential tests only
    // ever compared player-sized boxes. A large box has large `extents`, which
    // makes CM_TraceThroughTree visit both children generously and hides any
    // traversal error; a point has zero extents and takes the tight path.
    //
    // The brushes must be CLONED: `checkcount` lives on the brush, so a brush
    // shared between two models has the two models stamping over each other and
    // silently skipping tests.
    const m = model!;
    const reachable = new Set<number>();
    for (const leaf of m.leafs) {
      for (let k = 0; k < leaf.numLeafBrushes; k++) {
        reachable.add(m.leafbrushes[leaf.firstLeafBrush + k]);
      }
    }
    const flat = brushListModel(
      [...reachable].map((i) => ({ ...m.brushes[i], checkcount: 0 })),
    );

    const a = createTrace();
    const b = createTrace();
    const zero = vec3();
    const spawn = spawnOf(m);

    // Stay well inside the map. A trace starting out in the void beyond the
    // sealed hull is not a meaningful comparison — the tree has no leaf out
    // there to descend into, while a flat list still sees the hull from
    // outside — and Quake never traces from there either.
    let compared = 0;
    let hits = 0;
    for (let dx = -60; dx <= 60; dx += 6) {
      for (let dy = -60; dy <= 60; dy += 6) {
        const s = vec3(spawn[0] + dx, spawn[1] + dy, spawn[2] + 160);
        const e = vec3(spawn[0] + dx, spawn[1] + dy, spawn[2] - 96);
        boxTrace(m, a, s, zero, zero, e, MASK_SHOT);
        boxTrace(flat, b, s, zero, zero, e, MASK_SHOT);

        expect(b.fraction).toBe(a.fraction);
        compared++;
        if (a.fraction < 1) {
          hits++;
        }
      }
    }

    expect(compared).toBeGreaterThan(400);
    expect(hits).toBeGreaterThan(compared / 4);
  });

  it('has the defrag timer entities a run map needs', () => {
    const ents = parseEntities(model!.entities);
    const names = new Set(ents.map((e) => e.classname));

    // Milestone 6 will hang the course timer off these.
    expect(names.has('target_startTimer')).toBe(true);
    expect(names.has('target_stopTimer')).toBe(true);
  });
  },
);
