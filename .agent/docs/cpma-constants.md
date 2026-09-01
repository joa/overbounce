# CPMA 1.53's physics constants, read from its shipped VM bytecode

Read 2026-08-30 from `refs/cpma/cpma_z-cpma-1.53.pk3`, entries `vm/cgame.qvm`
and `vm/qagame.qvm`, with `npm run qvm-dis`. Read
`.agent/plans/CPMA-REVERSE-ENG.md` first — in particular the scope line. What
follows is values, thresholds and branch conditions, each with the address it
was read from. Nothing here is transcribed code, and nothing here upgrades the
fidelity claim: **VQ3 mode carries the 1:1 guarantee because id's C is
readable; CPM mode does not, and still does not.** What changed is that CPM's
numbers are now readings rather than guesses.

Both VMs carry the same `bg_` code, so every pmove finding below was confirmed
in each independently. Where they agree the reading is solid; they never
disagreed.

## Re-checking a finding

Every address below is re-readable. Functions are named by the instruction
index of their `OP_ENTER`, which is what `--fn` takes; data addresses are VM
data-segment offsets, which is what `--data` and `--xref` take.

```bash
P=refs/cpma/cpma_z-cpma-1.53.pk3
npm run qvm-dis -- "$P:vm/cgame.qvm" --data 0x12848 0x12854   # the CPM block
npm run qvm-dis -- "$P:vm/cgame.qvm" --xref 0x12850           # who reads 2.5
npm run qvm-dis -- "$P:vm/cgame.qvm" --globals 128586         # PM_AirMove
npm run qvm-dis -- "$P:vm/qagame.qvm" --strings "^phys"
```

Function identities were established by constant signature, never by name —
QVMs ship stripped. Each is justified where it is first used below.

## The answers the plan asked for

| question | answer | read from |
| --- | --- | --- |
| `AIR_STOP_ACCELERATE` 2.5 or 2.0? | **2.5** | cgame data `0x12850`, qagame data `0x2288` |
| `STRAFE_ACCELERATE` 70? | **70** | cgame `0x1284c`, qagame `0x2284` |
| `WISH_SPEED` 30? | **30** | cgame `0x12848`, qagame `0x2280` |
| `AIR_CONTROL` 150? | **150**, but as a per-mode *setting*, not a compiled constant | qagame fn 29480 @30280 |
| CPM ramp jump | jump **adds** to `velocity[2]` when it is already positive, instead of replacing it | cgame fn 127526 @127650–127685 |
| CPM double jump | **+105** within a **400 ms** window | cgame fn 127526 @127710, @127737 |
| id's `#if 1` q2-style `PM_Accelerate`? | **yes**, unchanged | cgame fn 126744 |
| rocket speed in CPM? | **1000** (VQ3 900) | NOT read from the bytecode — see below |

## The rocket speed, and how far the bytecode got

`src/game/missiles.ts` fires a 1000ups rocket in CPM against id's 900 in VQ3.
That number is **community-documented and owner-confirmed, not verified here**,
and the attempt to verify it is written down so nobody repeats it expecting a
different answer.

What the reading did establish, on 2026-09-01:

- **`qagame.qvm` contains no compiled 900 rocket speed at all.** The only two
  `900f` sites in the whole VM are a `GEF` comparison (fn 73880 @74278, @74508,
  @74696) and an `x * 4000 + 900` expression (fn 86144 @86488). Neither is a
  projectile speed. So CPMA did move projectile speed out of the code, which is
  consistent with it being a per-mode setting rather than a constant.
- **The settings installer is fn 29480** — the same function this file already
  cites for `AIR_CONTROL` — and it fills **four records of 636 bytes**, indexed
  0–3 in sequence (`LOCAL 24` takes 0, 1, 2, 3 at @29482, @30068, @30513,
  @31059).
- One field of that record, base `1091568`+8, takes **1500 / 500 / ? / 1000**
  across indices 0–3 (@29897, @30350, @31504). `AIR_CONTROL`'s 150 sits inside
  index 1's block, so index 1 is CPM.

Which is where it stops being fact. If that field were rocket speed then CPM's
would be 500, not 1000 — so either the field is something else or the
index-to-mode mapping is not what it looks like. Nothing reads the table by
absolute address (readers hold a pointer), so `--xref` cannot close the gap,
and following the pointer is decompilation, which
`.agent/plans/CPMA-REVERSE-ENG.md`'s scope line puts out of bounds.

**The next thing worth trying** is identifying what the 636-byte record is by
finding the same table in `cgame.qvm` and matching one field against a value
already known from this document. Until then, 1000 stands on the same footing
as everything else in CPM mode: community-documented, and never described as
verified.

## Compiled-in `bg_pmove` globals

A contiguous float block, identical in both VMs. cgame addresses given first,
qagame in parentheses; the two differ by a constant offset of `0x105c8`.

| address | value | what reads it |
| --- | --- | --- |
| `0x1282c` (`0x2264`) | 6 | `PM_Friction` (cgame fn 126442) |
| `0x12830` (`0x2268`) | 100 | `PM_Friction` |
| `0x12834` (`0x226c`) | 0.25 | `PM_WalkMove` (cgame fn 129299) |
| `0x12838` (`0x2270`) | 8 | cgame fn 128334 |
| `0x1283c` (`0x2274`) | 3 | `PM_Friction` |
| `0x12840` (`0x2278`) | 5 | `PM_Friction` |
| `0x12844` (`0x227c`) | 60 | the water sink speed (cgame fn 128094) |
| `0x12848` (`0x2280`) | **30** | `PM_AirMove` (cgame fn 128586) |
| `0x1284c` (`0x2284`) | **70** | `PM_AirMove` |
| `0x12850` (`0x2288`) | **2.5** | `PM_AirMove` |

`0x12814`–`0x12828` immediately before it hold `-15,-15,-24` and `15,15,32` —
id's player bounding box, unchanged.

These are the values id declares as file-scope floats in `bg_pmove.c`, in a
recognisable run: friction 6, stopspeed 100, duckScale 0.25, flightfriction 3,
spectatorfriction 5. That run is what identifies `PM_Friction` (the only
function reading 6 and 100), and from there the rest of the pmove cluster falls
out by call graph. **CPMA leaves every one of these values alone**, and appends
the three CPM ones to the same block.

One qualification, because `PM_Friction` does have a mode branch: when the mode
index in `pmove_t` offset 240 is 3 — `CQ3` — ground friction is used as
`pm_friction - 0.4`, i.e. 5.6 rather than 6 (cgame fn 126442 @126556–126574).
Every other mode, CPM and VQ3 included, uses the 6 above. The rest of that
function is id's, including the `max(speed, pm_stopspeed)` control term (which is
why 100 is read twice) and the `PW_FLIGHT` friction term.

`pm_waterfriction` is the one id value CPMA does **not** compile in — it comes
from the settings table instead. See the water set below.

`pm_accelerate` and `pm_airaccelerate` are *not* in this block — see the
settings table below for the first, and note that the second reaches
`PM_Accelerate` as an immediate `1.0f` set at the top of `PM_AirMove`
(cgame fn 128586 @128588).

Corroborating immediates, all id's own values and all unchanged: `OVERCLIP`
1.001 (cgame fn 124509, `PM_SlideMove`), `MIN_WALK_NORMAL` 0.7 and `STEPSIZE`
18 (cgame fn 125641, `PM_StepSlideMove`), `pml.frametime = msec * 0.001`
(cgame fn 133578, `PmoveSingle`).

## The physics-mode settings table

CPMA does not compile its CPM tunables in. It builds a table of five physics
modes at startup and hands `pmove_t` a pointer into the selected row; the
`bg_` code reads its tunables through that pointer.

Built by qagame fn 29480. Row base `1091532`, stride **636** bytes, five rows,
each row's first two words being pointers to its short and long name:

| index | name | built how |
| --- | --- | --- |
| 0 | `VQ3` / "Vanilla Quake3 (OSP)" | fields set individually |
| 1 | `PMC` / "ProMode Classic" | fields set individually |
| 2 | `CPM` / "Challenge ProMode" | **copied from row 1**, then overridden |
| 3 | `CQ3` / "Challenge Quake3" | copied, then overridden |
| 4 | `DEV` / "T's Playground" | copied from row 2 |

The copy is a 636-byte block move whose source address is the previous row's
base — for CPM, `1092168`, which is exactly `1091532 + 636`. **So CPM inherits
every PMC field it does not override, including all four below.** Mode 2 (CPM)
is also the default when the requested index is out of range (qagame fn 31679
@31684).

The pointer handed to pmove is the row base **plus 8**, i.e. past the two name
pointers (cgame fn 133578 @133594–133605 stores it into `pmove_t` offset 228).
Offsets below are relative to that pointer, which is how the `bg_` code sees
them. The mode index itself is also copied into `pmove_t` offset 240
(cgame fn 133578 @133616–133622).

| offset | VQ3 | PMC / CPM | meaning, and where that was read |
| --- | --- | --- | --- |
| +0 | 0 | **150** | air control strength. `PM_Aircontrol` multiplies by it; `PM_AirMove` tests it against 0 to gate the entire CPM branch. |
| +4 | 10 | **15** | ground `pm_accelerate`. `PM_WalkMove` loads it at entry and passes it to `PM_Accelerate` as the accel argument, falling back to `1.0f` on the slick/knockback path — id's own structure. |
| +8 | 0 | **1** | double jump enabled. |
| +12 | 0 | **1** | ramp jump enabled. |

Field +0's value 150 is at qagame fn 29480 @30280, +4's 15 at @30282, +8's 1 at
@30290, +12's 1 at @30298 — all in the PMC row, all inherited by CPM.

Four more have read sites, and they are the water set. CPMA moves all of id's
water tunables into the table, and the VQ3 row holds exactly id's own declared
values, which is what identifies them:

| offset | VQ3 | CPM | read by |
| --- | --- | --- | --- |
| +84 | 0.5 | 0.75 | `PM_WaterMove` (cgame fn 128094 @128223, @128245) — id's `pm_swimScale` |
| +88 | 0.7 | 1 | `PM_WaterMove` (@128176, @128198), under a `waterlevel == 1` branch — id's `pm_wadeScale`, which id declares and never uses |
| +92 | 1 | 0.75 | `PM_Friction`'s water term (cgame fn 126442 @126615) — id's `pm_waterfriction` |
| +96 | 4 | 5 | `PM_WaterMove`'s `PM_Accelerate` call (@128260) — id's `pm_wateraccelerate` |

CPM's water values are recorded but **deliberately not implemented**; see "What
this changes" below for why.

The row holds roughly thirty further fields whose values differ per mode. They
were not chased: without a read site a number is not a finding. The eight above
are listed because each has one.

## `PM_AirMove` (cgame fn 128586, reached from `PmoveSingle` fn 133578)

Identified by reading 30/70/2.5 and by calling `PM_Friction`, which is where id
calls it from.

- Accel starts at `1.0f` — id's `pm_airaccelerate`.
- **The whole CPM branch is gated on air control being non-zero.** When it is
  zero the function goes straight to `PM_Accelerate` with accel `1.0f`, which
  is stock Q3 air movement. This is how VQ3 mode stays VQ3.
- Inside the gate, in this order:
  1. **`PM_Aircontrol` runs first**, before accelerating, and is handed the
     **unclamped** wishspeed.
  2. Then `DotProduct(velocity, wishdir) < 0` selects accel 2.5 — and because
     air control already ran, that dot product is taken against the *rotated*
     velocity.
  3. Then, if `ps->movementDir` is 2 or 6, wishspeed is clamped to 30 and accel
     becomes 70. id's `PM_SetMovementDir` assigns 2 and 6 exactly when
     `rightmove != 0 && forwardmove == 0`, so this is the strafe-only branch,
     expressed through `movementDir` rather than through the command directly.
  4. `PM_Accelerate(wishdir, wishspeed, accel)`.

## `PM_Aircontrol` (cgame fn 128368, called only from `PM_AirMove`)

- Returns immediately unless `ps->movementDir` is 0 or 4 — forward-only or
  backward-only, i.e. no strafe key — and wishspeed is non-zero.
- Sets `velocity[2]` aside, normalises the horizontal velocity, and takes
  `dot = DotProduct(velocity, wishdir)`.
- `k = 32 * aircontrol * dot * dot * frametime`. The `32` is an immediate
  (@128469); `aircontrol` is settings field +0.
- The blend toward wishdir happens only when `dot > 0`. The rescale back to the
  original speed and the restore of `velocity[2]` happen on **both** paths.

## `PM_Accelerate` (cgame fn 126744)

id's `#if 1` q2-style branch, unchanged: `addspeed = wishspeed -
DotProduct(velocity, wishdir)`, early-out at `addspeed <= 0`, `accelspeed =
accel * frametime * wishspeed` capped at `addspeed`. The `#else` "proper way"
branch is not present. **The strafe-jump maxspeed bug is intact in CPMA**, as
it must be.

## `PM_CheckJump` (cgame fn 127526, qagame fn 19126)

id's guards are unchanged: `PMF_RESPAWNED`, `cmd.upmove < 10`, `PMF_JUMP_HELD`,
then clearing groundPlane/walking, setting `PMF_JUMP_HELD` and
`groundEntityNum = ENTITYNUM_NONE`.

Then, and this is the part that differs from both id and Warsow:

- **Jump velocity is 275, not id's 270.** Read at cgame fn 127526 @127674 and
  @127684, and at qagame fn 19126 @19274 and @19284. It is unconditional —
  every CPMA mode including its VQ3 jumps at 275. (This does **not** change our
  `JUMP_VELOCITY`. Our VQ3 reference is id's source, where 270 is verified;
  CPMA's VQ3 emulation is not our VQ3 reference. 275 belongs to the CPM path
  only.)
- **Ramp jump** (settings +12): when enabled *and* `velocity[2] > 0`, 275 is
  **added** to `velocity[2]`; otherwise `velocity[2]` is set to 275. There is
  no clip against the ground plane here — Warsow's `PM_ClipVelocity` step has
  no counterpart in CPMA's jump.
- **Double jump** (settings +8): when enabled and a countdown timer in
  `playerState` offset 212 is still positive, **105 is added** to
  `velocity[2]` (@127710) and a flag at offset 216 is set. Then the timer is
  reset to **400**, or to **152** when the mode index in `pmove_t` offset 240
  is 3 — i.e. only in `CQ3`.
- The timer is in **milliseconds**: `PmoveSingle` decrements it by `pml.msec`
  each frame while it is positive (cgame fn 133578 @134257–134277), and clears
  the offset-216 flag once it expires. Nothing else in the pmove path writes it
  — in particular **landing does not reset it**, so the window is 400 ms from
  the previous jump, not from touching the ground. (qagame's client-spawn paths
  were not swept; a respawn presumably clears it along with the rest of
  `playerState`, which is what this port does.)

With both features on, a double jump off a ramp reaches `velocity[2] + 275 + 105`.

## What this changes in our implementation

Recorded here so the reasoning survives; the code carries its own citations.

| ours before | CPMA | verdict |
| --- | --- | --- |
| `AIR_STOP_ACCELERATE` 2.5, "reconciled by judgement" against Warsow's 2.0 | 2.5 | we were right; the hedge goes |
| `AIR_CONTROL` 150, `STRAFE_ACCELERATE` 70, `WISH_SPEED` 30 | same | confirmed |
| air control **after** `PM_Accelerate` (Warsow's order) | **before** | changed to match |
| ramp jump clips velocity against the ground plane first (Warsow) | no clip; add-instead-of-set is the whole mechanic | clip removed |
| double jump = "add jump velocity whenever `velocity[2] > 0`" | separate: a 400 ms timer and a flat +105 | reimplemented |
| CPM jump velocity 270 | 275 | changed, CPM path only |
| CPM ground acceleration not modelled (10 everywhere) | 15 | added |
| CPM water tunables not modelled (id's everywhere) | swim 0.75, wade 1, friction 0.75, accel 5 | **not** changed — see below |

The water set is left alone on purpose. Three of the four are constants that
could be swapped in an afternoon, but the fourth (+88) is only reached through a
`waterlevel == 1` wading branch that **id's `PM_Friction`/`PM_WaterMove` do not
have at all** — id declares `pm_wadeScale` and never uses it. Porting three of
four and skipping the mechanism the fourth belongs to would be a partial change
that alters observable behaviour without matching either original, which is
exactly the failure mode CLAUDE.md's prime directive warns about. Either do the
wading branch properly or leave water as id wrote it; for a sidescrolling
speedrun game with no swimming courses, leaving it is the better trade. The
numbers are recorded above so that decision can be revisited without re-reading
the binary.

**Existing CPM ghosts and records were recorded under the old physics.** Every
CPM change here moves velocity, so a CPM ghost saved before 2026-08-30 replays
along a different path than it was recorded on, and a CPM personal best was set
under physics that no longer exists. Ghosts stay loadable (`readPlayerSnapshot`
defaults the new field) but they will diverge. Whether to version-stamp or
invalidate CPM records is a product decision, not a physics one, and is
deliberately left open.

## What was not read

- The ~30 unnamed settings fields.
- Everything gated on the second `pmove_t` pointer at offset 232, which can
  override the two jump flags per client (cgame fn 127526 @127623–127649).
- Whether `phys_jumpvel` and `phys_maxbarrier` (qagame strings `0x8965`,
  `0x8951`) carry values relevant to pmove. They sit among botlib variable
  names, where id's own code has variables by those names, so the neighbouring
  literals `"150"` and `"275"` were **not** treated as physics values.
