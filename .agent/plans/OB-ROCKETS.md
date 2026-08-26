# ob_rockets: a rocket/grenade-jump tutorial course

Status: round 4 (2026-08-25), after a third pass of user feedback. Compiled
clean (no leak, full-quality VIS/LIGHT), gameplay lint clean, bundled and
playable via `?map=ob_rockets` with no devpak. Second tutorial map alongside
`ob_basics`. Beginner-to-intermediate difficulty — harder than the first draft
on purpose, because the first draft's obstacles were all skippable.

## Round 4: pits become climbing walls — the course now gains real altitude

User's feedback after round 3: "given that it's always only pits, you could
simply jump over them and ignore the rocket jumps. The player should climb
height while running through the level." Two distinct problems hid behind that
one sentence:

1. **The combo shaft was genuinely skippable, not just theoretically so.**
   Approach and exit rims sat at the *same* height (81) with a 200-unit gap —
   well inside a plain running jump's ~230-unit range (`physics-for-map-authors.md`
   section 6). A player never needed to fall in and use the grenade+rocket
   combo at all. This was the same bug round 2 already fixed for pit 1 and
   pit 2 (same-level far side + uncapped strafe-jump speed = gap width can
   never gate a jump) — it just hadn't been checked here, because the combo
   shaft's fall-in is load-bearing (the grenade-drop technique needs solid
   ground under the player) and so didn't look like the same shape of bug.
   **Fixed with the same absolute-guarantee trick used on the pits, not a
   wider gap**: the exit rim is raised 100 units above the approach — past
   jump apex (48.6) regardless of horizontal speed — while the *bottom* stays
   at ground level so the grounded grenade-drop still works. Approach 81 →
   136, exit 136 → 236, bottom recomputed to keep the combo's proven 420-unit
   rise requirement: 236 − 420 = −184 (fall-in drop is 320, deliberately not
   an ob-heights table entry, so entering the shaft doesn't itself overbounce).
2. **Pit 1 and pit 2 were still net-zero elevation**, even after round 2 made
   them mandatory: fall in, rocket out to *about where you started*. The
   course never actually climbed — it just returned to the same working
   band of z after each obstacle. **Fixed by removing the pits as a shape
   entirely.** Pit 1 and pit 2 are now flush walls, exactly like the
   rocket-ledge/grenade-ledge/H walls already were: no gap, no fall, just an
   approach running straight into a wall that must be rocket-jumped. Their
   rises are unchanged (220, 280) but now stack as *net* gain instead of
   being spent climbing back out of a self-dug hole. A new short overbounce
   (245 units, an existing verified table value) is inserted between the two
   walls as a pacing beat — a "breather" that trades a little height back for
   variety without erasing the climb, the same way `ob_basics` already
   alternates techniques rather than repeating one for its whole length.

Net effect: every number downstream of pit 1 shifted up by a constant +55
(wall 2's approach and the H section — the exact amount pit 1's rise grew by,
220 vs. the old 100-unit pit-exit raise, minus the new OB's 245 drop), and
everything from the combo shaft's exit onward shifted up by +155 (the raised
exit). The course's peak (H's top, 542) still clears the shell's inner ceiling
(668, confirmed from the shell brushes directly, not assumed) by 126 units —
checked before building, not after.

**A process note for next time, not a design note:** building this revealed
that `map_apply` resolves numeric entity refs (`E77`, not `@symbolicId`)
*live*, against the document as it stands after earlier operations in the same
batch — so a `delete` of two entities early in a large batch silently shifts
every later numeric ref by the deleted count for the rest of that batch. The
round-4 batch deleted `E71`/`E72` first and then used ~30 numeric refs ≥73;
every one of them landed on the wrong entity, scrambling hint text, trigger
boxes, and item positions. Symbolic refs (`@hintObMid`, from `id` on an
earlier `create_entity` in the same batch) were unaffected — they resolve by
the identity assigned at creation, not by position. Fixed with a second
corrective batch that touched only brushes and used post-first-batch indices
(stable, since no further entity deletions occurred). Lesson: never mix an
entity `delete` with later numeric-index references in the same batch: delete
entities in their own batch, or address everything else in it by symbolic ID
if it must all happen atomically. `map_gameplay_lint`'s `entity-in-solid`
check caught 4 of the resulting corruptions immediately; the rest were caught
by re-inspecting after the batch instead of trusting the "0 errors" summary,
which validates geometry, not cross-references between operations.

## Round 7: the overhang blocked the real jump it was supposed to let through

User's next message: "there's a brush covering the mh, rl and other ammo so
the access is blocked and one cannot normally progress there." Round 6's
overhang (a ceiling at z400, spanning x5050–5650) was meant to cap a
*glide skip* — but it sat directly in the path of the **legitimate** OB3
fall, which starts at H's top (732) and must physically pass through
z400–432 on the way down to the landing floor (326). A ceiling brush is
just solid geometry: it can't distinguish "this is the intended fall" from
"this is a skip attempt" when both occupy the same airspace on the way
down. Every normal player doing OB3 correctly landed on *top* of the
overhang (an invisible caulk surface at 432) instead of reaching the floor,
sealing off the megahealth, rocket ammo, grenade ammo, and the combo shaft
itself — a beginner-map-breaking regression introduced while trying to fix
an edge-case skip.

Advisor caught the root cause before a third geometry attempt: **any static
blocker placed in the shared ballistic airspace of a legitimate action and
the skip that abuses it will always be wrong** — round 5's version was too
high to stop the glide, round 6's was low enough to stop everyone. There is
no position that solves both, because positioning one *is* the mistake.

The actual fix was to delete the overhang and rely on round 6's own exit
raise, which already closes the glide skip by geometry rather than
kinematics: **finish (750) sits 18 units above H's top (732).** A plain
walk-off can only descend from the takeoff height, so landing above it is
categorically impossible regardless of speed — the plain-glide skip round 5
was chasing was already gone the moment round 6 raised the exit past H's
own height, no ceiling needed. A rocket-assisted jump off H's edge could in
principle still clear it, estimated at roughly 1240 ups for a plain jump
off the edge or ~740 ups if a rocket is fired too — both deep into
expert-strafejump-chain territory, the same tier as the start→rocket-ledge
gap already accepted a few rounds back. Filed alongside it as an accepted
expert-only sequence break, not fixed, since building geometry against it
risks repeating this exact mistake for a skip far above beginner reach.

Removing the brush was a single-brush delete (no entity moves needed — the
two lights nudged clear of the overhang in round 6's follow-up batch are
harmless with it gone). Compiled clean, gameplay lint clean.

## Round 6: raising the exit only blocked a *plain jump*, not a solo rocket

User's next message: "The last jump (rl + gl) can still easily be skipped
because it's still a pit." Round 5's combo-exit fix (raise the exit 100
above the approach) used the same margin (66.6, jump apex + step-up) that
correctly closes every *plain-jump* skip elsewhere in the course — but the
combo shaft's whole point is forcing a technique that's stronger than any
single weapon, and a **lone rocket jump reaches up to 381 units**, dwarfing
the 100-unit gap the exit's raise actually created. A player could just fire
one rocket from the approach and land on the exit directly, skipping the
pit, the grenade, and the timing-critical combo entirely — round 5 closed
the easy skip and left a slightly-harder-but-still-trivial one standing.

Fixed by re-deriving the exit height against the *right* threshold this
time: exit must clear approach + 381 (max single-weapon rise) with real
margin, while `exit − required_combo_rise` must still land below the
approach (so it's a genuine pit, not an inverted platform). With the
combo's originally-chosen rise (420) this window is only 39 units wide
(707–746) — enough to close the skip but leaving either an uncomfortably
thin margin over 381 or a barely-there pit depth, not both. Round 1's own
combo-timing table showed the technique can clear far more than 420 (peak
826 at the optimal tick) — chosen back then only because it was comfortably
inside the timing window for the smaller target. **Raised the required
combo rise to 500** instead of stretching the geometry to fit 420: exit 326
(approach, unchanged) + 424 = 750 (43-unit margin over the 381 solo-rocket
ceiling), bottom = 750 − 500 = 250 (a real 76-unit-deep pit, not a
16-unit step). This also re-derives the timing window: interpolating round
1's own measured table (443 at tick 290, 626 at tick 300, cliff at 314) puts
the ≥500 threshold around tick 293–294, giving roughly ticks 293–313 (~160ms)
of forgiving window — narrower than 420's original ~210ms+, but still real.
**Flagged for playtest, not harness-verified** — round 1's table was
measured for a 420 target; the 500 threshold is interpolated from that same
table's curve, not independently re-measured. If it feels too tight in
practice, re-run the scratch-harness sweep rather than guess again.

Raising the exit to 750 also revisited round 5's H-top→finish overhang —
and then, next round, removed it entirely (see round 7's correction below).
The short version: the overhang was never a safe way to close that skip,
because it sat in the same airspace as the *legitimate* OB3 fall, and a
static ceiling can't tell the two apart.

Process note: unlike rounds 4–5's big batches, this one only touched
brushes and existing entities (no new entities), and the first-pass
`map_gameplay_lint` still caught two embedded lights (E68, E69) — they sat
at the exact z where the new, lower overhang now begins. Same lesson as
round 5, worth repeating because it recurred: **any batch that changes an
absolute height needs a check of every entity in the affected x-range, not
just the ones already in the plan** — lights are the recurring blind spot.

## Round 5: the U-shape bug was systemic, not just pit 1/pit 2

User's next message: "I can still skip most of the rocket jumps because these
are U shaped. there's a platform A, a pit, and a platform B, but A and B are
at the same height." Round 4 fixed pit 1 and pit 2 specifically but never
audited the *rest* of the course for the same shape. Advisor caught this
before any building started this round — asked for a systematic audit instead
of patching the one instance already found. The rule, derived from this
project's own numbers: **across any horizontal gap, a landing platform is
reachable from a takeoff platform iff `landing_top ≤ takeoff_top + 66.6`**
(48.6 jump apex + 18 step-up margin — see `physics-for-map-authors.md`
section 3). Horizontal distance never gates a jump in this engine (uncapped
strafe-jump speed), so *only* height comparison is a real guarantee — the
same lesson round 4 already learned for pit 1/2, just not yet generalized.

Auditing every takeoff-edge → landing-top pair in the course found four real
issues beyond the one the user had already found by hand:

1. **Grenade-ledge was skippable by a plain jump, no grenade needed.**
   Rise was 64; a plain running jump's apex from the −60 approach reaches
   −11.4, and 64's top (4) was only 15.4 above that — under the 18-unit
   step-up threshold, so the engine's own auto-climb defeated the "obstacle"
   with zero technique. Raised to 72 (top 12): deficit becomes 23.4 (clears
   the step-up threshold with margin) while staying under the measured
   78-unit grenade-jump-technique ceiling (`grenade-jump-technique.md`) with
   6 units to spare.
2. **The whole OB2→RJ chain was skippable, the worst instance:** the
   grenade-ledge stripe (top 4) to `ob2-rj-wall`'s own top (−13, *downhill*)
   was only 168 units apart — trivially cleared by a **base-speed** running
   jump (230-unit range at 320ups), no strafejump needed. This one required
   no execution skill at all to abuse, unlike every other skip on this list.
   Fixed by shrinking OB2's drop from 217 to 150 (still a table value) so its
   landing sits higher, and raising `ob2-rj-wall`'s own rise from 200 to 250
   so its top (112) clears the grenade-stripe takeoff (12) by 100.
3. **wall1 → wall2, the one the user had already found:** tops were 207 and
   242 — only 35 apart, well inside jump range across the breather-OB gap.
   Fixed by increasing wall2's rise from 280 to 345 (top now 100 above
   wall1's).
4. **H's top → finish, a momentum-glide skip the "raise B" rule can't fix**
   (finish is *supposed* to be far below H — that's the point of OB3). A
   player who jumps off H's edge with enough carried horizontal speed can
   glide the entire 800-unit span to the finish platform, skipping OB3's
   landing and the whole combo shaft. Estimated (not harness-measured) using
   the fall kinematics already established for this project (effective
   gravity 750): a jump off the edge adds ~1.33s of airtime, clearing the
   gap at roughly 600ups — attainable mid-run. Since this is a downhill
   skip, no takeoff/landing height fix applies. Mitigated with a **low
   overhang** — a new ceiling brush spanning x5050–5450 at z782 (only 50
   above H's own top) — that caps how much extra height a jump off the edge
   can add, pushing the glide trajectory back toward a plain-walk-off's
   shorter, gap-safe range. **This one is flagged for human playtest
   verification**, same standing as the combo-timing table in the section
   below: derived from the project's constants, not confirmed with a scratch
   harness the way the grenade/rocket numbers were.

Every fix downstream of #1 and #2 raises the baseline height of everything
after it (grenade-ledge's approach feeds OB2, which feeds `ob2-rj-wall`,
which feeds wall1, and so on) — the course's peak (H's top) moved from 542
to 732 as a result. This pushed the shell's inner ceiling past its old 668,
so the shell itself was extended: sky brush and the four boundary walls now
top out at 950 (was 700), giving H's jump (peak ≈ approach + 400ish, checked
against the same head-peak-delta the round-4 ceiling check used) 218 units
of clearance instead of running the risk of clipping. Raising the shell is
cheap and was the right lever here — compressing every wall's rise to fit
the *old* ceiling would have meant trading real obstacle difficulty for
headroom, backwards priorities.

**Accepted, not fixed:** the very first jump, start-stripe (top 0) to
rocket-ledge's top (−60), is a 1000-unit gap — technically closeable at
~1390ups, deep into strafe-jump-chain territory. Fixing it would mean either
inflating rocket-ledge's rise far past "first, easiest RJ in the course," or
some other structural change disproportionate to how reachable this specific
skip actually is for anyone but an expert speedrunner. Given this project's
own stated ethos (uncapped strafe-jump speed is the *named mechanic*, not a
bug to eliminate), an expert-only sequence break at the very first obstacle
is treated as acceptable, matching how advanced players are expected to find
skips in real Quake movement maps. Revisit only if a real playtest finds it
trivial rather than extreme.

A second gap joins this one as of round 7: a rocket-assisted jump off H's
own edge can, in principle, still clear the 800-unit span to the finish
(~1240ups plain, ~740ups with a rocket) — see round 7 for why this is left
as a geometry-free accepted skip rather than another ceiling attempt. Same
disposition, same standing: expert-tier, not beginner-reachable, revisit
only on contrary playtest evidence.

Process note, reinforcing round 4's lesson rather than introducing a new
one: this round's batch deleted 38 brushes and created 39 (including 5
shell-brush resizes and a new ceiling) but **zero entities** — brush
deletion+creation was already proven safe from round 4's corrective batch,
so the large scale of this one carried none of the entity-reindexing risk.
One thing this round *did* miss on the first pass: five `light` entities and
the `gate_end` `target_stopTimer` had hardcoded z-heights tuned for the old
(lower) geometry, and after raising everything they ended up embedded inside
the new, taller solid brushes — caught immediately by
`map_gameplay_lint`'s `entity-in-solid` check, fixed with one small
follow-up batch. Lesson: when a batch changes absolute heights across many
zones, grep for *every* entity with a hardcoded z-coordinate in the affected
x-range, not just the ones the plan already had in mind — lights are easy to
forget precisely because they're cosmetic.

## Round 4 follow-up: walls were solid but invisible

User's next message, immediately after round 4: "It's a lot better but all
the vertical walls are now invisible clip zones so that kind of sucks." Real
bug, and it predated round 4 — every wall-shaped brush in the course (round
1's rocket-ledge and grenade-ledge walls included) had its **side faces**
textured `common/caulk` (the compiler's no-draw texture), leaving only the
top (walkable surface) and bottom (buried in bedrock) with real textures. One
brush had gotten it right by hand early on (`grenade`'s small shelf, `E0:B9`)
with `base_floor/clangdark` on its sides — that's what exposed the pattern:
comparing a working brush against a broken one instead of guessing at a fix.

Confirmed by reading face-level texture assignments directly
(`map_inspect` on `E0:Bxx:F0`-`F5`) rather than the brush-level `textures`
summary, which only lists the *set* of textures used and doesn't say which
face has which. `create_box`'s face order is consistent across every brush
checked: F0/F1 = ±X (direction of travel — never actually seen, since the
course's camera looks along Y, not X), F2/F3 = ±Y (the faces facing the fixed
side camera — these are what "a wall" visually reads as), F4/F5 = top/bottom.

Fixed with one `edit_faces` batch retexturing F0–F3 to `base_floor/clangdark`
across every course-geometry brush (23 of them, `E0:B6`–`E0:B31` minus the
two genuine `common/clip` corridor-clip brushes and the one brush that was
already correct) — a single non-destructive face edit, no brush
delete/recreate, so none of the entity-reindexing risk from the round-4
batch applied here. `map_gameplay_lint` stayed clean; `map_geometry_lint`'s
warning count and content were unchanged (same coplanar-overlap set as
before, expected).

## Round 3: solid ground under every rocket-jump wall, more health, a bottom-of-world net

Round 2 fixed skippability by raising pit exits, but every raised platform (and
every RJ wall) was still built as a **thin 32-unit slab floating in open air**,
resting on nothing until the shell's caulk floor at z=-900. That was assumed safe
("the shell is the backstop") but the assumption was wrong: `respawn()`'s void
check adds a 1024-unit margin *beyond* world bounds before it fires, and the shell
floor sits comfortably inside that margin — so landing on it is not a void-out, it
is a silent, permanent softlock. A rocket jump that undershoots and drifts past a
thin platform's edge had nothing to catch it.

Fixed two ways, matching the standard Quake pattern (`respawn.ts`'s own comment:
"Quake maps put a `trigger_hurt` at the bottom of the world and rely on it"):

1. **Prevention.** Every RJ wall and raised pit-exit platform (`rocket-ledge`,
   `grenade`, `ob2-rj-wall`, `pit1`'s exit, `pit2`'s exit, `rj-ob`'s wall+stripe,
   `finish`'s exit) was rebuilt with its bottom extended to z=-900 — a solid
   column all the way to bedrock instead of a floating slab. This is also the
   direct answer to "when there's a rocket jump, a wall in front would make
   sense": every mandatory RJ now has an actual full-height wall face, not a
   platform that happens to be reachable only by rocket.
2. **Cure, as a last resort.** A `trigger_hurt` (`dmg 100`, fires every frame)
   spans the full level footprint just above z=-900. Anything that still reaches
   true bottom dies in one frame, which *does* route through the `'dead'` respawn
   path — so a softlock this map's own geometry didn't anticipate is still
   recoverable, just at the cost of a trip back to the start.

Also, more generous health: two more `item_health_mega` added (pit 2's exit
platform, the combo shaft's approach), for three total across the course instead
of one. Items respawn (35s), so each is available on repeat attempts, not just
the first pass.

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
| 2600..2700 | -60→12 | grenade-ledge wall, **72 rise** (raised from 64 — was auto-step-up skippable) |
| 2700..2882 | 12 | run-up + achtung stripe (raised from 4) |
| 2882..3050 | -138 | OB #2 landing, stub (**150 drop**, shallower than the old 217 — keeps `ob2-rj-wall`'s rise reasonable while still clearing the anti-skip margin below) |
| 3050..3250 | -138→112 | new wall, **250 rise** (up from 200) — step 2 of the OB→RJ chain (mandatory); top is 100 above the grenade-stripe takeoff, closing the course's worst skip (a 168-unit *downhill* plain jump that needed no strafejumping at all) |
| 3250..3610 | 112→332 | **wall 1** (was pit 1), 220 rise, flush — no gap to jump (mandatory) |
| 3610..3882 | 332 | run-up + achtung stripe |
| 3882..4050 | 87 | **breather OB drop** (245 units, verified table value) |
| 4050..4210 | 87 | approach to wall 2 |
| 4210..4450 | 87→432 | **wall 2** (was pit 2), **345 rise** (up from 280 — top is 100 above wall 1's top, closing the wall1→wall2 skip the user found) |
| 4450..4650 | 432 | approach to the RJ wall |
| 4650..5050 | 432→732 | RJ wall (H), 300 rise + achtung stripe |
| 5050..5650 | 326 | OB #3 landing + combo shaft approach — grenade/rocket ammo, health top-up. The H-top→finish glide skip is closed by geometry, not a ceiling (round 7): finish (750) sits above H's own top (732), so no plain glide can reach it |
| 5650..5850 | 750 (exit), 250 (bottom) | combo shaft — exit is approach+424 (43 units past the 381-unit solo-rocket ceiling, round 6); **500 rise required** (up from 420) so a lone rocket can't reach the exit either — rescue teleporter on the back wall |
| 5850..6500 | 750 | exit + finish |

OB drop heights (260, 217→**150**, 406, 245) are exact entries in the
verified ob-heights table (`npm run ob-heights`). Non-OB traversal heights
(walls, wall raises) don't need table membership, only margin under the
measured rise numbers and — as of round 5 — margin over whatever takeoff
platform precedes them across a gap. The course now climbs continuously from
the grenade-ledge wall (−60) through H's top (732), a net 792-unit ascent;
the shell was extended to z950 to keep clearing it.

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
