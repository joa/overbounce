/**
 * `.arena` and `.defi` parsing.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The fixtures are verbatim from the community templates at
 * https://ws.q3df.org/editing/files/template.arena and .../template.defi --
 * including their own worked examples with commented-out sample blocks, since
 * a hand-written fixture would not catch a parser tripping on a `//`-commented
 * line that itself contains a quoted pair, which the real templates do.
 */

import { describe, it, expect } from 'vitest';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import {
  loadCourseMetadata,
  parseArenaFile,
  parseDefiFile,
} from '../../src/assets/course-info.js';

const TEMPLATE_ARENA = `// example arena file for mapfilename.bsp
// store the mapfilename.arena in the scripts folder
//
// possible type settings for baseq3 maps:
// ffa = free for all (deathmatch),
// tourney = tournament,
// team = team deathmatch,
// ctf = capture the flag
{
map "mapfilename"
longname "map title"
author "nickname"
type "ffa tourney team ctf"
}


// another example with bots, frag limit and time limit
// don't forget to add the mapfilename.aas file to your pk3 for bot support
//
// {
// map "mapfilename"
// longname "full map name"
// author "playername"
// type "ffa"
// bots "slash hunter"
// fraglimit "20"
// timelimit "10"
// }`;

const TEMPLATE_DEFI = `// Defrag map definition file template

// Defrag uses its own equivalent of the .arena files, whose extension is .defi.
// Those files feed the proper information to the maps menu about each map.
// .defi files go into the \\scripts directory.

// Save as "[bsp file name(no extension)].defi" in the scripts folder
// All answers are to be enclosed in inverted commas ""
// Options are listed in between square brackets [] and seperated by slashes /
// Notes on options are in round brackets ()
// Remove unused options, notes and brackets when saving

// Marks the start of the defi file (don't delete this bracket!)
{

// What is the bsp file name?
map        "de4th_run1"

// What is the full name or description of the map?
longname    "Death Run 1"

// What type of map is it?
style        "run"

// Is the map for cpm physics?
cpm        "0"

// Is the map for vq3 physics?
vq3        "1"

// Who made the map?
author    "dr.death"

// Marks the end of the defi file (don't delete this bracket!)
}`;

describe('.arena', () => {
  it('reads the template verbatim, ignoring the commented-out second example', () => {
    const info = parseArenaFile(TEMPLATE_ARENA);
    expect(info).toEqual({
      map: 'mapfilename',
      longname: 'map title',
      author: 'nickname',
      type: 'ffa tourney team ctf',
    });
  });

  it('says nothing about physics -- that is .defi-only', () => {
    // ArenaInfo has no physics field at all; loadCourseMetadata is what
    // proves an .arena-only map falls back to `physics: null`.
    expect(parseArenaFile(TEMPLATE_ARENA)).not.toHaveProperty('physics');
  });

  it('returns null without a map key', () => {
    expect(parseArenaFile('{ longname "no map key" }')).toBeNull();
  });

  it('picks the matching block from a multi-block file instead of merging or taking the last', () => {
    // An aggregate scripts/arenas.txt-style file, or a hand-edited file with
    // a leftover second block -- either way, whichever block parses LAST
    // must not silently win over the one the caller actually asked for.
    const twoMaps = '{ map "a" longname "A" } { map "b" longname "B" }';
    expect(parseArenaFile(twoMaps, 'a')).toEqual({
      map: 'a', longname: 'A', author: null, type: null,
    });
    expect(parseArenaFile(twoMaps, 'b')).toEqual({
      map: 'b', longname: 'B', author: null, type: null,
    });
  });

  it('falls back to the first block when no map name is given, or none matches', () => {
    const twoMaps = '{ map "a" longname "A" } { map "b" longname "B" }';
    expect(parseArenaFile(twoMaps)?.map).toBe('a');
    expect(parseArenaFile(twoMaps, 'c')?.map).toBe('a');
  });
});

describe('.defi', () => {
  it('reads a filled-in template, including the physics flags .arena cannot express', () => {
    const info = parseDefiFile(TEMPLATE_DEFI);
    expect(info).toEqual({
      map: 'de4th_run1',
      longname: 'Death Run 1',
      author: 'dr.death',
      style: 'run',
      physics: 'vq3',
    });
  });

  it('reports "both" when a map is built for both physics modes', () => {
    const info = parseDefiFile('{ map "x" cpm "1" vq3 "1" }');
    expect(info?.physics).toBe('both');
  });

  it('reports null physics when neither flag is set, rather than guessing', () => {
    const info = parseDefiFile('{ map "x" cpm "0" vq3 "0" }');
    expect(info?.physics).toBeNull();
  });

  it('is not confused by the blank template\'s own bracketed placeholder text', () => {
    // The un-filled-in template ships literal "[0(no)/1(yes)]" as the cpm/vq3
    // values -- neither "1" nor "yes" nor "true", so this must NOT read as
    // cpm-and-vq3-both-true just because both fields are non-empty strings.
    const blank = `{
map        "[bsp file name(no extension)]"
longname    "[long description(can have spaces)]"
style        "[training/run/accuracy/level]"
cpm        "[0(no)/1(yes)]"
vq3        "[0(no)/1(yes)]"
author    "[your name/your nick]"
}`;
    const info = parseDefiFile(blank);
    expect(info?.physics).toBeNull();
  });
});

/** Build a minimal, uncompressed (stored) ZIP containing the given files. */
function buildStoredZip(files: Record<string, string>): Blob {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralStart = offset;
  const centralBytes = centrals.reduce((n, c) => n + c.length, 0);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralBytes, true);
  ev.setUint32(16, centralStart, true);

  return new Blob([...locals, ...centrals, eocd] as BlobPart[]);
}

describe('loadCourseMetadata', () => {
  it('prefers .defi over .arena when a map has both', async () => {
    const fs = new Pk3FileSystem();
    await fs.mount(
      'de4th_run1.pk3',
      buildStoredZip({
        'scripts/de4th_run1.defi': TEMPLATE_DEFI,
        'scripts/de4th_run1.arena': TEMPLATE_ARENA.replace('mapfilename', 'de4th_run1'),
      }),
    );
    const meta = await loadCourseMetadata(fs, 'de4th_run1');
    expect(meta.physics).toBe('vq3');
    expect(meta.longname).toBe('Death Run 1');
  });

  it('falls back to .arena for longname/author when there is no .defi', async () => {
    const fs = new Pk3FileSystem();
    await fs.mount(
      'q3dm6.pk3',
      buildStoredZip({ 'scripts/q3dm6.arena': TEMPLATE_ARENA.replace('mapfilename', 'q3dm6') }),
    );
    const meta = await loadCourseMetadata(fs, 'q3dm6');
    expect(meta.longname).toBe('map title');
    // .arena cannot express physics -- an ordinary deathmatch map stays
    // undeclared rather than being guessed at.
    expect(meta.physics).toBeNull();
  });

  it('returns all-null for a map with neither file, rather than throwing', async () => {
    const fs = new Pk3FileSystem();
    await fs.mount('plain.pk3', buildStoredZip({ 'maps/plain.bsp': 'not a real bsp' }));
    const meta = await loadCourseMetadata(fs, 'plain');
    expect(meta).toEqual({ longname: null, author: null, physics: null, style: null });
  });
});
