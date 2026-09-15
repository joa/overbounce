/**
 * Regenerate `scripts/<course>.shader` from OpenArena's own shader scripts.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run download-assets       # oa-pak0.pk3 is where the scripts live
 *   npm run extract-oa-shaders
 *
 * A mounted pak's shader scripts apply to every course by NAME, so a course
 * that needs three OpenArena shader definitions ships exactly those three,
 * with every stage image bundled, instead of the whole `oalite.shader` and
 * `liquid_lavas.shader` (hundreds of definitions whose images this project
 * does not carry, attached to any other map that shares a texture name).
 *
 * Each block is copied verbatim -- the file is GPLv2 OpenArena text, see
 * NOTICE -- by matching the `textures/...` header line and brace-counting to
 * the end of its definition. Edit `COURSES` to change what a course needs; do
 * not hand-edit the outputs.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { openAsBlob } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pk3FileSystem } from '../src/assets/pk3.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OA_PAK = 'assets/pk3/oa-pak0.pk3';

interface ShaderPick {
  /** OpenArena script inside oa-pak0.pk3. */
  script: string;
  /** Shader definitions the course references from it. */
  names: readonly string[];
}

interface CourseShaders {
  /** The generated file, in this repository's scripts/ directory. */
  out: string;
  /** What the file is, for its header: one sentence per line. */
  why: readonly string[];
  blocks: readonly ShaderPick[];
}

/** Per course: which OpenArena definitions its compiled BSP references. */
const COURSES: readonly CourseShaders[] = [
  {
    out: 'scripts/ob_crypt.shader',
    why: [
      'The three OpenArena shader definitions maps/ob_crypt.bsp references that are',
      'not plain images, copied verbatim (GPLv2, OpenArena -- see NOTICE) out of',
      "oa-pak0.pk3's scripts/oalite.shader and scripts/liquid_lavas.shader.",
    ],
    blocks: [
      {
        script: 'scripts/oalite.shader',
        names: ['textures/gothic_light/ironcrosslt2_5000', 'textures/gothic_light/pentagram_light1_3k'],
      },
      { script: 'scripts/liquid_lavas.shader', names: ['textures/liquids/lavahell_simple'] },
    ],
  },
  {
    out: 'scripts/ob_yard.shader',
    why: [
      'The two OpenArena shader definitions maps/ob_yard.bsp references that are',
      'not plain images -- the pulsing jump pad and the blue running lights --',
      "copied verbatim (GPLv2, OpenArena -- see NOTICE) out of oa-pak0.pk3's",
      'scripts/oasfx.shader and scripts/oalite.shader. The sky (skies2/nebula3)',
      'comes from oasky.shader, which the pak carries whole.',
    ],
    blocks: [
      { script: 'scripts/oasfx.shader', names: ['textures/sfx/diamond2cjumppad'] },
      { script: 'scripts/oalite.shader', names: ['textures/base_light/proto_lightblue'] },
    ],
  },
  {
    out: 'scripts/ob_grounds.shader',
    why: [
      'The OpenArena shader definitions maps/ob_grounds.bsp references that are',
      'not plain images -- the pale grey mist of the fog garden, the gothic wall lamps and',
      "the torch flames -- copied verbatim (GPLv2, OpenArena -- see NOTICE) out of",
      "oa-pak0.pk3's scripts/oa_fogs.shader, scripts/oalite.shader and",
      'scripts/oasfx.shader. The sky (skies/moonsky) comes from',
      'oasky.shader, which the pak carries whole.',
    ],
    blocks: [
      { script: 'scripts/oa_fogs.shader', names: ['textures/sfx/xnotsodensegreyfog'] },
      { script: 'scripts/oalite.shader', names: ['textures/gothic_light/gothic_light3_2K'] },
      { script: 'scripts/oasfx.shader', names: ['textures/sfx/flame1side'] },
    ],
  },
  {
    out: 'scripts/ob_strafes.shader',
    why: [
      'The OpenArena shader definitions maps/ob_strafes.bsp references that are',
      'not plain images -- the iron-cross and pentagram lamps and the torch flames --',
      "copied verbatim (GPLv2, OpenArena -- see NOTICE) out of oa-pak0.pk3's",
      'scripts/oalite.shader and scripts/oasfx.shader. The sky (skies/nitesky)',
      'comes from oasky.shader, which the pak carries whole.',
    ],
    blocks: [
      { script: 'scripts/oalite.shader', names: ['textures/gothic_light/ironcrosslt2_5000', 'textures/gothic_light/pentagram_light1_3k'] },
      { script: 'scripts/oasfx.shader', names: ['textures/sfx/flame1side'] },
    ],
  },
  {
    out: 'scripts/ob_circuit.shader',
    why: [
      'The OpenArena shader definitions maps/ob_circuit.bsp references that are',
      'not plain images -- the scrolling blue and red light trims that colour-code',
      'the high and low lanes, the blue tiny light and the amber panel of the mid',
      "lane -- copied verbatim (GPLv2, OpenArena -- see NOTICE) out of oa-pak0.pk3's",
      'scripts/evil8.shader and scripts/cosmoflash.shader. The sky',
      '(skies/earthsky01) comes from oasky.shader, which the pak carries whole.',
    ],
    blocks: [
      {
        script: 'scripts/evil8.shader',
        names: ['textures/evil8_trim/e8trimlight2_blue', 'textures/evil8_trim/e8trimlight2_red', 'textures/evil8_lights/e8tinylightblue'],
      },
      { script: 'scripts/cosmoflash.shader', names: ['textures/cosmo_light/lightyel02_12k'] },
    ],
  },
];

function header(course: CourseShaders): string {
  const lines = [
    `// ${course.out}`,
    '//',
    ...course.why.map((l) => `// ${l}`),
    '//',
    "// Copied rather than bundling those files whole because every mounted pak's",
    '// shader scripts apply to every course by NAME: shipping all of oalite.shader',
    '// would attach ~200 shader definitions, most with images this pak does not',
    '// carry, to any other map that happens to use the same texture names. A few',
    '// definitions with every stage image bundled is the whole footprint.',
    '//',
    '// GENERATED by tools/extract-oa-shaders.ts (`npm run extract-oa-shaders`).',
    '// Do not hand-edit; change COURSES there and rerun.',
    '',
    '',
  ];
  return lines.join('\n');
}

/** The definition starting at the line that is exactly `name`, through its closing brace. */
function extractBlock(text: string, name: string, script: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === name);
  if (start < 0) {
    throw new Error(`${name} is not defined in ${script}`);
  }
  const out: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    if (opened && depth === 0) {
      return out.join('\n');
    }
  }
  throw new Error(`${name} in ${script} never closes`);
}

async function main(): Promise<void> {
  const oaPak = new Pk3FileSystem();
  await oaPak.mount('oa-pak0.pk3', await openAsBlob(join(root, OA_PAK)));

  for (const course of COURSES) {
    const blocks: string[] = [];
    for (const { script, names } of course.blocks) {
      const bytes = await oaPak.readFile(script);
      if (!bytes) {
        throw new Error(`${script} is not in ${OA_PAK}`);
      }
      const text = new TextDecoder().decode(bytes);
      for (const name of names) {
        blocks.push(extractBlock(text, name, script));
      }
    }

    const output = header(course) + blocks.join('\n\n') + '\n';
    const target = join(root, course.out);
    let previous = '';
    try {
      previous = readFileSync(target, 'utf8');
    } catch {
      // first run
    }
    writeFileSync(target, output);
    console.log(`${course.out}: ${blocks.length} definitions${previous === output ? ' (unchanged)' : ''}`);
  }
}

await main();
