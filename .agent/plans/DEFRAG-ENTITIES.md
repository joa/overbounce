# DeFRaG entity support

Source: `.agent/docs/defrag-entities-spec.xml`, pasted into chat by the repo owner
(2026-08-20) from https://ws.q3df.org/level_design/df_install/, which Claude could
not fetch directly (WebFetch and curl both got HTTP 403, a Wayback Machine mirror
was refused, and the connected Chrome extension was unavailable at the time).

The paste ends after `trigger_push_velocity`'s closing `</group>` with no closing
`</classes>` tag, which looked like it might be a partial copy — confirmed with
the repo owner (2026-08-21) that this is the complete relevant section, not a
truncation. Treat any DeFRaG entity not covered here as simply out of scope for
this pass, not as spec text that was cut off.

## What this covers

Ten entities from the spec: `target_startTimer`, `target_stopTimer`,
`target_checkpoint`, `target_fragsFilter`, `target_init`, `target_smallprint`,
`shooter_grenade_targetplayer`, `shooter_plasma_targetplayer`,
`shooter_rocket_targetplayer`, `trigger_push_velocity`.

## target_init — a real bug fix, not just new coverage

The previous implementation had spawnflag bit 32 (value 32) as `KEEP_AMMO`. The
real spec (confirmed against the source above) names it `REMOVEMACHINEGUN`: strip
the machinegun from the reset loadout, with no effect if `KEEPWEAPONS` is set.
There is no separate "keep ammo" flag in the real entity at all — ammo travels
with the weapon it belongs to.

This is now fixed (`src/game/course.ts`'s `InitKeep`/`initKeep`, `src/game/game.ts`'s
`applyInit`). Ammo clears exactly when `KEEPWEAPONS` is off, tied to the weapon
reset rather than living behind its own flag. `removeMachinegun` is carried on
`InitKeep` for fidelity to the spec's flag list but is a **documented no-op**
here: it only matters when `KEEPWEAPONS` is off, and this project's own weapon
reset already clears to `Weapon.NONE` — `Weapon` (`src/game/weapons.ts`) has no
machinegun to begin with, unlike id's own gauntlet+machinegun default loadout.

`test/game/course.test.ts`'s "decodes the keep spawnflags" test used to justify
spawnflags 32 by citing acc_fuzzle, a real shipped map, as carrying it. acc_fuzzle
is a shootable-button course — stripping the machinegun so its buttons get shot
with real movement weapons is a far more coherent authorial intent than "keep
ammo" ever was, and the corrected comment says so. `test/game/defrag-maps.test.ts`
(opt-in, assets already present locally) still passes against the real acc_fuzzle
BSP after the fix.

CLAUDE.md's own "Known-uncertain items" section carried the wrong bit meaning;
corrected in the same change.

## target_smallprint

The spec's own description is identical to `target_print`'s: one message,
centre screen, on trigger. Aliased to the same `'print'` CourseEvent
(`src/game/course.ts`'s `use()` switch) rather than given a separate path. The
REDTEAM/BLUETEAM/PRIVATE spawnflags meet the same one-client, no-teams reality
`target_print`'s own team spawnflags already do, for the same reason.

## target_fragsFilter

Gates its target behind a frag count. This project has no frag/kill counting
system at all — no enemies, no combat, per CLAUDE.md's own description of the
game. Out of scope by construction, not an oversight. `Course`'s constructor
emits a `console.warn` when a map contains one, naming its targetname, so a
route gated on frags reads as "diagnosably broken" rather than "mysteriously
locked."

## target_stopTimer's own `target` key

The spec: *"target: stopTimer triggers its targets when a best time occurs."*
Course cannot judge "best time" — that lives in `main.ts`'s `RecordBook`
(`src/game/records.ts`) — so `touch()`'s `'finish'` CourseEvent now carries the
firing stopTimer's own `target` key verbatim (`CourseEvent.stopTimerTarget`),
unconditionally, and `Course.fireTargetChain(targetname, time, ps)` is a new
public method that runs the same chain-firing `use()` already does internally,
exposed so a caller can invoke it after deciding "best" on its own. `main.ts`'s
`'finish'` handler calls it only when `records.runEnded(...)` returns `improved`,
and only dispatches `'print'`/`'speaker'` from the result — the realistic targets
of a congratulatory chain. Anything else the chain reaches (another shooter, a
mover) is reported and not acted on, the same standing every other "Course
reports it, something else decides" event already has.

## trigger_push_velocity

A DeFRaG jump-pad/launch-ramp entity, distinct from the existing `trigger_push`:
rather than solving one true parabolic arc (`AimAtTarget`), it sets or ADDS a
configured `speed`(XY)/`count`(Z) magnitude along a configured direction.
Implemented in `src/game/course.ts` as `buildPushVelocity` (load-time: the
target-relative direction, since that's fixed map geometry) plus
`touchPushVelocity`/`applyPushVelocityXY`/`applyPushVelocityZ` (per-touch: the
live-player-dependent parts). Tests: `test/game/course.test.ts`'s
`describe('touchPushVelocity', ...)`.

Two calls the spec text does not settle, made explicitly rather than silently:

1. **`CLAMP_NEGATIVE_ADDS` has no bit number in the source.** The six named
   flags (`PLAYERDIR_XY`, `ADD_XY`, `PLAYERDIR_Z`, `ADD_Z`, `BIDIRECTIONAL_XY`,
   `BIDIRECTIONAL_Z`) take bits 0–5. Bit 6 (value 64) is used as the next free
   slot — this project's own choice, not the spec's. See the
   `PUSHVEL_CLAMP_NEGATIVE_ADDS` constant.
2. **ADD-mode re-application rate.** A SET pad is idempotent per touch; an ADD
   pad is not. The spec's own "client side predicted" framing points at pmove's
   rate, which at DeFRaG's canonical `com_maxfps 125` is exactly this project's
   fixed 8ms tick — so applying once per `touch()` call (the same rate
   `touchJumpPad` re-launches a SET pad at) is what "predicted" argues for, not
   a documented number. Pinned by a test that drives two touches and asserts
   the second compounds rather than being idempotent.

## shooter_rocket/grenade/plasma, with and without `_targetplayer`

**The base entity is a verified port, not folklore.** `Use_Shooter`/`InitShooter`
in `refs/quake3/game/g_misc.c` are real id source, confirmed present before
writing any of this: pick a direction (a resolved `target_position`/
`info_notnull`, or `movedir` from `angles` if there is no target), build a plane
perpendicular to it (`PerpendicularVector`, ported to `src/math/vec3.ts` since
`src/game/` needs a float32 version and the existing one in `src/render/portal.ts`
uses a different, non-fround'd vector type), and nudge the aim within that plane
by two independent `crandom() * random` amounts before renormalizing. `random`
is stored as `sin(PI * random_degrees / 180)`, matching id's own quirk of
converting the map-author-facing degree value to a coefficient once, at load.

One direct conflict between the two sources, resolved in id's favour: the
ws.q3df.org text claims `random`'s default is 0 ("random aiming variance in
degrees ... default 0"). id's own source -- the verified side of this entity --
coerces an absent key OR an explicit `random 0` to 1.0 instead
(`if (!ent->random) ent->random = 1.0;`, a C float 0 being falsy). id wins;
see the comment at `buildShooter`'s `randomDegrees` in `src/game/course.ts`.

Both the base classnames (`shooter_rocket`, `shooter_grenade`, `shooter_plasma`)
and DeFRaG's `_targetplayer` suffix are recognised
(`shooterWeapon()`/`buildShooter()`/`aimShooter()` in `src/game/course.ts`) —
the suffix only adds spawnflags/keys on top of the same base behaviour.

**TARGETPLAYER/PREDICT_XY/PREDICT_Z is the unverified DeFRaG extension.** The
spec names `speed`/`count` as "adjusts XY/Z leading of player target" but gives
no formula. This project's interpretation (`aimShooter`'s doc, `src/game/course.ts`):
the aim point is the player's live origin, moved `speed` units along their
current horizontal direction of travel (if `PREDICT_XY`) and `count` units along
the sign of their vertical velocity (if `PREDICT_Z`) — a plain linear lead, not
a closed-form intercept solve. Treat this as community-flavoured invention, not
a documented number, the same standing this project already gives CPM physics.

**`notfree` is honoured; `notteam`/`notsingle` are read and ignored.** This
project's whole runtime is one player and no teams — functionally always
Quake's "Free for All" — so `notfree` suppresses a shooter exactly as it would
suppress that entity from spawning in FFA. There is no team mode to exempt
`notteam` from, and "Single Player" in the spec names Quake's bot-play mode,
which this project also does not have, so `notsingle` has no referent here
either.

**Missile spawning is a new, parallel Game code path.** Course resolves the aim
geometry (origin, direction, deviation cone, prediction) since that needs map
entities and RNG it owns, and reports a `'shoot'` CourseEvent
(`shooterWeapon`/`shootOrigin`/`shootDir`); `Game`'s course-event loop
(`src/game/game.ts`) calls `fireRocket`/`fireGrenade`/`firePlasma` and pushes the
result into `this.missiles`, exactly the split every other Course-reports/
Game-applies event already uses. The owner number is `ENTITYNUM_WORLD`, not
`PLAYER_NUM`: `missiles.ts`'s trace ignores its owner, so a shooter's rocket must
NOT be given the player's own entity number or it would pass straight through
them; and `damage.ts` treats a hit as self-inflicted (halved, or suppressed by
`?selfdamage=0`) when the target's own number equals the attacker's, which must
not apply to a shooter's hit — it is not a self-inflicted rocket jump.

Tests: `test/game/shooters.test.ts` — aiming at a resolved target, the `angles`
fallback, TARGETPLAYER, the PREDICT_XY lead pinned as this project's own
interpretation, `notfree` suppression, the deviation cone staying normalized,
and an end-to-end `Game` test confirming a real missile gets spawned.

## What was NOT changed

`target_startTimer`/`target_checkpoint` were already implemented and the spec's
own text for both is minimal (name and bounding box only) — no discrepancy
found, nothing to change.
