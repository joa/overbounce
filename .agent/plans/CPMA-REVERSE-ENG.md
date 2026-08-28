# Reverse-engineering CPMA's physics from its shipped VM

Status: **toolchain built, analysis blocked on the download.**

## Why

`src/physics/cpm.ts` is the one file in `physics/` without a fidelity guarantee.
Everything else is a port of readable GPL C; CPM mode is assembled from
Warsow/qfusion's `gs_pmove.cpp` plus community prose, and its header says so at
length. That leaves real numbers in doubt — most visibly `AIR_STOP_ACCELERATE`,
which we ship at 2.5 (community-documented CPM) while Warsow's equivalent is
2.0, reconciled by judgement rather than by evidence.

CPMA ships its game code as Quake 3 VM bytecode. That bytecode is a *published
artifact of the behaviour we are trying to match*, and unlike x86 it is a
documented stack machine whose interpreter is GPL and sitting in `refs/`. So the
constants are recoverable.

## Scope, and the line we do not cross

CPMA is proprietary. Overbounce is GPLv2. Those two facts together decide what
may come out of this work:

- **In scope: facts.** Constant values, comparison thresholds, the order of
  operations where it is observable, which branch a flag selects. Numbers are
  not copyrightable, and most of the ones we care about are already
  community-published — this exercise confirms them rather than discovering
  them.
- **Out of scope: expression.** No decompiled function bodies, no transcribed
  control flow, no generated C or TypeScript pasted from a decompiler, into the
  tree or into a doc. If a finding cannot be written as "constant X is N" or
  "the branch tests `velocity[2] < N`", it does not get written down here.
- **The binary is never committed.** It lands in `refs/cpma/`, which is
  gitignored for exactly the reason `refs/` already is: upstream's to
  distribute, not ours.
- **This does not upgrade the fidelity claim.** Even a perfect reading of the
  bytecode is a reading of an unpublished implementation. CLAUDE.md's rule
  stands: VQ3 carries the 1:1 guarantee, CPM does not. What changes is that the
  numbers stop being guesses — which is worth doing on its own.

## Method

1. **Get the package.** `cdn.playmorepromote.com` is denied by this session's
   egress policy (403 at CONNECT). Manifest entry `cpma-1.53` is written and
   ready; it fetches once the host is allowed. See "Blocked" below.
2. **Find the VM.** CPMA's `.pk3`s carry `vm/cgame.qvm` and `vm/qagame.qvm`.
   Pmove is `bg_` code, compiled into *both*; cgame's copy is the client-side
   prediction and is the one that decides what a player feels.
3. **Load and disassemble.** `tools/qvm/` — built, tested, described below.
4. **Scan for float constants.** The pmove tunables reach the bytecode as
   `OP_CONST` immediates. Reinterpreting every `OP_CONST` operand as float32 and
   filtering to plausible magnitudes turns up the candidate set directly;
   `--floats` does this.
5. **Locate pmove.** Segment on `OP_ENTER`, then identify functions by their
   constant signature rather than by name (QVMs ship stripped). `PM_Accelerate`,
   `PM_AirMove` and `PM_Friction` are individually recognisable: VQ3's own
   values (`pm_accelerate` 10, `pm_airaccelerate` 1, `pm_friction` 6,
   `pm_stopspeed` 100, `pm_duckScale` 0.25) are a fingerprint, and the CPM
   values sit in the same functions.
6. **Answer the specific questions**, in priority order:
   - `AIR_STOP_ACCELERATE` — 2.5 or 2.0?
   - `AIR_CONTROL` 150, `STRAFE_ACCELERATE` 70, `WISH_SPEED` 30 — confirm.
   - `pmCpmJump`: the ramp-jump velocity threshold and the double-jump window,
     both currently Warsow-derived.
   - Whether CPMA's `PM_Accelerate` keeps id's `#if 1` q2-style branch (it must,
     for strafe jumping to work, but confirm rather than assume).
7. **Write findings to `.agent/docs/cpma-constants.md`**, each with the address
   it was read from so a later session can re-check it.
8. **Turn each confirmed number into a golden test** in `test/physics/`, and
   rewrite `cpm.ts`'s header to cite the reading instead of hedging.

## Toolchain (done)

`tools/qvm/` — a QVM loader and disassembler written from the GPL engine
sources, which `npm run download-assets -- --refs` now fetches:

| file | from |
| --- | --- |
| `opcodes.ts` | `vm_local.h` (`opcode_t`), `vm_interpreted.c` (operand widths, semantics) |
| `qvm.ts` | `qfiles.h` (`vmHeader_t`, `VM_MAGIC`), `vm.c` (`VM_Restart` load path) |
| `disasm.ts` | function segmentation, float scan, cross-references |

Run it:

```bash
npm run qvm-dis -- refs/cpma/vm/cgame.qvm            # full disassembly
npm run qvm-dis -- refs/cpma/z-cpma-1.53.pk3 --list  # what VMs a pak holds
npm run qvm-dis -- <file> --floats                   # OP_CONST as float32
npm run qvm-dis -- <file> --fn 0x1a4c                # one function
```

`test/tools/qvm.test.ts` assembles a QVM in memory and asserts the loader
round-trips it, so the decoder is proven without the CPMA file present. That is
the same reasoning as the collision suite's synthetic BSP writer — and it has
the same blind spot, so it is validation of the decoder, not of on-disk layout.
The first real `.qvm` is the thing that settles layout.

## Blocked

The download is denied by organization egress policy, on all three hostnames:

```
CONNECT cdn.playmorepromote.com:443 -> 403
```

General egress is fine (`raw.githubusercontent.com` serves `refs/`), so this is
a policy decision about that domain, not a broken proxy. The remedy is to allow
`playmorepromote.com` in the environment's network policy; a mirror on another
host is deliberately *not* used, because routing around an egress denial is
exactly what the proxy documentation says not to do.

Once allowed:

```bash
npm run download-assets            # fetches cpma-1.53 into refs/cpma/
npm run qvm-dis -- refs/cpma/vm/cgame.qvm --floats
```
