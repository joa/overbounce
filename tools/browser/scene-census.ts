/**
 * What is in the scene graph, and what it costs to walk it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run census                       # q3dm6
 *   npm run census -- --map q3dm7
 *   npm run census -- --json out.json    # for an A/B diff
 *
 * Needs a dev server on `--port` (5180 by default): `npx vite --port 5180`.
 *
 * Built for phase 2A of `.agent/plans/PERFORMANCE.md`. A trace of real play put
 * three.js at 53% of busy CPU, and the matrix family — `updateMatrixWorld`,
 * `compose`, `multiplyMatrices`, `updateMatrix` — at about 10% of it. Reading
 * the installed `three.core.js` says exactly where that goes:
 *
 *     updateMatrixWorld( force ) {
 *       if ( this.matrixAutoUpdate ) this.updateMatrix();   // compose(), and
 *                                                           // sets the dirty flag
 *       if ( this.matrixWorldNeedsUpdate || force ) {
 *         ...matrixWorld.multiplyMatrices( parent.matrixWorld, this.matrix );
 *         this.matrixWorldNeedsUpdate = false;
 *         force = true;                                     // ...for the whole subtree
 *       }
 *       for ( const child of this.children ) child.updateMatrixWorld( force );
 *     }
 *
 * So an object with `matrixAutoUpdate` on pays `compose` + `multiplyMatrices`
 * every frame whether or not it moved, AND forces every descendant to recompute
 * with it. Turning it off skips both. The recursive walk itself always runs, so
 * object COUNT still costs — but only the loop, not the arithmetic.
 *
 * This tool answers the two questions that follow: how many objects are there,
 * and how many of them actually move. It also reports `renderer.info`, which is
 * the invariant for the change — anything that alters draw calls or triangle
 * count has altered what is drawn, and phase 2A must not.
 *
 * `--frames` samples the graph twice, a second apart, and reports which objects
 * changed their local matrix in between. That is the evidence for the
 * static/dynamic split, rather than reading the code and hoping: an object whose
 * matrix is identical across a second of play is a candidate, and one that
 * changed is emphatically not.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { withPage } from './session.js';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = arg('port', '5180');
const map = arg('map', 'q3dm6');
const jsonOut = arg('json');
const compareWith = arg('compare');
const settleMs = Number(arg('settle', '3000'));
/**
 * How many times to sample the graph, and how far apart.
 *
 * Four samples over three seconds, not two over one. The first attempt used a
 * single 1.2s gap and misclassified slow movers as static -- an item's bob has
 * a period of seconds, so two samples can land at the same phase. Running the
 * gate against the SAME build twice then reported items as having "drifted",
 * which is a gate that fails on identical input and therefore proves nothing.
 */
const samples = Number(arg('samples', '4'));
const gapMs = Number(arg('gap', '1000'));

const url =
  arg('url') ||
  `http://localhost:${port}/?${new URLSearchParams({
    devpak: arg('devpak', `dev-${map}.pk3`),
    map,
    player: arg('player', 'doom'),
  }).toString()}`;

/**
 * Walk the scene and describe every node.
 *
 * Injected as source, not a function: `tsx` compiles this file with esbuild's
 * `keepNames`, which rewrites a named inner function into a call to esbuild's
 * `__name` helper — and that helper does not exist in the page. See
 * `profile.ts` for the same note.
 */
const CENSUS_SOURCE = `
  (function () {
    var r = window.overbounce && window.overbounce.renderer;
    if (!r) return { error: 'no window.overbounce.renderer' };

    var nodes = [];
    var walk = function (o, depth, path, index) {
      // The sibling index is part of the key. Without it, hundreds of unnamed
      // meshes share a path, the two samples cannot be matched up, and the
      // moved-count is nonsense.
      var name = (o.name || o.type) + '#' + index;
      var here = path ? path + '/' + name : name;
      nodes.push({
        path: here,
        type: o.type,
        depth: depth,
        visible: o.visible,
        matrixAutoUpdate: o.matrixAutoUpdate,
        matrixWorldAutoUpdate: o.matrixWorldAutoUpdate,
        children: o.children.length,
        // The LOCAL matrix decides "did this object move" -- a world matrix
        // changes when a PARENT moves, which would report every child of the
        // world group as dynamic.
        matrix: o.matrix.elements.join(','),
        // The WORLD matrix is the gate. Two builds whose every matrixWorld
        // agrees put every object in the same place, which is a far more
        // precise claim than a screenshot can make and does not have to fight
        // the fps readout, the shader clock or the light flicker to make it.
        world: o.matrixWorld.elements.join(','),
      });
      for (var i = 0; i < o.children.length; i++) walk(o.children[i], depth + 1, here, i);
    };
    walk(r.scene, 0, '', 0);

    var info = r.renderer.info;
    return {
      nodes: nodes,
      render: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        drawCalls: info.render.drawCalls,
      },
    };
  })()
`;

interface Node {
  path: string;
  type: string;
  depth: number;
  visible: boolean;
  matrixAutoUpdate: boolean;
  matrixWorldAutoUpdate: boolean;
  children: number;
  matrix: string;
  world: string;
}

interface Census {
  nodes?: Node[];
  render?: Record<string, number>;
  error?: string;
}

/**
 * A grouping key: the parent path plus the child's TYPE, with sibling indices
 * stripped. Hundreds of world surfaces collapse to one line; a mover group and
 * a player model stay apart.
 */
function bucket(path: string): string {
  const parts = path.split('/').map((p) => p.replace(/#\d+$/, ''));
  if (parts.length <= 1) {
    return parts.join('/');
  }
  return `${parts.slice(0, -1).join('/')}/${parts[parts.length - 1]}`;
}

async function main(): Promise<void> {
  const shots = await withPage(url, async ({ page }) => {
    await new Promise((r) => setTimeout(r, settleMs));
    const out: Census[] = [];
    for (let i = 0; i < samples; i++) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, gapMs));
      }
      out.push((await page.evaluate(CENSUS_SOURCE)) as Census);
    }
    return out;
  });

  const first = shots[0];
  if (first.error || !first.nodes) {
    console.error(first.error ?? 'no nodes');
    process.exit(1);
  }

  const nodes = first.nodes;

  // Moved if the LOCAL matrix differs in ANY later sample, not just the last.
  const moved = new Set<string>();
  for (const shot of shots.slice(1)) {
    const later = new Map((shot.nodes ?? []).map((n) => [n.path, n.matrix]));
    for (const n of nodes) {
      const m = later.get(n.path);
      if (m !== undefined && m !== n.matrix) {
        moved.add(n.path);
      }
    }
  }

  /*
   * An object is only comparable across runs if neither IT nor any ANCESTOR
   * moved. A static child of a moving parent has a constant local matrix and a
   * world matrix that legitimately varies -- the player model's meshes hang off
   * a tag-driven group whose matrix `applyTag` rewrites every frame, and
   * comparing their world matrices across two runs of the SAME build duly
   * reported ten "drifted" objects. Ancestry is a path prefix, so this is a
   * prefix test.
   */
  const dynamic = new Set<string>();
  for (const n of nodes) {
    let at = '';
    for (const part of n.path.split('/')) {
      at = at ? `${at}/${part}` : part;
      if (moved.has(at)) {
        dynamic.add(n.path);
        break;
      }
    }
  }

  const auto = nodes.filter((n) => n.matrixAutoUpdate);
  console.log(`\n${map}: ${nodes.length} objects in the scene graph`);
  console.log(`  matrixAutoUpdate on   ${auto.length}`);
  console.log(
    `  moved over ${((samples - 1) * gapMs / 1000).toFixed(1)}s      ${moved.size}`,
  );
  console.log(
    `  => paying compose + multiplyMatrices every frame for nothing: ` +
      `${auto.filter((n) => !moved.has(n.path)).length}`,
  );
  console.log(
    `\nrenderer.info  calls ${first.render?.calls ?? '?'}  ` +
      `triangles ${first.render?.triangles ?? '?'}`,
  );

  // Group, so a world mesh of hundreds of surfaces reads as one line.
  const groups = new Map<string, { total: number; auto: number; moved: number }>();
  for (const n of nodes) {
    const key = bucket(n.path);
    const g = groups.get(key) ?? { total: 0, auto: 0, moved: 0 };
    g.total++;
    if (n.matrixAutoUpdate) g.auto++;
    if (moved.has(n.path)) g.moved++;
    groups.set(key, g);
  }

  console.log('\nby subtree (total / autoUpdate / moved):');
  for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 30)) {
    const flag = g.auto > 0 && g.moved === 0 ? '   <- static, still recomputed' : '';
    console.log(
      `  ${String(g.total).padStart(6)} / ${String(g.auto).padStart(6)} / ${String(g.moved).padStart(5)}  ${k}${flag}`,
    );
  }

  /*
   * The A/B gate for phase 2A.
   *
   * `--json before.json` on one build, then `--compare before.json` on the
   * other. Two builds that agree here put every object in the same place — a
   * far more precise claim than a screenshot can make, and one that does not
   * have to fight the fps readout, the shader clock or the light flicker.
   *
   * THREE assertions, and the shape of them was determined by running the gate
   * against the SAME build twice before trusting it. That run came back
   * "SCENE CHANGED", every difference under the animated player model, because
   * a walk cycle is at a different point in two captures a few seconds apart.
   * A gate that fails on an identical build proves nothing, so:
   *
   *  1. **Static objects must land in the same world matrix.** "Static" is not
   *     asserted, it is measured: an object whose LOCAL matrix was unchanged
   *     across the two in-run samples. Those are exactly the objects this phase
   *     touches, and they are the ones with no legitimate reason to move.
   *  2. **The set of moving objects must be the same.** This is the assertion
   *     that catches the failure mode which matters most. Turning off
   *     `matrixAutoUpdate` on something that DOES move freezes it silently —
   *     no test goes red, no console error, the object simply renders at a
   *     stale position forever. Such an object drops out of the moved set, and
   *     that is what this notices.
   *  3. **Triangle count must match**, because a change that altered what is
   *     drawn rather than how its transform was computed would show there and
   *     nowhere in the matrices.
   *
   * `render.calls` is NOT compared: it is a running counter whose value depends
   * on how many frames elapsed before the sample, and it drifts across runs of
   * one build (1848 / 1944 / 2016 were three readings of the same code).
   */
  if (compareWith) {
    const before = JSON.parse(readFileSync(compareWith, 'utf8')) as {
      render?: Record<string, number>;
      nodes?: Node[];
      moved?: string[];
    };
    const beforeMoved = new Set(before.moved ?? []);
    const beforeDynamic = (path: string): boolean => {
      let at = '';
      for (const part of path.split('/')) {
        at = at ? `${at}/${part}` : part;
        if (beforeMoved.has(at)) {
          return true;
        }
      }
      return false;
    };
    const wasStatic = new Map(
      (before.nodes ?? []).filter((n) => !beforeDynamic(n.path)).map((n) => [n.path, n.world]),
    );
    const drifted = nodes.filter(
      (n) => !dynamic.has(n.path) && wasStatic.has(n.path) && wasStatic.get(n.path) !== n.world,
    );
    const froze = [...beforeMoved].filter((p) => !moved.has(p));
    const thawed = [...moved].filter((p) => !(before.moved ?? []).includes(p));
    const missing = nodes.filter((n) => !(before.nodes ?? []).some((b) => b.path === n.path));
    const gone = (before.nodes ?? []).filter((b) => !nodes.some((n) => n.path === b.path));

    console.log(`\ncompared against ${compareWith}`);
    console.log(`  objects              ${before.nodes?.length ?? 0} -> ${nodes.length}`);
    console.log(`  new / removed        ${missing.length} / ${gone.length}`);
    console.log(
      `  comparable (no moving ancestor) ${nodes.length - dynamic.size} of ${nodes.length}`,
    );
    console.log(`  static, now elsewhere ${drifted.length}`);
    console.log(`  moved before, now frozen ${froze.length}`);
    console.log(`  static before, now moving ${thawed.length}`);
    console.log(
      `  triangles            ${before.render?.triangles ?? '?'} -> ${first.render?.triangles ?? '?'}`,
    );
    for (const n of drifted.slice(0, 10)) {
      console.log(`    drifted: ${n.path}`);
    }
    for (const p of froze.slice(0, 10)) {
      console.log(`    FROZEN:  ${p}`);
    }
    for (const p of thawed.slice(0, 10)) {
      console.log(`    thawed:  ${p}`);
    }

    /*
     * `thawed` is REPORTED but does not fail the gate. An object becoming
     * dynamic is not a failure mode of turning `matrixAutoUpdate` off, and
     * whether a marginal mover is caught depends on where the sampling window
     * happened to land. `froze` is the one that matters and it does fail.
     */
    const clean =
      drifted.length === 0 &&
      froze.length === 0 &&
      missing.length === 0 &&
      gone.length === 0 &&
      before.render?.triangles === first.render?.triangles;
    console.log(clean ? '\n  IDENTICAL scene' : '\n  SCENE CHANGED');
    if (!clean) {
      process.exitCode = 1;
    }
  }

  if (jsonOut) {
    writeFileSync(
      jsonOut,
      `${JSON.stringify({ render: first.render, nodes, moved: [...moved] }, null, 2)}\n`,
    );
    console.log(`\nwrote ${jsonOut}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
