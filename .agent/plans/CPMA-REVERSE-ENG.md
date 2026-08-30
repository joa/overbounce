# Reverse-engineering CPMA's physics from its shipped VM

Status: **done.** The bytecode was read on 2026-08-30 and every question below
is answered. The findings, each with the address it came from, are in
[`.agent/docs/cpma-constants.md`](../docs/cpma-constants.md) — read that, not
this, for what CPMA actually does. This file is kept for the method and for the
scope line, which still binds anyone who re-opens the file.

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

1. **Get the package.** `cdn.playmorepromote.com` is still denied — see
   "The download" below — so the pak was placed by hand. Manifest entry
   `cpma-1.53` remains the reproducible path once the host is allowed.
2. **Find the VM.** CPMA's `.pk3`s carry `vm/cgame.qvm` and `vm/qagame.qvm`.
   Pmove is `bg_` code, compiled into *both*; cgame's copy is the client-side
   prediction and is the one that decides what a player feels.
3. **Load and disassemble.** `tools/qvm/` — built, tested, described below.
4. **Scan for float constants.** `--floats` reinterprets every `OP_CONST`
   operand as float32 and filters to plausible magnitudes.
   **This step's premise was half wrong, and that is the single most useful
   thing this plan learned.** id's own tunables are file-scope `float`s, so a
   function does not contain 6.0 — it contains the *address* `pm_friction`
   lives at, and `--floats` cannot see it. CPMA's own CPM tunables are worse
   again: they live in a runtime settings table, so even the data segment does
   not hold them where pmove reads. `--globals`, `--data` and `--xref` were
   added for this, and they are what actually found the numbers.
5. **Locate pmove.** Segment on `OP_ENTER`, then identify functions by their
   constant signature rather than by name (QVMs ship stripped). `PM_Accelerate`,
   `PM_AirMove` and `PM_Friction` are individually recognisable: VQ3's own
   values (`pm_accelerate` 10, `pm_airaccelerate` 1, `pm_friction` 6,
   `pm_stopspeed` 100, `pm_duckScale` 0.25) are a fingerprint, and the CPM
   values sit in the same functions.
6. **Answer the specific questions**, in priority order. All four are
   answered, with addresses, in `.agent/docs/cpma-constants.md`:
   - `AIR_STOP_ACCELERATE` — 2.5 or 2.0? **2.5.**
   - `AIR_CONTROL` 150, `STRAFE_ACCELERATE` 70, `WISH_SPEED` 30 — **all three
     confirmed**, though 150 is a per-mode setting rather than a constant.
   - `pmCpmJump`: the ramp-jump threshold and the double-jump window, both
     currently Warsow-derived. **Both were wrong**, in mechanism and not only
     in value.
   - Whether CPMA's `PM_Accelerate` keeps id's `#if 1` q2-style branch.
     **It does.**
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
P=refs/cpma/cpma_z-cpma-1.53.pk3
npm run qvm-dis -- "$P" --list                # what VMs a pak holds
npm run qvm-dis -- "$P:vm/cgame.qvm"          # header and function summary
npm run qvm-dis -- "$P:vm/cgame.qvm" --floats # OP_CONST as float32
npm run qvm-dis -- "$P:vm/cgame.qvm" --fn 128586
```

Reading the bytecode turned up a fifth and sixth thing the tool needed, because
CPMA's tunables are not immediates: `--globals <fn>` lists the data addresses a
function loads from, `--data <lo> <hi>` dumps those addresses, `--xref <addr>`
says which functions read one, and `--strings <regex>` scans the data segment.
Those four are what make an address cited in the findings doc re-checkable.

`test/tools/qvm.test.ts` assembles a QVM in memory and asserts the loader
round-trips it, so the decoder is proven without the CPMA file present. That is
the same reasoning as the collision suite's synthetic BSP writer — and it has
the same blind spot, so it is validation of the decoder, not of on-disk layout.
The first real `.qvm` is the thing that settles layout.

## The download

Still denied, re-checked 2026-08-30: `npm run download-assets` reports
`cpma-1.53 ... skip  fetch failed (optional)` while every `refs/` set in the
same run fetches fine. The gateway's wording has not changed either:

```
CONNECT cdn.playmorepromote.com:443 -> 403
request blocked: no rule or allowlist entry allows host "cdn.playmorepromote.com"
```

That is a *missing* allow, not an explicit deny, and it survived one round of
"the domain has been allowlisted" (retried 2026-08-28, fresh container,
unchanged). Whoever edits the policy should confirm the entry covers
`cdn.playmorepromote.com` specifically — an entry for the apex domain alone may
not match the CDN subdomain, which is the host the manifest fetches. A mirror
on another host is deliberately *not* used: routing around an egress denial is
exactly what the proxy documentation says not to do.

**The file analysed on 2026-08-30 was placed by hand**, at
`refs/cpma/cpma_z-cpma-1.53.pk3`. That path is not arbitrary — it is exactly
what the manifest's extract rule produces (`*.pk3` flattened into `refs/cpma`,
so `cpma/z-cpma-1.53.pk3` becomes `cpma_z-cpma-1.53.pk3`), so the working tree
matches what a clean `npm run download-assets` would build the day the host is
allowed. Keep it that way; a hand-placed file under a hand-chosen name is the
thing that makes a finding un-re-checkable.

## Outcome

Read in one session once the pak was present. `.agent/docs/cpma-constants.md`
has the findings; `src/physics/cpm.ts`, `src/physics/pmove.ts` and
`test/physics/cpm-cpma.test.ts` carry them into the code, each citing the doc.

Four things were wrong before this and are right now: air control runs *before*
`PM_Accelerate` rather than after, CPM's ramp jump does not clip against the
ground plane, CPM's double jump is a 400 ms timer and a flat +105 rather than
"add whenever moving up", and CPM accelerates on the ground at 15 rather than
10. `AIR_STOP_ACCELERATE` 2.5 was right, and is now evidence rather than
judgement.

Two things came out of it that are recorded but not built. CPM has a complete
alternative water tunable set (swim/wade/friction/accel), left alone because one
of the four is only reached through a wading branch id does not have, and doing
three of four would match neither original. And every CPM ghost and personal
best predating this work was recorded under physics that no longer exists —
ghosts still load, but they diverge. Both are written up in the findings doc;
neither is a physics decision.

The claim in CLAUDE.md does **not** move. CPM mode is "community-documented,
with its constants read from CPMA 1.53's shipped bytecode" — never "verified
1:1". Reading a stripped binary is not reading a source, and the one thing this
work cannot tell you is what CPMA's authors *meant*.
