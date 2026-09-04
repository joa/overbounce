# Overbounce

<img src="media/demo.webp" width="839" alt="Overbounce demo">

A browser-based 3D sidescrolling speedrunning game built on a bug-for-bug faithful port of
Quake III Arena movement. No enemies, no combat — just obstacle courses and the movement
techniques Q3 players have been refining since 1999: strafe jumping, circle jumps, rocket
jumps, plasma climbing, and the mechanic the game is named after.

The physics are not "inspired by" Quake 3. They are a line-by-line port of `bg_pmove.c`,
`bg_slidemove.c` and `cm_trace.c`, including the bugs — because in a movement game the bugs
*are* the mechanics.

This project is pure slop; no code was written by a meatbag.

**[▶ Play now](https://joa.github.io/overbounce/)** — runs in the browser, nothing to
install. Starts on `ob_basics` and `ob_rockets`, the two tutorial courses built into the
page itself; course select can load any other Quake 3 map you drop onto it.

The load-bearing counter: 47

## Controls

| | |
| --- | --- |
| WASD | move |
| mouse | turn &middot; **left** fire &middot; **right** jump |
| space | jump |
| ctrl | crouch |
| **1 / 2 / 3** | rocket launcher, grenade launcher, plasma gun |
| **wheel** | cycle the weapons you are carrying |
| **X** | kill yourself, which restarts the run |

Right-click jumps because rocket jumping wants fire and jump on the same hand
and within a frame of each other, and reaching for space to do it is the most
awkward thing about the default binding.

Slot **4 is reserved for the rail gun**, which is not implemented — it is a
hitscan weapon with a trail effect and a `g_weapon.c` port behind it, and some
maps will need it to shoot a target.

## What "faithful" means here

Three properties emerged from the port rather than being tuned in, which is the best
evidence available that it is correct:

**Overbounce works, and it is rare.** Landing frames that end between 0.125 and 0.25 units
above a surface skip collision clipping entirely, so the player is still carrying full
falling speed when `PM_WalkMove` flattens the velocity vector against the ground and
rescales it back to its original magnitude. The trigger window is an eighth of a unit
wide, which is why real overbounce spots are specific coordinates on specific maps.

It has two faces, and they are the same four lines of code:

- **Running into one** redirects the fall speed horizontally. A 312-unit drop at 100ups
  comes out at **658ups**.
- **Dropping onto one** launches you straight up. With no horizontal velocity, clipping
  leaves only the small positive residual `OVERCLIP`'s asymmetry creates, normalizing it
  gives exactly `(0,0,1)`, and the rescale fires you upward at the speed you landed at —
  **−390ups in, +390ups out**, returning you to the height you fell from. This is the one
  Q3 players mean by "an OB", and it is what makes those spots useful for reaching
  places you otherwise cannot.

**Strafe jumping beats the speed cap.** `PM_Accelerate` only measures speed along the
direction you are asking to move, so holding an offset angle keeps the cap permanently
unreached. Optimal play climbs from 320ups to over 1200ups in ten seconds.

**125fps jumps higher than 1000fps.** Velocity is snapped to integers every frame. At 8ms
ticks, gravity's 6.4 per frame rounds to 6, giving an effective gravity of 750 and a 48.6
unit jump; at 1ms it rounds 0.8 up to 1.0, giving effective gravity 1000 and a 36.5 unit
jump. Q3 players established `com_maxfps 125` as the competitive standard by feel two
decades ago. Reproducing that ordering from the constants alone is what pinned down the
otherwise-unresolvable `trap_SnapVector` rounding mode — see
`test/physics/snapvector.test.ts`.

## Courses

The entity layer is a port too, not a reimplementation: `G_TouchTriggers`, `AimAtTarget`,
`BG_TouchJumpPad`, `TeleportPlayer`, `G_UseTargets`. Real Quake maps work as courses
because their triggers behave the way the map author expected.

Jump pads are the nicest example of why porting beats approximating. `AimAtTarget` does
not launch you at a speed in a direction — it solves for the time a body takes to *fall*
from the target's height, gives you exactly the vertical velocity that reaches it, then
picks whatever horizontal speed covers the rest in that same time. The arc is fixed by
the geometry with no tuning knob, which is why a Quake jump pad lands you *on* its target
rather than near it. Verified against every `trigger_push` in two real maps — 30 pads, no
hand-picked fixtures.

Timing uses the defrag convention: `target_startTimer`, `target_checkpoint`,
`target_stopTimer`. Those three have no id source behind them and are implemented from how
defrag maps use them, which the code says out loud rather than quietly claiming as a port.

The rest of DeFRaG's own entity set is verified against the official ws.q3df.org level-design
reference (`.agent/docs/defrag-entities-spec.xml`), not memory: `target_init`, `target_smallprint`,
`target_fragsFilter` (reported, never acted on — this project tracks no frags), `trigger_push_velocity`,
and `shooter_rocket`/`_grenade`/`_plasma` with DeFRaG's `_targetplayer` extension. The base shooters
are a real id port (`Use_Shooter`, `g_misc.c`); TARGETPLAYER/PREDICT_XY/PREDICT_Z is
community-documented, the same standing CPM physics has. See `.agent/plans/DEFRAG-ENTITIES.md`.

**Ghosts are usercmd streams, not paths.** Replaying the stream through the same
deterministic pmove puts the ghost exactly where you were, so it is a real opponent rather
than an animation — and the test that asserts a replayed run lands on a bit-identical
final origin doubles as the determinism check for the whole simulation. It wears the player model
the run was recorded with, drawn translucent and blue-tinted so it still reads as "not
you" at a glance — and falls back to this session's own default model when the paks do
not carry that one.

## VQ3 and CPM

VQ3 is the default and is the mode with the fidelity guarantee.

**CPM is not a verified port and cannot be one: CPMA's game code is closed source.** What
it does have, since 2026-08-30, is evidence: **every CPM constant in this project was read
out of CPMA 1.53's own shipped VM bytecode**, with the address it came from recorded in
`.agent/docs/cpma-constants.md`. Air control 150, strafe acceleration 70, wishspeed 30,
air-stop acceleration 2.5, ground acceleration 15, jump velocity 275, double jump +105
inside a 400ms window. Reading a stripped binary is not reading a source, so the sentence
this paragraph opens with still stands — but the numbers are no longer guesses, and where
Warsow and community prose disagreed, the bytecode decided.

It corrected four things that had been taken from Warsow on the assumption that Warsow was
following CPM: air control runs *before* accelerating rather than after, CPM's ramp jump
does not clip against the ground plane at all, the double jump is a timer and a flat bonus
rather than "add whenever moving up", and CPM accelerates on the ground half again as hard
as VQ3. The air-stop acceleration, the one number that had been reconciled by judgement,
turned out to be right.

**Ramp jump and double jump are implemented** as `pmCpmJump` in `pmove.ts`. Ramp jump:
jumping while already moving upward *adds* jump speed instead of replacing it, so a ramp's
launch survives. Double jump: jumping again within 400ms of the last jump adds a flat 105
on top — which is a stairs-and-ledges technique rather than a flat-ground one, because a
full-height jump is airborne for longer than the window. VQ3 keeps id's own 270 jump
velocity, not CPMA's 275: VQ3's reference is id's source, and CPMA's emulation of VQ3 is
not that reference.

Select with `?physics=cpm`.


## Licence

GPLv2-or-later. The movement and collision code is a derivative work of id Software's
GPLv2 Quake III Arena source, so the project inherits that licence. See `LICENSE` and
`NOTICE`.

Assets come from [OpenArena](https://github.com/OpenArena). Assets from a commercial
Quake III Arena installation are **not** redistributable and must never be committed here.

Overbounce is not affiliated with or endorsed by id Software or Bethesda Softworks.
