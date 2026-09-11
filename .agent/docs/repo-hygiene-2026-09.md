# Two findings from a hygiene pass, 2026-09-11

Both are measurements rather than opinions, and both are the kind of thing
that looks fine on the machine it was found on.

## 1. Two bundled maps cannot be obtained from a clean clone

`public/maps/hntourney1.bsp` and `public/maps/feliz-a1.bsp` have **no entry
in `tools/assets.manifest.json`**, and `*.bsp` is gitignored, so they exist
only on the machine that first put them there.

They are not incidental. They are read by:

- `test/game/course.test.ts:460-461`
- `test/render/bsp-render.test.ts:65`
- `test/render/winding.test.ts:27`
- `src/course-world.ts`'s `BUNDLED_MAPS` -- shipped code, not just tests

`mega_rl` sits beside them in the same directory and the same test lists and
HAS a complete manifest entry, with an `extract` step into `public/maps/`.
These two have nothing.

CLAUDE.md is explicit that "a working tree that cannot be recreated from a
clean clone plus that one command is a bug". The failure mode is the quiet
kind: on a clean clone three suites `skipIf` themselves and two `BUNDLED_MAPS`
entries fail to load, on a machine where the gate is green.

**Not fixed deliberately.** Nothing in `.agent/`, `docs/` or the manifest
records where either map came from, and the file timestamps (2009 and 2010)
say they are third-party community maps. Guessing a URL into the repository's
authoritative manifest is worse than a documented gap -- the manifest is the
thing that is supposed to be trustworthy. The fix is two entries mirroring
`mega_rl`'s shape; only whoever downloaded them knows the source.

`.agent/plans/INITIALIZE.md` cites overbounce-spot statistics measured on both
maps, so the numbers in that document are currently unreproducible too.

## 2. `noUncheckedIndexedAccess` would cost 3575 errors, and would not have
   caught the bug it looks like it would

Measured, not estimated. Turning the flag on in `tsconfig.json`:

| | errors |
| --- | --- |
| total | **3575** |
| `src/collision` | 677 |
| `src/render` | 682 |
| `src/game` | 372 |
| `src/physics` | 95 |
| `src/math` | 73 |

Worst single files: `cm-patch.ts` 247, `trace.ts` 154, `bsp-mesh.ts` 120,
`demo/state.ts` 120.

**The narrow-tsconfig mitigation does not work, and that was tested rather
than assumed.** Type-checking the single entry point
`src/ui/playback-chrome.ts` with the flag on still produces **1091 errors, of
which only 13 are in `src/ui`** -- 977 are in collision/game/physics/math.
`tsc` checks the whole transitive import graph, so there is no way to opt the
new code in without opting in the ported C.

**And it would not have caught trap 18.** That bug was `frames[i]` where `i`
came from a clock that goes negative on a backward scrub. The flag surfaces it
only at the price of `!` assertions on every `velocity[2]`-style read in
`src/physics/`, which is against the prime directive of keeping id's
structure. What actually pins it is the clamp plus
`test/render/explosion-scrub.test.ts`, which asserts the PROPERTY
(`material.map` is always a Texture) rather than the index. Generalising that
test to the other clock-indexed pools is the cheaper defence and it already
works.

**Recommendation: no.** Recorded so the next person to have this idea can read
the numbers instead of re-measuring them.

## Smaller things, checked and found clean

Every npm script resolves to a file that exists; every declared dependency is
used; the asset manifest is 57 of 60 sha-pinned (the three nulls are `manual`
entries not on disk); `npm run golden` writes no snapshots; no `any`, no
import-boundary violations, no stray `console.log`.

`tools/diag/`'s 29 scripts have no npm entries **by design** -- they are
one-offs run as `tsx tools/diag/x.ts`. Not rot.

The three `FIXME`s under `src/` are id's own comments, ported on purpose, as is
`PERSISTANT_POWERUP`'s spelling (`bg_misc.c:755`). A dead-export scan flagged
476 of 1278 symbols; almost all are type exports used by inference, ported
q_math/bg_public surface kept by the prime directive, or id names exported for
visibility. Exactly one -- `zeroDir` in `src/physics/cpm.ts` -- is genuinely
unreferenced with no comment explaining it.
