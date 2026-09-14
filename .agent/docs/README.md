# `.agent/docs/` — an index

Findings, gotchas and write-ups: everything a session would otherwise have to
"remember". Plans live next door in `.agent/plans/`; a plan says what is going
to be done, a doc here says what was *learned*, usually the expensive way.

This is an index and nothing more — one line per file, enough to tell whether
it answers the question you have. **Read the file, not the line.** Nearly every
entry here was written because a session spent hours deriving something that is
now one paragraph, so the cheapest move when starting work in an unfamiliar
corner is to scan this list first.

**Adding a doc? Add its line here in the same commit.** An index nobody updates
is worse than no index, because it reads as complete. (Written 2026-09-11 against the
34 documents committed at that point — all 34 are listed below — when finding the right
one had stopped being obvious. Anything added since should have a line; if it does not,
that is the bug, and `ls .agent/docs/` is the check.)

## Fidelity: physics, weapons and the Q3 quirks

| file | what it settles |
| --- | --- |
| `physics-for-map-authors.md` | The measured numbers a course is built against — jump heights, gaps, rocket-jump distances, pad+rocket timing. All from headless runs of this repo's own simulation, not from Quake lore. |
| `grenade-jump-technique.md` | Grenade jumps are inverted from rocket jumps — the useful technique is the opposite one, and the measurements that show it. |
| `snapvector-macro-vs-trap.md` | `SnapVector` is **two different functions** in id's source, and which one a call site gets changes the result. Found by review, not by the tests — a test comparing the port to itself could never have caught it. |
| `cpma-constants.md` | Every CPM constant, with the bytecode address it was read from in CPMA 1.53's shipped `.qvm`. Read this before changing any number in `cpm.ts`. |
| `cpm-ramp-double-jump.md` | CPM's ramp jump and 400 ms double jump — and the corrections the bytecode forced on what had been taken from Warsow. |
| `frozen-view-is-death.md` | "The mouse freezes after a while" was not an input bug. It was death. |
| `item-count-key.md` | Items drop the entity's `count` and `wait` keys — why `mega_rl` handed out the wrong number of rockets. |
| `bullet-flash-rate.md` | The machine gun impact looks slow because retail Quake III's `bulletExplosion` IS 4 frames at 5 fps, and its 600ms life only gets through 3 of them. Read before "fixing" it again. The bug that hid it: one pak's rate and frame paths hardcoded, so every player got OpenArena's animation over their own art -- invisible to every test here, since only OA content is committed. Also what governs the perceived speed (the fraction of the animation that fits the 600ms, not the rate), and the two ways to print it instead of guessing. |
| `haste-and-pickup-feedback.md` | Three game-layer bugs with one shape: the simulation was right and the thing the *player perceives* was missing, so no physics test could fail. |
| `sum-of-best.md` | What a split is, why sum-of-best is a shortest-path problem, and the invariant that keeps it honest. |
| `flag-run.md` | CTF maps are timed by their FLAGS: take either, reach the other, that is the run. It drives the ordinary `Course` timer so records and results need no idea it exists. The trap: `ItemWorld` fires every tick the boxes overlap, so without a rising edge the tick after a capture starts a new run. Also the three pieces of `g_items.c` that make a flag a gate rather than a pickup, and what q3ctf1/q3ctf2 stop being. |

## Collision, maps and course authoring

| file | what it settles |
| --- | --- |
| `side-locked-courses.md` | The renderer always showed courses from the side; the physics is full 3D. What it takes to build a course that actually earns the side camera. |
| `side-view-lighting.md` | On a side-view course the faces the camera sees get no light by default. Found building `ob_crypt`. |
| `fog-on-a-course.md` | A `fogParms` brush on a side-view course (`ob_grounds`): the pipeline (extract, compile, pak check, `fog-probe`) works unchanged; build the volume as a filled pit with one visible side; the player stays readable while the camera's eye is above the fog's top plane, and the analytic path hides them once it drops below. Also: the shell must enclose the camera, and `--devpak pak0.pk3,<course>.pk3` for shots with a player model. Making it read: the volumetric path draws the fog's bounding box (reach it toward the camera), the analytic path shows a dark basin, faces inside the volume render dark, a parapet up to the fog top hides it, lint flags lights inside the brush, and how to pin the player mid-fall for a shot. |
| `q3edit-mcp-traps.md` | q3edit MCP calls that fail on the first try: `label` is required, `delete` takes `targets`, a compile's `artifactPath` directory must exist, and how to take a HUD-free levelshot with `npm run shot -- --eval`. |
| `movers.md` | `func_door` and `func_button`: what was ported from `g_mover.c`, and three behaviours that look like bugs and are not. |
| `target-print.md` | `SP_target_print`, plus the **stale-BSP trap** — a map's `.bsp` is cached in three places and all three must move together. Also: an emoji at the **end** of a `message` is dropped by the compile; put it first. |
| `bundled-defrag-maps.md` | Why `de4th_run1`, `de4th_run2` and `acc_fuzzle` can ship (GPLv3, attributable author) when other community maps cannot — and the licensing consequence for the build as a whole. |
| `patch-normals-and-deforms.md` | Why q3dm4's arches tore themselves open: patch normals and `deformVertexes`. |

## Rendering

| file | what it settles |
| --- | --- |
| `render-gotchas.md` | The standing list, starting with Quake's triangle winding being backwards relative to three.js. Check here first for anything that draws wrong. |
| `post-processing.md` | The post chain: what each stage costs, and what nearly went wrong building SSAO, tone mapping and chromatic aberration. |
| `post-chain-drift.md` | Changing the post chain after the world has drawn makes a still frame drift. **Unresolved** — bracketed to a regime, not explained. |
| `ssao-translucent-fringe.md` | The black fringe around smoke puffs and translucent lights, and why SSAO produced it. |
| `shadow-maps.md` | Shadow maps steered by the light grid: what was measured, and the two hours lost to an animated texture. |
| `light-knobs.md` | Why a light URL parameter looks like it does nothing — including the pool slots, and why a backgrounded tab reports every light as dead. |
| `fancy-explosions.md` | `explosion-fx.ts`, the richer detonation layered over the classic flat burst, and how it falls back. |
| `view-weapon.md` | The first-person view weapon (`cg_weapons.c`): placement, FOV handling, and which files a pak build has to carry for it. |
| `sound-distance.md` | Distance attenuation — explosions and impacts had none, so a bolt landing across the map was as loud as one at your feet. |
| `first-use-prewarm.md` | First-use hitches and the warm-up frame that removes them. Read before adding a new pooled visual or a new render pass — both carry a first-use cost that is invisible in code review and absent from every headless gate. |
| `speed-trace-resolution.md` | The HUD speed trace's resolution bug, and the extension-tab trap that hid it. |

## UI, screens and the browser

| file | what it settles |
| --- | --- |
| `playback-screens.md` | **23 numbered traps** from wiring up the playback screens, each one a bug found the expensive way. The recurring shape: anything ported from cgame assumes a clock that only rises, and playback's does not. (Its title says five; it grew.) Trap 23 is the newest and the least obvious: a default seeded from live state pins that state forever, and it looked exactly like a bug in a different file. |
| `pointer-lock.md` | What the Pointer Lock API will and will not give back. Every line was paid for by a bug — starting with Escape never being delivered while the lock is held. |
| `browser-check-without-pointer-lock.md` | How to verify a weapon from Chrome automation when you cannot take pointer lock. |
| `dom-to-png.md` | Turning a screen into a PNG in the browser with no library. Read before touching `results-export.ts`. |
| `weapon-binds-and-autoswitch.md` | The weapon keys are Quake III's slot numbers (2/3/4/5/7/8, 1/6/9 deliberately unbound), every weapon is a real rebindable `ACTION`, and pickups auto-equip only a weapon you were **not already carrying**. The trap worth reading before touching any of it: by the time a pickup event is read the ammo is already granted, so `hasAmmo` says "carried" for the weapon just picked up — the order is compare, THEN sync, and a spawn is a sync. Also why there are now two crosshair defaults. |

## Playback and export

| file | what it settles |
| --- | --- |
| `demo-entity-events.md` | Why a demo's rocket explodes now, and the bug that only a REAL recording could find: entity numbers are recycled, so `CG_CheckEvents`'s "did the value change" test is not enough on its own. |
| `dm68-decoding.md` | Decoding `.dm_68`, and the four ways to get it silently wrong. The decoder fails as plausible nonsense, never as an error. |
| `video-export.md` | "A video export that is perfect in every respect except the pictures" — a valid file, right length, right codec, no duplicate payloads, and a near-static picture. The muxer was the first suspect and was never the problem; the entry's real value is the `ffmpeg tblend` measurement that settles whether the *decoded* frames differ, since differing payload bytes do not prove differing pictures. |
| `playback-screens.md` | Listed above under UI; it is equally a playback document. |

## Tooling, performance and assets

| file | what it settles |
| --- | --- |
| `perf-gate-findings.md` | What the performance gates can and cannot catch, measured on this tree. **Read before optimizing anything** — it lists three ways to reach a confidently wrong conclusion from a green run or a profile. |
| `own-sfx.md` | The first sounds that are **not** Quake's, and the bug adding them uncovered: **the shipped overbounce test never fired on an overbounce**, twice over — the conversion lands on grounded tick 2 and the test looked only at tick 1, *and* it watched horizontal speed, which a vertical overbounce (the one `ob_basics` teaches, and the one Q3 players mean) never moves. Also why `assets/` cannot hold a shipped asset, why a demo's overbounce has to be read from the raw snapshot pair, why "never play `fight.wav`" had to go in `SoundSystem.play` rather than rest on a convention (and how capture mode tests it headlessly), and how the weighted attempt lines pick. **§5 is the other direction of the same bug**: the watch was fed `GameFrame`'s END-of-tick velocity, which a jump pad, a teleporter, knockback or a respawn may have replaced, paired with pmove's own `onGround` — so a pad landing read as an overbounce. `pmoveSpeed`/`pmoveVelocityZ` are what it reads now; `tools/diag/ob-sting.ts` shows both readings on a real `.bsp`. |
| `asset-shopping-list.md` | Every asset path the game looks up by name, cited to `file:line`. What a mounted `.pk3` has to contain, and what the bundled kit does and does not carry. |
| `defrag-entities-spec.xml` | The official ws.q3df.org entity reference. DeFRaG is closed source, so this — not recall — is what `target_init`'s spawnflag bits are checked against. |
| `shots/` | Screenshots from render verification. Gitignored; useful on disk, useless in git. |
