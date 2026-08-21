/**
 * `scripts/<mapname>.cam` — parsing, zone resolution and pose computation.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCameraScript,
  resolveCameraZone,
  computeCameraPose,
  defaultCameraScript,
} from '../../src/game/camera-script.js';
import type { Vec3 } from '../../src/game/camera-script.js';

const EXAMPLE = `
// map default: a plain side view
{
  "mode"     "side"
  "axis"     "90"
  "distance" "520"
  "height"   "110"
  "radius"   "28"
}

// a fixed camera in a lobby room: pinned depth/height, X tracks the player
{
  "mode"       "fixed"
  "bounds_min" "-256 -512 0"
  "bounds_max" "256 512 128"
  "origin"     "0 -400 96"
  "follow"     "x"
  "radius"     "28"
}

// an on-rails pan through a canyon, parameterized by the player's X
{
  "mode"       "rail"
  "bounds_min" "512 -9999 -9999"
  "bounds_max" "2048 9999 9999"
  "axis"       "x"
  "nodes"      "512 -300 80; 1200 -450 140; 2048 -300 60"
  "radius"     "24"
}
`;

describe('parseCameraScript', () => {
  it('parses the default block and every zone, in file order', () => {
    const script = parseCameraScript(EXAMPLE);
    expect(script.defaultBlock).toMatchObject({ mode: 'side', axis: 90, distance: 520, height: 110 });
    expect(script.zones).toHaveLength(2);
    expect(script.zones[0]).toMatchObject({ mode: 'fixed', follow: ['x'] });
    expect(script.zones[1]).toMatchObject({ mode: 'rail', axis: 'x' });
  });

  it('sorts rail nodes by the axis coordinate regardless of authored order', () => {
    const script = parseCameraScript(`
      { "mode" "side" }
      {
        "mode" "rail"
        "bounds_min" "0 0 0"
        "bounds_max" "1 1 1"
        "axis" "x"
        "nodes" "10 0 0; -10 0 0; 0 0 0"
      }
    `);
    const rail = script.zones[0];
    if (rail.mode !== 'rail') {
      throw new Error('expected a rail block');
    }
    expect(rail.nodes.map((n) => n[0])).toEqual([-10, 0, 10]);
  });

  it('rejects a script with no default block', () => {
    expect(() =>
      parseCameraScript(`{ "mode" "fixed" "bounds_min" "0 0 0" "bounds_max" "1 1 1" "origin" "0 0 0" }`),
    ).toThrow(/no default block/);
  });

  it('rejects a script with two default blocks', () => {
    expect(() => parseCameraScript(`{ "mode" "side" } { "mode" "side" "axis" "0" }`)).toThrow(
      /exactly one must/,
    );
  });

  it('rejects fixed without an origin', () => {
    expect(() =>
      parseCameraScript(`{ "mode" "side" } { "mode" "fixed" "bounds_min" "0 0 0" "bounds_max" "1 1 1" }`),
    ).toThrow(/"origin" is required/);
  });

  it('rejects rail without nodes', () => {
    expect(() =>
      parseCameraScript(
        `{ "mode" "side" } { "mode" "rail" "bounds_min" "0 0 0" "bounds_max" "1 1 1" "axis" "x" }`,
      ),
    ).toThrow(/"nodes" is required/);
  });

  it('rejects an unknown mode', () => {
    expect(() => parseCameraScript(`{ "mode" "orbit" }`)).toThrow(/unknown "mode"/);
  });

  it('defaults side axis/distance/height/radius when omitted', () => {
    const script = parseCameraScript(`{ "mode" "side" }`);
    expect(script.defaultBlock).toMatchObject({ axis: 90, distance: 520, height: 110, radius: 28 });
  });

  it('has no lock when the file declares none', () => {
    expect(parseCameraScript(`{ "mode" "side" }`).lock).toBeNull();
    expect(defaultCameraScript().lock).toBeNull();
  });

  it('parses "lock" on the default block', () => {
    const script = parseCameraScript(`{ "mode" "side" "lock" "y 0" }`);
    expect(script.lock).toEqual({ axis: 'y', value: 0 });
  });

  it('parses a non-zero lock value', () => {
    expect(parseCameraScript(`{ "mode" "side" "lock" "y -12.5" }`).lock).toEqual({
      axis: 'y',
      value: -12.5,
    });
  });

  it('rejects "lock" on a zone block', () => {
    expect(() =>
      parseCameraScript(
        `{ "mode" "side" } { "mode" "side" "bounds_min" "0 0 0" "bounds_max" "1 1 1" "lock" "y 0" }`,
      ),
    ).toThrow(/"lock" is only valid on the default block/);
  });

  it('rejects a lock with the wrong number of tokens', () => {
    expect(() => parseCameraScript(`{ "mode" "side" "lock" "y" }`)).toThrow(/must be an axis and a value/);
    expect(() => parseCameraScript(`{ "mode" "side" "lock" "y 0 0" }`)).toThrow(
      /must be an axis and a value/,
    );
  });

  it('rejects a lock with a bad axis letter', () => {
    expect(() => parseCameraScript(`{ "mode" "side" "lock" "w 0" }`)).toThrow(/must be x, y or z/);
  });

  it('rejects a lock with a non-numeric value', () => {
    expect(() => parseCameraScript(`{ "mode" "side" "lock" "y nope" }`)).toThrow(/is not a number/);
  });
});

describe('resolveCameraZone', () => {
  const script = parseCameraScript(EXAMPLE);

  it('falls back to the default block outside every zone', () => {
    expect(resolveCameraZone(script, [-9000, -9000, -9000])).toBe(script.defaultBlock);
  });

  it('picks the zone containing the player', () => {
    expect(resolveCameraZone(script, [0, 0, 64])).toBe(script.zones[0]);
    expect(resolveCameraZone(script, [1000, 0, 0])).toBe(script.zones[1]);
  });

  it('treats bounds as inclusive', () => {
    expect(resolveCameraZone(script, [-256, -512, 0])).toBe(script.zones[0]);
    expect(resolveCameraZone(script, [256, 512, 128])).toBe(script.zones[0]);
  });

  it('resolves overlapping zones by file order, last match winning', () => {
    const overlap = parseCameraScript(`
      { "mode" "side" }
      { "mode" "fixed" "bounds_min" "-100 -100 -100" "bounds_max" "100 100 100" "origin" "0 0 0" }
      { "mode" "rail" "bounds_min" "-10 -10 -10" "bounds_max" "10 10 10" "axis" "x" "nodes" "-10 0 0; 10 0 0" }
    `);
    // Inside both the broad "fixed" zone and the nested "rail" zone -- the
    // one listed later in the file must win, regardless of which is smaller.
    expect(resolveCameraZone(overlap, [0, 0, 0]).mode).toBe('rail');
    // Inside only the broad zone.
    expect(resolveCameraZone(overlap, [50, 50, 50]).mode).toBe('fixed');
  });
});

describe('computeCameraPose', () => {
  it('side: offsets the eye along axis by distance, adds height, looks at the player', () => {
    const script = defaultCameraScript();
    const player: Vec3 = [100, 200, 300];
    const pose = computeCameraPose(script.defaultBlock, player);
    // axis 90 -> looking toward +Y, eye pulled back along -Y.
    expect(pose.eye[0]).toBeCloseTo(100, 5);
    expect(pose.eye[1]).toBeCloseTo(200 - 520, 5);
    expect(pose.eye[2]).toBeCloseTo(300 + 110, 5);
    expect(pose.at).toEqual(player);
  });

  it('fixed: pins every axis not named in follow, reads the rest from the player', () => {
    const script = parseCameraScript(`
      { "mode" "side" }
      { "mode" "fixed" "bounds_min" "-1e9 -1e9 -1e9" "bounds_max" "1e9 1e9 1e9" "origin" "0 -400 96" "follow" "x" }
    `);
    const pose = computeCameraPose(script.zones[0], [777, 55, 55]);
    expect(pose.eye).toEqual([777, -400, 96]);
  });

  it('fixed: does not move at all with an empty follow list', () => {
    const script = parseCameraScript(`
      { "mode" "side" }
      { "mode" "fixed" "bounds_min" "-1e9 -1e9 -1e9" "bounds_max" "1e9 1e9 1e9" "origin" "5 6 7" }
    `);
    expect(computeCameraPose(script.zones[0], [1, 2, 3]).eye).toEqual([5, 6, 7]);
    expect(computeCameraPose(script.zones[0], [-100, -100, -100]).eye).toEqual([5, 6, 7]);
  });

  it('rail: interpolates linearly between the bracketing nodes', () => {
    const script = parseCameraScript(`
      { "mode" "side" }
      {
        "mode" "rail" "bounds_min" "-1e9 -1e9 -1e9" "bounds_max" "1e9 1e9 1e9"
        "axis" "x" "nodes" "0 0 0; 100 0 100"
      }
    `);
    const pose = computeCameraPose(script.zones[0], [25, 0, 0]);
    expect(pose.eye).toEqual([25, 0, 25]);
  });

  it('rail: clamps at both ends instead of extrapolating', () => {
    const script = parseCameraScript(`
      { "mode" "side" }
      {
        "mode" "rail" "bounds_min" "-1e9 -1e9 -1e9" "bounds_max" "1e9 1e9 1e9"
        "axis" "x" "nodes" "0 0 0; 100 0 100"
      }
    `);
    expect(computeCameraPose(script.zones[0], [-500, 0, 0]).eye).toEqual([0, 0, 0]);
    expect(computeCameraPose(script.zones[0], [500, 0, 0]).eye).toEqual([100, 0, 100]);
  });

  it('rail: interpolates across three or more nodes, picking the right segment', () => {
    const script = parseCameraScript(`
      { "mode" "side" }
      {
        "mode" "rail" "bounds_min" "-1e9 -1e9 -1e9" "bounds_max" "1e9 1e9 1e9"
        "axis" "x" "nodes" "0 0 0; 100 0 100; 200 0 0"
      }
    `);
    expect(computeCameraPose(script.zones[0], [150, 0, 0]).eye).toEqual([150, 0, 50]);
  });
});
