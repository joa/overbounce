/**
 * `npm run demo-info -- <file.dm_68>` -- what a demo says about itself.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The headless check on `src/demo/`. No browser, no renderer, no map needed:
 * a decode regression shows up here in a second, and this is what to run
 * first when a demo will not play.
 *
 * `--entities` adds a per-eType histogram of the last snapshot, which is the
 * fastest way to tell "the netfield tables are right" from "they are one line
 * out": a demo decoded with a shifted table still parses, still produces
 * snapshots, and fills them with entities of impossible types at impossible
 * coordinates.
 *
 * `--scan` widens that to EVERY snapshot, which answers a different question:
 * not "is the decode sane" but "what is in this recording at all". A solo
 * DeFRaG run can hold no second player and no mover for its whole length, so
 * anything built to draw those cannot be verified against it -- and since
 * `test/demo/demo-writer.ts` builds its fixtures from the same tables
 * `src/demo/` decodes with, a green `npm run test:demo` would not notice
 * either. Run this BEFORE building anything that renders a demo's entities,
 * so what can and cannot be claimed is known in advance.
 */

import { readFileSync } from 'node:fs';
import { parseDm68 } from '../src/demo/dm68.js';
import { CS } from '../src/demo/dm68.js';
import { demoMeta } from '../src/demo/meta.js';
import { EntityType } from '../src/demo/state.js';

const ET_NAMES: Record<number, string> = {
  [EntityType.GENERAL]: 'general',
  [EntityType.PLAYER]: 'player',
  [EntityType.ITEM]: 'item',
  [EntityType.MISSILE]: 'missile',
  [EntityType.MOVER]: 'mover',
  [EntityType.BEAM]: 'beam',
  [EntityType.PORTAL]: 'portal',
  [EntityType.SPEAKER]: 'speaker',
  [EntityType.PUSH_TRIGGER]: 'push_trigger',
  [EntityType.TELEPORT_TRIGGER]: 'teleport_trigger',
  [EntityType.INVISIBLE]: 'invisible',
  [EntityType.GRAPPLE]: 'grapple',
  [EntityType.TEAM]: 'team',
};

function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const wantEntities = args.includes('--entities');
  const wantScan = args.includes('--scan');
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error('usage: npm run demo-info -- <file.dm_68> [--entities] [--scan]');
    process.exit(1);
    return;
  }

  const bytes = new Uint8Array(readFileSync(path));
  const started = performance.now();
  const demo = parseDm68(bytes);
  const took = performance.now() - started;
  const meta = demoMeta(demo, path);

  console.log(`file        ${path}`);
  console.log(`decoded in  ${took.toFixed(1)}ms  (${(bytes.length / 1024).toFixed(0)}KB)`);
  console.log(`protocol    ${demo.protocol}`);
  console.log(`map         ${meta.map || '(none)'}`);
  console.log(`duration    ${formatTime(meta.durationMs)}  (${meta.snapshotCount} snapshots, ${meta.snapshotIntervalMs}ms apart = ${meta.serverFps}Hz)`);
  console.log(`physics     ${meta.physics}`);
  console.log(`player      ${meta.playerName || '(unnamed)'}  [${meta.playerModel || 'no model'}]  clientNum ${demo.clientNum}`);
  if (meta.hostname) {
    console.log(`server      ${meta.hostname}`);
  }
  if (meta.filenameTimeMs !== null) {
    console.log(
      `filename    claims ${formatTime(meta.filenameTimeMs)} ${meta.filenamePhysics ?? ''} -- a claim by whoever named the file, not the duration`,
    );
  }
  console.log(`commands    ${demo.commands.length} server commands`);
  console.log(
    `decode      ${demo.complete ? 'complete' : `STOPPED EARLY after ${demo.messagesRead} messages: ${demo.stoppedBecause}`}`,
  );

  const first = demo.snapshots[0];
  const last = demo.snapshots[demo.snapshots.length - 1];
  if (first && last) {
    const a = first.ps.origin;
    const b = last.ps.origin;
    console.log(
      `pov origin  ${a.map((n) => n.toFixed(1)).join(' ')}  ->  ${b.map((n) => n.toFixed(1)).join(' ')}`,
    );
    console.log(`serverTime  ${first.serverTime} -> ${last.serverTime}`);
  }

  if (wantEntities && last) {
    const counts = new Map<number, number>();
    for (const ent of last.entities) {
      counts.set(ent.eType, (counts.get(ent.eType) ?? 0) + 1);
    }
    console.log(`\nlast snapshot: ${last.entities.length} entities`);
    for (const [eType, count] of [...counts].sort((x, y) => y[1] - x[1])) {
      const name =
        eType >= EntityType.EVENTS ? `event ${eType - EntityType.EVENTS}` : (ET_NAMES[eType] ?? `?${eType}`);
      console.log(`  ${String(count).padStart(4)}  ${name}`);
    }
  }

  if (wantScan) {
    /*
     * Every snapshot, counting each type two ways, because neither number
     * alone is the answer to "how many rockets".
     *
     * DISTINCT ENTITY NUMBERS is not it: the server recycles them. In the
     * `coldrun` demo six numbers carry fourteen explosions -- entity 148 is
     * two different rockets -- which is the exact bug `EVENT_VALID_MSEC`
     * exists to catch in `demo-clip.ts`, so a tool built to find that trap
     * must not print a number that hides it.
     *
     * APPEARANCES is not it either: it counts however many frames each one
     * was in flight for.
     *
     * So RUNS is the third number -- a maximal span of snapshots holding that
     * number, split wherever it is absent for longer than `EVENT_VALID_MSEC`,
     * the same line `CG_ResetEntity` draws.
     *
     * It is a LOWER BOUND, not the answer either, and the gap is worth
     * knowing: `coldrun` scans as 6 numbers and 12 runs while its event walk
     * fires 14 explosions. Both are right. A number reused inside the window
     * is one run, and the two events on it are still distinct because
     * `EV_EVENT_BITS` toggles between them -- which is the OTHER half of the
     * dedup, and the half a presence scan cannot see at all. Read runs as
     * "at least this many separate objects"; read the es.event counts below
     * for how many things happened.
     *
     * Events are counted separately and by number, because `eType >=
     * ET_EVENTS` is not an entity type at all: it is a freestanding event
     * whose number is `eType - ET_EVENTS`, and what is worth knowing is
     * which events a recording actually contains.
     */
    /** `cg_ents.c`'s own staleness window -- see `demo-clip.ts`. */
    const EVENT_VALID_MSEC = 300;
    const seen = new Map<number, Set<number>>();
    /** Per eType: how many separate runs, and when each number was last seen. */
    const runs = new Map<number, number>();
    const lastSeen = new Map<number, number>();
    const events = new Map<number, number>();
    const entityEvents = new Map<number, number>();
    for (const snap of demo.snapshots) {
      for (const ent of snap.entities) {
        if (ent.eType >= EntityType.EVENTS) {
          const ev = ent.eType - EntityType.EVENTS;
          events.set(ev, (events.get(ev) ?? 0) + 1);
          continue;
        }
        let set = seen.get(ent.eType);
        if (!set) {
          set = new Set<number>();
          seen.set(ent.eType, set);
        }
        set.add(ent.number);
        // A number absent for longer than the window is a DIFFERENT object
        // when it comes back, exactly as playback treats it.
        const previous = lastSeen.get(ent.number);
        if (previous === undefined || snap.serverTime - previous > EVENT_VALID_MSEC) {
          runs.set(ent.eType, (runs.get(ent.eType) ?? 0) + 1);
        }
        lastSeen.set(ent.number, snap.serverTime);
        // An ordinary entity can also carry an event in `es.event`, which is
        // how a rocket says it exploded. Those are the ones a renderer has
        // to notice, and they are invisible in an eType histogram.
        if (ent.event !== 0) {
          const ev = ent.event & 0xff;
          entityEvents.set(ev, (entityEvents.get(ev) ?? 0) + 1);
        }
      }
    }
    console.log(`
whole demo: ${demo.snapshots.length} snapshots scanned`);
    for (const [eType, set] of [...seen].sort((x, y) => y[1].size - x[1].size)) {
      const runCount = runs.get(eType) ?? set.size;
      const recycled = runCount > set.size ? `, ${runCount} runs -- NUMBERS RECYCLED` : '';
      console.log(
        `  ${String(set.size).padStart(4)}  ${ET_NAMES[eType] ?? `?${eType}`} (distinct entity numbers${recycled})`,
      );
    }
    console.log(`  ${String(events.size).padStart(4)}  distinct freestanding event types`);
    for (const [ev, count] of [...events].sort((x, y) => y[1] - x[1])) {
      console.log(`        event ${ev}: ${count} appearances`);
    }
    console.log(`  ${String(entityEvents.size).padStart(4)}  distinct es.event values on ordinary entities`);
    for (const [ev, count] of [...entityEvents].sort((x, y) => y[1] - x[1])) {
      console.log(`        es.event ${ev}: ${count} appearances`);
    }
  }

  const items = demo.configStrings[CS.ITEMS];
  if (items) {
    console.log(`\nCS_ITEMS    ${items.length} slots`);
  }
}

main();
