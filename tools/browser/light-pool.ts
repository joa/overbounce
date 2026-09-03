/**
 * What the light pools actually hold, in a running game.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run light-pool -- --map q3dm6 --at 192,-888,200
 *   npm run light-pool -- --map q3ctf2 --params "maplights=1&maplightspots=4"
 *
 * "The light parameter does nothing" is a question about a pool slot, and a
 * screenshot cannot answer it: an unassigned slot and a slot holding a light
 * that is merely dim look identical. This prints the slot table --
 * `scene-lights.ts`'s dlights and `map-lights.ts`'s points and spots -- with
 * each slot's intensity, cast flag and position, after the loop has run.
 *
 * Reading these in a DevTools/extension-driven tab does NOT work: the render
 * loop stops running there -- `renderer.info.render.frameCalls` sits still --
 * so every slot stays at its constructed default and the whole feature looks
 * broken. (Throttled `requestAnimationFrame` in an unfocused tab is the
 * likely cause; it was not measured.) That false positive is the reason this
 * is a puppeteer script.
 */

import { grabPointerLock, withPage } from './session.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = arg('port', '5180');
const map = arg('map', 'q3dm6');

let url = arg('url');
if (!url) {
  const p = new URLSearchParams({
    devpak: arg('devpak', `dev-${map}.pk3`),
    map,
    player: arg('player', 'doom'),
  });
  const at = arg('at');
  if (at) {
    p.set('at', at);
  }
  for (const [k, v] of new URLSearchParams(arg('params'))) {
    p.set(k, v);
  }
  url = `http://localhost:${port}/?${p.toString()}`;
}

console.log(`url  ${url}`);

interface Slot {
  name: string;
  type: string;
  intensity: number;
  castShadow: boolean;
  distance: number;
  position: string;
  angle: number | null;
  autoUpdate: boolean | null;
}

const { slots, declared, origin, missiles } = await withPage(
  url,
  async ({ page, console: lines }) => {
    // Pointer lock, or the loop freezes the visual clock and every pooled
    // light stays where it was constructed -- see the header.
    await grabPointerLock(page);
    await new Promise((r) => setTimeout(r, Number(arg('settle', '2500'))));

    /*
     * `--fire <ms>` -- read the pool with a rocket actually in the air.
     *
     * A dynamic light does not exist unless something is in flight, so every
     * `dlight` slot reads as parked otherwise and the question "is the rocket
     * light casting?" cannot be asked at all.
     */
    const fire = arg('fire');
    if (fire) {
      /*
       * HELD, not clicked. `page.click` presses and releases in the same
       * instant, and `input.attack` is sampled once per frame from the button
       * state -- so a click can land entirely between two samples and fire
       * nothing. That produced a genuinely confusing hour: the gauntlet-less
       * muzzle flash still appeared (it is stamped from a different path) so
       * it LOOKED like a shot had been fired, while `game.missiles` stayed
       * empty and the rocket light was reported as broken.
       */
      await page.mouse.down();
      setTimeout(() => void page.mouse.up().catch(() => {}), 150);
      /*
       * Poll while it flies, rather than sleeping and looking once.
       *
       * A rocket crosses a room in a few hundred milliseconds and the read
       * below is a single instant, so a snapshot that lands after the impact
       * shows an empty pool and an empty missile list -- which reads as "the
       * rocket light does not exist" when it in fact existed for 300ms. This
       * records the peak so the two can be told apart.
       */
      const until = Date.now() + Number(fire);
      let peak = 0;
      while (Date.now() < until) {
        peak = Math.max(
          peak,
          await page.evaluate(() => {
            const ob = (window as unknown as { overbounce?: Record<string, unknown> })
              .overbounce;
            const game = ob?.['game'] as
              | { missiles?: { length: number }; weapon?: number; ps?: { ammo?: number[] } }
              | undefined;
            const w = game?.weapon ?? -1;
            (window as unknown as { __probe?: unknown }).__probe = {
              weapon: w,
              ammo: game?.ps?.ammo ? Array.from(game.ps.ammo) : null,
              missiles: game?.missiles?.length ?? 0,
            };
            return game?.missiles?.length ?? 0;
          }),
        );
      }
      const probe = await page.evaluate(
        () => (window as unknown as { __probe?: unknown }).__probe,
      );
      console.log(`peak missiles in flight while firing: ${peak}`);
      console.log(`weapon/ammo probe: ${JSON.stringify(probe)}`);
    }

    const result = await page.evaluate(() => {
      const ob = (window as unknown as { overbounce?: Record<string, unknown> }).overbounce;
      const renderer = ob?.['renderer'] as { scene?: unknown } | undefined;
      const scene = renderer?.scene as
        | { traverse(fn: (o: Record<string, unknown>) => void): void }
        | undefined;
      const out: Slot[] = [];
      scene?.traverse((o) => {
        if (!o['isLight'] || !/overbounce\./.test(String(o['name'] ?? ''))) {
          return;
        }
        const pos = o['position'] as { x: number; y: number; z: number };
        const sh = o['shadow'] as { autoUpdate?: boolean } | undefined;
        out.push({
          name: String(o['name']).replace('overbounce.', ''),
          type: String(o['type']),
          intensity: Number(o['intensity']),
          castShadow: Boolean(o['castShadow']),
          autoUpdate: sh ? sh.autoUpdate !== false : null,
          distance: Number(o['distance'] ?? 0),
          position: [pos.x, pos.y, pos.z].map((n) => Math.round(n)).join(','),
          angle: typeof o['angle'] === 'number' ? o['angle'] : null,
        });
      });
      const game = ob?.['game'] as {
        ps?: { origin?: ArrayLike<number> };
        missiles?: readonly { classname?: string; currentOrigin?: ArrayLike<number> }[];
      } | undefined;
      const o = game?.ps?.origin;
      return {
        slots: out,
        origin: o ? [o[0], o[1], o[2]].map((n) => Math.round(n)).join(',') : '?',
        // What is actually in flight, which is what decides whether a dlight
        // slot has anything to hold. Without it "the rocket is not casting"
        // and "there is no rocket" look identical in the slot table.
        missiles: (game?.missiles ?? []).map((m) => {
          const p = m.currentOrigin;
          return `${m.classname ?? '?'}@${
            p ? [p[0], p[1], p[2]].map((n) => Math.round(n)).join(',') : '?'
          }`;
        }),
      };
    });

    return {
      ...result,
      declared: lines.filter((l) => l.includes('map lights:')),
    };
  },
  { headful: process.argv.includes('--headful') },
);

for (const line of declared) {
  console.log(line.replace(/^\[log\] /, ''));
}
console.log(`player at ${origin}`);
console.log(`in flight: ${missiles.length ? missiles.join('  ') : 'nothing'}`);
for (const s of slots) {
  const angle = s.angle === null ? '' : `  cone ${((s.angle * 180) / Math.PI).toFixed(0)}deg`;
  const live = s.castShadow ? (s.autoUpdate ? 'CASTS' : 'cast/idle') : '';
  console.log(
    `${s.name.padEnd(22)} ${s.type.padEnd(16)} intensity ${s.intensity.toFixed(0).padStart(7)}` +
      `  ${live.padEnd(9)}  reach ${String(Math.round(s.distance)).padStart(5)}` +
      `  at ${s.position}${angle}`,
  );
}
