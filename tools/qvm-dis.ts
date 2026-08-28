/**
 * Disassemble a Quake 3 VM image, from a loose .qvm or from inside a .pk3.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Built to read CPMA's shipped bytecode; see .agent/plans/CPMA-REVERSE-ENG.md,
 * including the part about what may be taken out of it.
 *
 *   npm run qvm-dis -- <file.pk3> --list         what VMs an archive holds
 *   npm run qvm-dis -- <file.qvm>                header and function summary
 *   npm run qvm-dis -- <file.qvm> --floats       recovered float constants
 *   npm run qvm-dis -- <file.pk3:vm/cgame.qvm> --fn 4210
 *   npm run qvm-dis -- <file.qvm> --all          every instruction
 */

import { readFileSync } from 'node:fs';
import { openZip, readZipEntry } from '../src/assets/zip.js';
import { loadQvm, looksLikeQvm, type QvmImage } from './qvm/qvm.js';
import {
  findCalls,
  findFunctions,
  formatFunction,
  formatInstruction,
  groupFloats,
  scanFloats,
} from './qvm/disasm.js';

/** How many grouped float values `--floats` prints before truncating. */
const FLOAT_ROWS = 120;
/** How many use sites are listed per float value. */
const SITES_PER_VALUE = 6;

function usage(): never {
  console.error(
    'usage: npm run qvm-dis -- <file.qvm | file.pk3 | file.pk3:entry> [--list] [--floats] [--fn <n>] [--all]',
  );
  process.exit(2);
}

/** Read the bytes to disassemble, transparently reaching inside a .pk3. */
async function readImageBytes(spec: string): Promise<{ name: string; bytes: Uint8Array }> {
  // `archive.pk3:vm/cgame.qvm` selects one entry. A bare Windows drive letter
  // is not a concern here, but a path containing a colon otherwise would be, so
  // only split on a colon that is followed by something ending in .qvm.
  const match = /^(.*\.pk3):(.+\.qvm)$/i.exec(spec);
  const archivePath = match ? match[1] : spec;
  const wanted = match?.[2];

  const file = readFileSync(archivePath);
  if (!archivePath.toLowerCase().endsWith('.pk3') && wanted === undefined) {
    return { name: archivePath, bytes: new Uint8Array(file) };
  }

  const zip = await openZip(new Blob([file]));
  const qvms = [...zip.entries.keys()].filter((n) => n.endsWith('.qvm'));
  const pick = wanted?.toLowerCase() ?? qvms[0];
  if (pick === undefined) {
    throw new Error(`${archivePath} contains no .qvm entries`);
  }
  const entry = zip.entries.get(pick);
  if (entry === undefined) {
    throw new Error(`${archivePath} has no entry ${pick}; it holds ${qvms.join(', ') || 'none'}`);
  }
  return { name: `${archivePath}:${pick}`, bytes: await readZipEntry(zip, entry) };
}

async function listArchive(path: string): Promise<void> {
  const zip = await openZip(new Blob([readFileSync(path)]));
  const names = [...zip.entries.keys()].sort();
  const qvms: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.qvm')) {
      continue;
    }
    // Confirm by magic rather than by extension — a pak can carry anything.
    const bytes = await readZipEntry(zip, zip.entries.get(name)!);
    qvms.push(`  ${name}  ${(bytes.length / 1024).toFixed(1)}KB  ${looksLikeQvm(bytes) ? 'QVM' : 'NOT a QVM'}`);
  }
  console.log(`${path}: ${String(names.length)} entries, ${String(qvms.length)} .qvm`);
  console.log(qvms.join('\n'));
}

function printSummary(name: string, image: QvmImage): void {
  const h = image.header;
  const functions = findFunctions(image);
  const calls = findCalls(image);
  const syscalls = new Set(calls.filter((c) => c.target < 0).map((c) => c.target));

  console.log(`${name}`);
  console.log(`  instructions  ${String(h.instructionCount)}`);
  console.log(`  code          ${String(h.codeLength)} bytes @ ${String(h.codeOffset)}`);
  console.log(`  data          ${String(h.dataLength)} bytes @ ${String(h.dataOffset)}`);
  console.log(`  lit           ${String(h.litLength)} bytes`);
  console.log(`  bss           ${String(h.bssLength)} bytes`);
  console.log(`  functions     ${String(functions.length)}`);
  console.log(`  calls         ${String(calls.length)} (${String(syscalls.size)} distinct syscalls)`);
}

function printFloats(image: QvmImage): void {
  const functions = findFunctions(image);
  const groups = groupFloats(scanFloats(image, functions));
  console.log(`\n${String(groups.length)} distinct plausible float constants (showing ${String(Math.min(FLOAT_ROWS, groups.length))}):`);
  console.log('     value          uses  confirmed  sites (fn@entry:instruction)');
  for (const g of groups.slice(0, FLOAT_ROWS)) {
    const sites = g.sites
      .slice(0, SITES_PER_VALUE)
      .map((s) => `${String(s.fn)}:${String(s.at)}`)
      .join(' ');
    const more = g.sites.length > SITES_PER_VALUE ? ` +${String(g.sites.length - SITES_PER_VALUE)}` : '';
    console.log(
      `  ${String(g.value).padEnd(14)} ${String(g.count).padStart(5)} ${String(g.confirmed).padStart(10)}  ${sites}${more}`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const spec = args.find((a) => !a.startsWith('--'));
  if (spec === undefined) {
    usage();
  }

  if (args.includes('--list')) {
    await listArchive(spec);
    return;
  }

  const { name, bytes } = await readImageBytes(spec);
  const image = loadQvm(bytes);
  printSummary(name, image);

  const fnFlag = args.indexOf('--fn');
  if (fnFlag !== -1) {
    const target = Number(args[fnFlag + 1]);
    const fn = findFunctions(image).find((f) => f.entry === target);
    if (fn === undefined) {
      throw new Error(`no function entry at instruction ${String(target)}`);
    }
    console.log(`\n${formatFunction(image, fn)}`);
    return;
  }

  if (args.includes('--floats')) {
    printFloats(image);
  }

  if (args.includes('--all')) {
    console.log();
    for (const inst of image.instructions) {
      console.log(formatInstruction(inst));
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
