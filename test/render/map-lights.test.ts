/**
 * The level's own lamps and torches.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Asserted against the REAL entity lumps rather than synthetic ones, because
 * the whole feature is a claim about what Quake's maps contain — and the
 * counts here are the evidence behind the design decisions in
 * `.agent/plans/MAP-LIGHTS.md`. A synthetic fixture could not have told anyone
 * that `style` is unusable as a flicker signal.
 *
 * Skips when the dev paks are not built; `npm run build-devpak` makes them.
 */

import { existsSync } from 'node:fs';
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { parseEntities } from '../../src/collision/cm-load.js';
import { mergeShaderFiles } from '../../src/assets/shader.js';
import type { Shader } from '../../src/assets/shader.js';
import type { BspFile } from '../../src/collision/bsp.js';
import {
  DEFAULT_LIGHT,
  flameSurfaceCentroids,
  intensityFor,
  parseMapLights,
} from '../../src/render/map-lights.js';

const PAKS: Record<string, string> = {
  q3dm6: 'public/dev-q3dm6.pk3',
  q3dm7: 'public/dev-q3dm7.pk3',
};

async function load(map: string): Promise<{ bsp: BspFile; shaders: Map<string, Shader> }> {
  const path = PAKS[map];
  const fs = new Pk3FileSystem();
  await fs.mount(basename(path), await openAsBlob(path));
  const bytes = (await fs.readFile(`maps/${map}.bsp`))!;
  const bsp = parseBsp(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const texts: string[] = [];
  for (const entry of fs.list({ prefix: 'scripts/' })) {
    if (entry.endsWith('.shader')) {
      const text = await fs.readText(entry);
      if (text) {
        texts.push(text);
      }
    }
  }
  return { bsp, shaders: mergeShaderFiles(texts) };
}

const have = Object.values(PAKS).every((p) => existsSync(p));
const when = have ? describe : describe.skip;

when('parseMapLights', () => {
  it('finds every light entity in q3dm6 and q3dm7', async () => {
    for (const [map, expected] of [
      ['q3dm6', 113],
      ['q3dm7', 301],
    ] as const) {
      const { bsp } = await load(map);
      const lights = parseMapLights(parseEntities(bsp.entities));
      expect(lights, map).toHaveLength(expected);
    }
  });

  it('resolves a light with a `target` into a spotlight aimed at it', async () => {
    const { bsp } = await load('q3dm6');
    const entities = parseEntities(bsp.entities);
    const lights = parseMapLights(entities);

    // A third of them are spotlights, which is what makes shadow-casting wall
    // lamps possible at all -- point lights cannot cast here.
    const spots = lights.filter((l) => l.spot);
    expect(spots).toHaveLength(32);

    for (const spot of spots) {
      const d = spot.spot!.direction;
      // Unit length, so the cone maths downstream is sound.
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 5);
      // A real cone, neither degenerate nor a hemisphere.
      expect(spot.spot!.angle).toBeGreaterThan(0.07);
      expect(spot.spot!.angle).toBeLessThan(Math.PI / 2);
    }
  });

  it('points a spotlight at its target and not away from it', async () => {
    const { bsp } = await load('q3dm6');
    const entities = parseEntities(bsp.entities);
    const lights = parseMapLights(entities);

    // Rebuild the targetname table independently and check one link end to
    // end, rather than trusting the parser's own bookkeeping.
    const byName = new Map<string, number[]>();
    for (const e of entities) {
      if (e['targetname'] && e['origin']) {
        byName.set(e['targetname'].toLowerCase(), e['origin'].split(/\s+/).map(Number));
      }
    }

    let checked = 0;
    for (const e of entities) {
      if (e['classname'] !== 'light' || !e['target'] || !e['origin']) {
        continue;
      }
      const to = byName.get(e['target'].toLowerCase());
      if (!to) {
        continue;
      }
      const from = e['origin'].split(/\s+/).map(Number);
      const light = lights.find(
        (l) => l.origin[0] === from[0] && l.origin[1] === from[1] && l.origin[2] === from[2],
      );
      if (!light?.spot) {
        continue;
      }
      const want = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const len = Math.hypot(want[0], want[1], want[2]);
      // Dot of two unit vectors: 1 means the cone points at the target.
      const dot =
        (light.spot.direction[0] * want[0] +
          light.spot.direction[1] * want[1] +
          light.spot.direction[2] * want[2]) /
        len;
      expect(dot).toBeCloseTo(1, 4);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('classifies torches from flame surfaces, and agrees with the colours', async () => {
    const { bsp, shaders } = await load('q3dm7');
    const flames = flameSurfaceCentroids(bsp, shaders);
    expect(flames.length).toBeGreaterThan(0);

    const lights = parseMapLights(parseEntities(bsp.entities), flames);
    const torches = lights.filter((l) => l.torch);

    /*
     * TWO INDEPENDENT METHODS AGREEING is the whole reason this heuristic is
     * defensible. The classification uses geometry -- a light within 96 units
     * of an animated emissive surface. The cross-check uses the mappers'
     * `_color`, which for q3dm7's torches is the classic warm
     * `1.0 0.5 0.25`. Neither knows about the other, and both say eight.
     */
    expect(torches).toHaveLength(8);

    const warm = lights.filter(
      (l) => l.color[0] > 0.9 && l.color[1] > 0.3 && l.color[1] < 0.7 && l.color[2] < 0.4,
    );
    expect(warm).toHaveLength(8);
  });

  it('finds no torches in a map with no open flames', async () => {
    // q3dm6 has lamps but no fires, and the honest answer for it is zero
    // rather than a heuristic reaching for something.
    const { bsp, shaders } = await load('q3dm6');
    const lights = parseMapLights(
      parseEntities(bsp.entities),
      flameSurfaceCentroids(bsp, shaders),
    );
    expect(lights.filter((l) => l.torch)).toHaveLength(0);
  });

  it('defaults a light with no `light` key to 300', () => {
    const [light] = parseMapLights([{ classname: 'light', origin: '0 0 0' }]);
    expect(light.intensity).toBe(DEFAULT_LIGHT);
  });

  it('scales intensity with the square of the reach', () => {
    // The mapping `scene-lights.ts` uses, and for the same reason: three's
    // punctual lights are physical, so brightness is `intensity / d²` and a
    // plausible-looking small number is invisible at Quake's scale.
    const light = parseMapLights([
      { classname: 'light', origin: '0 0 0', light: '100', radius: '200' },
    ])[0];
    expect(light.reach).toBe(200);
    expect(intensityFor(light, 1)).toBe((200 * 200) / 4);
    expect(intensityFor(light, 0.5)).toBe(((200 * 200) / 4) * 0.5);
  });
});
