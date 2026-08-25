# ob_rockets: a rocket/grenade-jump tutorial course

Status: rebuilt after user playtest feedback (2026-08-25). Compiled clean (no leak),
gameplay lint clean, bundled and playable via `?map=ob_rockets` with no devpak.
Second tutorial map alongside `ob_basics`. Beginner-to-intermediate difficulty —
harder than the first draft on purpose, because the first draft's obstacles were
all skippable.

## Files

- `maps/ob_rockets.map` / `maps/ob_rockets.bsp` / `public/maps/ob_rockets.bsp`
  (the .bsp must exist in **both** map dirs — `loadBundledMap` fetches from
  `public/maps/`, and the two silently diverge if only one is rebuilt; see
  target-print.md's "stale BSP" section for the bug this caused once already).
- `scripts/ob_rockets.cam` — `"lock" "y 0"`, side view, same values as `ob_basics.cam`.
- Added to `BUNDLED_MAPS` in `src/main.ts` (`?map=ob_rockets` works without a devpak).
- Pak/deploy integration (`tools/build-oapak.ts`, `course-select.ts`'s
  `BUNDLED_PAKS`, `.github/workflows/deploy-pages.yml`, README.md,
  `docs/url-parameters.md`) was picked up by a concurrent session while this map
  was being built — not verified by this session, see git history for that work's
  own authorship.

## Round 1 → round 2: what the user's playtest caught, and the fix

The first build (git history) had five real problems. Each traces to a specific
design mistake, not a missing feature:

1. **"Every rocket jump can be skipped."** The vertical walls (200/300 unit rises)
   were never skippable — jump apex is 48.6, nothing close. The **pits** were:
   each was a simple gap with a same-level landing on the far side, and gap width
   can never gate a jump in this engine because horizontal speed is uncapped
   (the strafe-jump maxspeed bug this whole project is named for). A fast player
   just jumped across and never touched a rocket. **Fix:** pits no longer have a
   same-level far side. The far platform is raised **100 units above the approach**
   (comfortably past the 48.6 jump apex plus the 18-unit step-up margin —
   see `physics-for-map-authors.md` section 3's "Beware the 18-unit step-up").
   A player who doesn't rocket-jump simply falls into the pit; there is no
   alternate path across.
2. **"No grenade + rocket jump."** Missing entirely. Added as the finale — see below.
3. **"No overbounce to rocket jump (mandatory)."** The map had rocket-jump-into-OB
   (wall H → OB3, already mandatory) but not the reverse: OB-then-rocket-jump.
   Added by shortening OB2's landing to a stub and putting a fresh 200-unit wall
   immediately after it, so walking off the OB2 edge is now step one of a
   two-step mandatory sequence, not a self-contained obstacle.
4. **Megahealth was at the very end**, useless for the six earlier health-costing
   jumps. Moved to right after the rocket launcher pickup (~x1340) — items
   respawn (`RESPAWN_MEGAHEALTH` = 35s), so one early megahealth serves runs that
   pass back through, and every subsequent jump in the course can draw on it.
5. **No rescue/respawn triggers.** `respawn()` (`src/game/respawn.ts`) is a direct
   port of `ClientSpawn` "minus... spawn-point selection (a course has one start)"
   — dying or falling into the void sends the player all the way back to
   `info_player_start`, regardless of `target_checkpoint`s (those only record
   timer splits, they are not spawn points). On a 6000+ unit course with a
   grenade+rocket combo near the end, that is brutal. Fixed the way `ob_basics`
   already does it (entities 25/26 there): `trigger_teleport` + `misc_teleporter_dest`
   pairs, placed as a deliberate walk-in strip along the back wall of the two
   hardest failure points (pit 2's bottom, the combo shaft's bottom) rather than
   covering the whole retry floor — so a struggling player has an explicit
   "give up and reset to the approach" option that doesn't interfere with normal
   retry attempts on the same floor.

Also added: 4 more `target_checkpoint`s (cp2-cp5, roughly one per 1000-1200 units
instead of the original 2 for the whole course) and more ammo/health caches at
each hard section, since costs compound across a longer mandatory chain.

## The grenade+rocket combo: measured, not guessed

Advisor caught that the global `weaponTime` (`src/game/game.ts`) gates *shots*, not
*explosions* — the grenade's 2500ms fuse decouples them. Measured with a scratch
harness (`Game`, fresh instance, grenade fired at the feet at t=0, held still, then
jump+fire the rocket at a swept tick offset):

| rocket-fire tick | ms after grenade | apex rise |
| --- | --- | --- |
| 290 | 2320 | 443 |
| 300 | 2400 | 626 |
| 308 | 2464 | 793 |
| **311** | **2488** | **826 (peak)** |
| 313 | 2504 | 811 |
| **314** | **2512** | **455 (cliff)** |
| 318 | 2544 | 380 |

The fuse is exactly 2500ms (tick 312.5). Fire the rocket at or before the grenade's
own natural detonation and both impulses land together; fire even 16ms after and
the grenade has already gone off alone, and the rocket only adds its own ~370-ish
on top of an already-fired jump — a hard cliff, not a gradient. The obstacle is
sized to **420 units**, chosen because it's clearly inside the forgiving side of
that cliff (tick 290 through roughly tick 316 all clear it — a wide, beginner-safe
window) while being unreachable by any single technique (max single-weapon rise is
368-381). Hint text describes the technique qualitatively ("drop a grenade and
wait, then jump and fire right as it's about to pop") rather than quoting tick
numbers a player can't act on.

## Course layout (x increases = rightward; z_top = walking surface height)

| x range | z_top | what |
| --- | --- | --- |
| -320..668 | 0 | start, spawn (-224,0,40), welcome + GO hints |
| 668..700 | 0 | achtung edge stripe |
| 700..1700 | -260 | OB #1 landing (260 drop, normal walk-off OB) + rocket launcher/ammo, **megahealth** |
| 1700..2300 | -60 | rocket-ledge wall, 200 rise (mandatory, jump apex 48.6 << 200) |
| 2300..2600 | -60 | grenade launcher/ammo pickup |
| 2600..2700 | 4 | grenade-ledge wall, 64 rise (mandatory, grenade drop-and-wait rise is 78) |
| 2700..2882 | 4 | run-up + achtung stripe |
| 2882..3050 | -213 | OB #2 landing, **shortened to a stub** (217 drop) — step 1 of the OB→RJ chain |
| 3050..3250 | -13 | new wall, 200 rise — step 2 of the OB→RJ chain (mandatory) |
| 3250..3450 | -13 | approach to pit 1 |
| 3450..3610 | -133 | pit 1 bottom (120 deep from approach) |
| 3610..3850 | 87 | pit 1 exit, **raised 100 above the approach** (total RJ: 220, mandatory) |
| 3850..4050 | 87 | approach to pit 2 |
| 4050..4210 | -93 | pit 2 bottom (180 deep) — rescue teleporter on the back wall |
| 4210..4450 | 187 | pit 2 exit, raised 100 (total RJ: 280, mandatory) |
| 4450..4650 | 187 | approach to the RJ wall |
| 4650..5050 | 487 | RJ wall, 300 rise (hardest single jump) + achtung stripe |
| 5050..5450 | 81 | OB #3 landing (406 drop) — only reachable because of the RJ |
| 5450..5650 | 81 | combo shaft approach — grenade/rocket ammo, health top-up |
| 5650..5850 | -339 | combo shaft bottom (420 below the rim) — rescue teleporter on the back wall |
| 5850..6500 | 81 | exit + finish |

OB drop heights (260, 217, 406) are exact entries in the verified ob-heights table
(`npm run ob-heights`); unchanged from round 1 since the z-shift preserves each
drop's top-to-top difference exactly. Non-OB traversal heights (walls, pit
raises/depths) don't need table membership, only margin under the measured rise
numbers.

## Known gaps / left for later

- `map_design_review`'s spatial pass still flags 100% axis-aligned brushes and one
  ceiling-clearance rhythm — true, accepted, same as `ob_basics`.
- Live play-preview (`map_play` + `game_screenshot`) stayed on a black frame again
  this session; structural QA relied on `map_compile` (leak-free), `map_gameplay_lint`
  (clean), `map_validate` (clean besides expected `unknown-class` info), and
  `editor_capture` screenshots, plus a dev-server console check confirming the map
  loads without errors in the actual game (not just the editor). A human playtest
  is still the real test, especially for the combo's timing window.
- The rescue teleporters cover the two hardest failure points (pit 2, the combo
  shaft) but not pit 1 or the RJ wall — those are recoverable by construction
  (falling back just lands you on solid ground with ammo nearby) so a teleporter
  there would be decorative, not load-bearing. Revisit if playtesting disagrees.
