# `SnapVector` is two different functions

Found 2026-09-09 while porting the shotgun (`.agent/plans/SHOTGUN.md`), by
the reviewer rather than by the test suite -- a test comparing the port to
itself would never have noticed.

## The two

| name | where | what it does |
|---|---|---|
| `SnapVector(v)` | `game/q_shared.h:646`, a **macro** | `v[i] = (int)(v[i])` -- a C cast, **truncates toward zero** |
| `trap_SnapVector(v)` | engine syscall, declared `game/bg_pmove.c:1834` | x87 `fistp`, **rounds to nearest** (ties to even) -- the mode `test/physics/snapvector.test.ts` pins from the 125fps jump-height evidence |

They share a name and disagree on every fractional input. `100.7` is `100`
under the macro and `101` under the trap; `-100.7` is `-100` and `-101`.

## Who calls which

The game module (`g_*.c`, `bg_*.c`) can only see the macro, except for the
one place `bg_pmove.c` deliberately reaches into the engine:

- **`trap_SnapVector`**: exactly one call site in the game module,
  `PmoveSingle`'s velocity snap (`bg_pmove.c:2015`). This is the one
  `src/physics/pmove.ts`'s `snapVector` implements, correctly, as
  round-to-nearest.
- **The macro**: everything else. `CalcMuzzlePoint` (`g_weapon.c`), the
  shotgun's `origin2` (`g_weapon.c:359`), missile `trDelta` snaps
  (`g_missile.c:547-704`), `SnapVector( origin )` in `G_ExplodeMissile`
  (`g_missile.c:71`), `Use_Shooter`'s aim (`g_misc.c:356, 449`), and the
  entity-state snaps in `bg_misc.c`.

## Where the port stands

- `src/game/shotgun.ts` truncates `origin2` (`snapVectorInt`). Correct.
- **`calcMuzzlePoint` in `src/game/weapons.ts` calls the rounding
  `snapVector` from `pmove.ts`.** The C is the macro, so every muzzle point
  -- every rocket's, grenade's and plasma bolt's birth point, and the origin
  the three hitscan guns trace from -- can sit one unit from where Quake puts
  it whenever `origin + viewheight + 14 * forward` has a fractional part of
  0.5 or more. That is a pre-existing fidelity bug, NOT fixed with the
  shotgun: correcting it moves rocket-jump geometry by up to a unit and will
  shift golden values in `test/game/`, which under CLAUDE.md's rule needs the
  new output proven first (it is: the C is a cast) and then a deliberate
  golden update, as its own commit. Left for the owner to schedule.
- **`src/game/missiles.ts` has the same substitution twice**: the
  `trDelta` snap in `spawn` (`missiles.ts:127`, C: `g_missile.c:547-670`)
  and the detonation origin in the explode path (`missiles.ts:213`, C:
  `g_missile.c:71`). Both call the rounding `snapVector`; both are the
  macro in C. A rocket's velocity is `900 * forward` snapped, so any
  component with a fractional part of 0.5 or more is one unit off -- which
  is one unit per second, and over a rocket jump's flight not visible,
  but it is not Quake's number. Same standing as `calcMuzzlePoint`: a
  deliberate fix, with its own golden update, not a drive-by.

## The lesson

A function name that matches id's is not evidence it is the same function.
The pmove port's `snapVector` is named for the C it implements
(`trap_SnapVector`, via `PmoveSingle`), and the game-module macro of the same
name is a different operation. Grep the header before reusing the helper.
