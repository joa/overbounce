/**
 * `shooter_rocket`/`shooter_grenade`/`shooter_plasma`, with and without
 * DeFRaG's `_targetplayer` suffix.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `Use_Shooter`/`InitShooter` (g_misc.c) are real id source and a verified
 * port -- confirmed present in `refs/quake3/game/g_misc.c` before writing a
 * line of this. TARGETPLAYER/PREDICT_XY/PREDICT_Z is the DeFRaG
 * `_targetplayer` extension (ws.q3df.org, `.agent/docs/defrag-entities-spec.xml`),
 * community-documented with no lead-prediction formula given, so those tests
 * pin THIS project's own linear-lead interpretation rather than a verified
 * number -- see `aimShooter`'s doc in `src/game/course.ts`.
 */

import { describe, it, expect } from 'vitest';
import { axialBrush } from '../../src/collision/brush.js';
import type { CLeaf, CollisionModel } from '../../src/collision/model.js';
import { brushListModel } from '../../src/collision/model.js';
import { Course } from '../../src/game/course.js';
import type { MapEntity } from '../../src/game/entities.js';
import { CONTENTS_SOLID, CONTENTS_TRIGGER } from '../../src/physics/constants.js';
import { createPlayerState } from '../../src/physics/types.js';
import { vectorLength } from '../../src/math/vec3.js';
import { Game } from '../../src/game/game.js';

function world(): CollisionModel {
  const floor = axialBrush([-1024, -1024, -64], [1024, 1024, 0], CONTENTS_SOLID);
  return brushListModel([floor]);
}

function entity(fields: Partial<MapEntity> & { classname: string }): MapEntity {
  return {
    targetname: null,
    target: null,
    origin: [0, 0, 0],
    angles: [0, 0, 0],
    submodel: -1,
    spawnflags: 0,
    raw: {},
    ...fields,
  };
}

/** A `rng` that always lands on 0.5 -- `crandom` returns exactly 0, so `Use_Shooter`'s random cone contributes no deviation and a fired shot points exactly at its resolved aim direction. */
const noDeviation = (): number => 0.5;

/** Fires a `targetname` via `fireTargetChain` -- shooters are point entities activated by name, not brush triggers, so there is no volume to stand a player in. */
function fire(
  entities: MapEntity[],
  targetname: string,
  ps = createPlayerState(),
  rng: () => number = noDeviation,
) {
  const course = new Course({ world: world(), entities, rng });
  return course.fireTargetChain(targetname, 1000, ps);
}

describe('shooter_rocket/_grenade/_plasma', () => {
  it('aims at its target_position with no deviation when random is neutralized', () => {
    const events = fire(
      [
        entity({ classname: 'shooter_rocket', targetname: 'go', target: 'aim', origin: [0, 0, 0] }),
        entity({ classname: 'target_position', targetname: 'aim', origin: [100, 0, 0] }),
      ],
      'go',
    );

    const shot = events.find((e) => e.kind === 'shoot');
    expect(shot).toBeDefined();
    expect(shot!.shooterWeapon).toBe('rocket');
    expect(Array.from(shot!.shootOrigin!)).toEqual([0, 0, 0]);
    expect(shot!.shootDir![0]).toBeCloseTo(1);
    expect(shot!.shootDir![1]).toBeCloseTo(0);
    expect(shot!.shootDir![2]).toBeCloseTo(0);
  });

  it('maps grenade and plasma classnames to their own weapon, base and _targetplayer alike', () => {
    for (const [classname, weapon] of [
      ['shooter_grenade', 'grenade'],
      ['shooter_grenade_targetplayer', 'grenade'],
      ['shooter_plasma', 'plasma'],
      ['shooter_plasma_targetplayer', 'plasma'],
      ['shooter_rocket_targetplayer', 'rocket'],
    ] as const) {
      const events = fire([
        entity({ classname, targetname: 'go', target: 'aim', origin: [0, 0, 0] }),
        entity({ classname: 'target_position', targetname: 'aim', origin: [0, 100, 0] }),
      ], 'go');
      expect(events.find((e) => e.kind === 'shoot')?.shooterWeapon, classname).toBe(weapon);
    }
  });

  it('falls back to the `angles` key when there is no target', () => {
    // AngleVectors(0, 90, 0) points along +Y.
    const events = fire([
      entity({ classname: 'shooter_rocket', targetname: 'go', angles: [0, 90, 0] }),
    ], 'go');
    const shot = events.find((e) => e.kind === 'shoot');
    expect(shot!.shootDir![0]).toBeCloseTo(0);
    expect(shot!.shootDir![1]).toBeCloseTo(1);
  });

  it('TARGETPLAYER aims at the live player instead of the target_position', () => {
    const ps = createPlayerState();
    ps.origin[0] = 0;
    ps.origin[1] = 200;
    ps.origin[2] = 0;

    const events = fire(
      [
        entity({
          classname: 'shooter_rocket_targetplayer',
          targetname: 'go',
          target: 'aim',
          origin: [0, 0, 0],
          spawnflags: 1, // TARGETPLAYER
        }),
        // Deliberately the wrong direction -- TARGETPLAYER must ignore this.
        entity({ classname: 'target_position', targetname: 'aim', origin: [-100, 0, 0] }),
      ],
      'go',
      ps,
    );

    const shot = events.find((e) => e.kind === 'shoot');
    expect(shot!.shootDir![0]).toBeCloseTo(0);
    expect(shot!.shootDir![1]).toBeCloseTo(1);
  });

  it('PREDICT_XY leads the aim point along the player\'s horizontal velocity by `speed` units -- this project\'s own linear-lead interpretation', () => {
    const ps = createPlayerState();
    ps.origin[0] = 0;
    ps.origin[1] = 200;
    ps.velocity[0] = 300; // travelling along +X only

    const events = fire(
      [
        entity({
          classname: 'shooter_rocket_targetplayer',
          targetname: 'go',
          origin: [0, 0, 0],
          spawnflags: 1 | 2, // TARGETPLAYER | PREDICT_XY
          raw: { speed: '50' },
        }),
      ],
      'go',
      ps,
    );

    // Aim point becomes (50, 200, 0) instead of (0, 200, 0) -- pulled toward
    // the direction of travel, so the X component turns positive.
    const shot = events.find((e) => e.kind === 'shoot');
    expect(shot!.shootDir![0]).toBeGreaterThan(0);
  });

  it('a shooter marked notfree never fires -- this project is always "Free for All"', () => {
    const events = fire(
      [
        entity({
          classname: 'shooter_rocket',
          targetname: 'go',
          target: 'aim',
          raw: { notfree: '1' },
        }),
        entity({ classname: 'target_position', targetname: 'aim', origin: [100, 0, 0] }),
      ],
      'go',
    );
    expect(events.find((e) => e.kind === 'shoot')).toBeUndefined();
  });

  it('the random deviation cone still produces a normalized direction', () => {
    const events = fire(
      [
        entity({
          classname: 'shooter_rocket',
          targetname: 'go',
          target: 'aim',
          raw: { random: '30' },
        }),
        entity({ classname: 'target_position', targetname: 'aim', origin: [100, 0, 0] }),
      ],
      'go',
      createPlayerState(),
      () => 0.9, // far from crandom's neutral 0.5 -- deviation should apply
    );
    const shot = events.find((e) => e.kind === 'shoot');
    const dir = shot!.shootDir!;
    expect(vectorLength(dir)).toBeCloseTo(1);
    // With real deviation the shot should no longer point exactly at +X.
    expect(dir[1] === 0 && dir[2] === 0).toBe(false);
  });

  it('reseeds its default rng on target_startTimer, so a ghost replaying the exact same attempt draws the exact same shot regardless of how much unrelated rng history the live Course accumulated first', () => {
    // This is the scenario a ghost actually hits: the live `Course` may have
    // already burned rng draws on earlier practice attempts this session
    // before the one that gets recorded, while `ghostGame`'s `Course` is
    // built fresh and starts at draw #0. Without reseeding on
    // `target_startTimer`, those two histories never realign and a
    // shooter-based route permanently diverges from its ghost the moment
    // it fires. Neither Course here is given an explicit `rng`, so both
    // fall back to the real default -- the exact path `Game`/`main.ts` uses.
    const entities = [
      entity({ classname: 'target_startTimer', targetname: 'go-start' }),
      entity({
        classname: 'shooter_rocket',
        targetname: 'go',
        target: 'aim',
        raw: { random: '30' },
      }),
      entity({ classname: 'target_position', targetname: 'aim', origin: [100, 0, 0] }),
    ];

    const live = new Course({ world: world(), entities });
    // Burn unrelated rng draws before this attempt even starts, simulating
    // earlier practice runs in the same session.
    for (let i = 0; i < 7; i++) {
      live.fireTargetChain('go', 1000, createPlayerState());
    }
    live.fireTargetChain('go-start', 2000, createPlayerState());
    const liveShot = live
      .fireTargetChain('go', 3000, createPlayerState())
      .find((e) => e.kind === 'shoot')!;

    const ghost = new Course({ world: world(), entities });
    ghost.fireTargetChain('go-start', 2000, createPlayerState());
    const ghostShot = ghost
      .fireTargetChain('go', 3000, createPlayerState())
      .find((e) => e.kind === 'shoot')!;

    expect(Array.from(ghostShot.shootDir!)).toEqual(Array.from(liveShot.shootDir!));
  });

  it('spawns a real missile through Game, of the right kind', () => {
    // A real trigger_multiple firing the shooter's targetname, the same
    // world-with-trigger shape target-print.test.ts and movers.test.ts use --
    // `fireTargetChain` alone would not do, since `Game.step()` only ever
    // reads events from its own `course.touch()`, which discards anything
    // `fireTargetChain` produced before Game's tick gets to it.
    const floor = axialBrush([-1024, -1024, -64], [1024, 1024, 0], CONTENTS_SOLID);
    const volume = axialBrush([-64, -64, 0], [64, 64, 128], CONTENTS_TRIGGER);
    const model = brushListModel([floor]);
    model.brushes.push(volume);
    const firstLeafBrush = model.leafbrushes.length;
    const extended = new Int32Array(model.leafbrushes.length + 1);
    extended.set(model.leafbrushes);
    extended[firstLeafBrush] = model.brushes.length - 1;
    model.leafbrushes = extended;
    const leaf: CLeaf = {
      cluster: -1,
      area: -1,
      firstLeafBrush,
      numLeafBrushes: 1,
      firstLeafSurface: 0,
      numLeafSurfaces: 0,
    };
    model.submodels = [
      { mins: [-1024, -1024, -64], maxs: [1024, 1024, 0], leaf: model.leafs[0] },
      { mins: [-64, -64, 0], maxs: [64, 64, 128], leaf },
    ];

    const game = new Game({
      world: model,
      origin: [0, 0, 30],
      entities: [
        entity({ classname: 'trigger_multiple', submodel: 1, target: 'go' }),
        entity({
          classname: 'shooter_rocket',
          targetname: 'go',
          origin: [500, 500, 500],
          target: 'aim',
        }),
        entity({ classname: 'target_position', targetname: 'aim', origin: [600, 500, 500] }),
      ],
    });

    expect(game.missiles).toHaveLength(0);
    game.run(1, {});
    expect(game.missiles.some((m) => m.classname === 'rocket')).toBe(true);
  });
});
