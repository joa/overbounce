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
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error('usage: npm run demo-info -- <file.dm_68> [--entities]');
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

  const items = demo.configStrings[CS.ITEMS];
  if (items) {
    console.log(`\nCS_ITEMS    ${items.length} slots`);
  }
}

main();
