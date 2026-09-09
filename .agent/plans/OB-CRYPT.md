# ob_crypt: pads, strafe gaps, two overbounces, two rocket walls, a scripted camera

Status: round 1 built, compiled clean (no leak, full VIS/LIGHT) and verified headlessly (2026-09-09). Third bundled course, built in q3edit from
scratch against `.agent/docs/physics-for-map-authors.md`. Every height below
was chosen from that document's numbers first and checked headlessly after
compiling (see "Verification"), not eyeballed.

The request, verbatim: strafe pads, rocket jumps, visual variety (not the
`base_floor/clang*` set the two existing tutorials share), overbounces, and use
of the camera scripting (`scripts/<map>.cam`).

**"Strafe pads" is ambiguous** and is read here as *both* things it can mean:
a chain of three jump pads (`trigger_push`) that climbs 512 units, feeding a
sequence of three strafe-jump gaps that grow past the 230-unit range a 320ups
plain jump has. A player who cannot keep pad speed alive with an immediate
jump, or cannot strafe, falls into lava and is teleported back to the section
start.

## Look

Gothic crypt over lava, night sky. Everything is OpenArena art fetched from
`openarena.ws/svn/textures/` through `tools/assets.manifest.json` -- the editor
merges retail `pak0.pk3` with OA archives, so an editor preview proves nothing
about redistributability; only the SVN listing does, and every name below was
checked against it.

| role | material |
| --- | --- |
| walkable tops | `gothic_floor/largerblock3b3` |
| platform sides | `gothic_block/blocks18c` |
| rocket walls | `gothic_block/blocks15` (red -- "this face is for rockets") |
| overbounce landing tiles | `gothic_light/pentagram_light1_3k` (glows: it is the spot) |
| stub / shaft floors | `gothic_floor/metalbridge06` |
| shaft walls | `gothic_wall/iron01_e` |
| low gates (speed caps) | `gothic_trim/pitted_rust3` |
| jump pads | `sfx/bouncepad01_block17` (static image at runtime; the OA shader wants `clown/circ4glow`, not bundled) |
| backdrop wall | `gothic_block/blocks11b`; end walls `gothic_wall/streetbricks10` |
| columns | `gothic_trim/metalsupport4b` |
| light panels | `gothic_light/ironcrosslt2_5000` via OA's `scripts/oalite.shader` (`_blend` image bundled too) |
| lava | `liquids/lavahell_simple` via OA's `scripts/liquid_lavas.shader` (never retail `liquid.shader`) |
| sky | `skies/nitesky` (`stars` + `nitesky` images) |

Lighting risk, noted before building: `nitesky` is surfacelight 20 with the sun
at pitch 90, against 400 for the sky the other courses use. The faces the side
camera looks at are vertical and get nothing from that sun, so the course is
lit by point lights every ~600 units plus the emissive panels on the backdrop.

## Layout (x increases rightward; y locked to 0; z_top = walking surface)

Shell: x -512..8320, y -320..320, z -320..1472; lava sheet at z -256..-200
across the whole footprint; sky at 1408. Clip corridor at y +-(128..160).

| x range | z_top | what |
| --- | --- | --- |
| -448..512 | 0 | start, spawn (-224,0,40), timer gate at x128 |
| 512..640 | 8 | **pad 1** -> P1 |
| 1152..1536 | 128 | P1, **pad 2** on its last 128 |
| 2048..2432 | 320 | P2, **pad 3** on its last 128 |
| 2944..3328 | 512 | P3, checkpoint 1, strafe hint |
| 3568..3760 | 512 | P4 (gap 240 -> needs ~333ups) |
| 4032..4224 | 512 | P5 (gap 272 -> ~378ups) |
| 4528..5104 | 512 | P6 (gap 304 -> ~422ups); **low gate** over 4992..5104 (ceiling 576) |
| 5104..5120 | 512 | iron liner: the shaft's near wall face |
| 5120..5376 | 0 | **iron shaft**, drop 512 (table value), width 256 |
| 5376..5392 | 416 | iron liner: the far wall, top 96 below the takeoff |
| 5392..5824 | 416 | exit ledge: RL, rockets, megahealth, checkpoint 2 |
| 5824..6208 | 676 | **rocket wall 1**, rise 260; health + rockets on top |
| 6208..6592 | 896 | **rocket wall 2**, rise 220; checkpoint 3; **low gate** over 6464..6592 (ceiling 960) |
| 6784..7168 | 319 | **final overbounce stub**, drop 577 (table value); pentagram at 6912..7040 |
| 7520..8256 | 219 | finish (gap 352, 100 lower), stop timer at x7800 |

### Why each number

- **Pads.** `map_analyze_jump_pad` reproduces `AimAtTarget` at g=800; the
  simulation's effective gravity is 750 (snapped integer velocities), so real
  flights go higher and longer. Landing platforms are 384 long to absorb that.
  A pad *sets* velocity, so "press jump as you land" is the only way its speed
  survives -- same lesson `ob_basics` teaches.
- **Strafe gaps** cannot be gated by width (uncapped strafe speed), only by
  being wider than 230. They are the *intended* strafe section, so that is the
  point. Anti-skip rule applied everywhere else: across any gap a landing is
  reachable iff `landing_top <= takeoff_top + 66.6`. Every climb here is >= 128.
- **Iron shaft (vertical overbounce).** The vertical launch needs exactly 0
  horizontal speed, which only a wall guarantees: `PM_ClipVelocity` leaves
  `-0.1`, `SnapVector` rounds it to 0. Width 256 at <= 320ups is reached after
  0.8s of a 1.17s fall. The 64-high gate over the approach pins ground speed at
  320 (friction collapses anything faster within ~40 units) and makes jumping
  impossible, so a walk-off cannot glide the 256 to the far ledge: airtime to
  fall the 96 to ledge height is 0.51s = 162 units, and the feet are at 272
  when they reach the far wall, far under the 398 that the 18-unit step-up
  would need. Energy in equals energy out, so the bounce peaks around the
  takeoff height (512 above the floor) and the exit ledge sits 96 below that.
  The pentagram is the last 128 of floor -- where a 320ups walk-off lands.
  Hint: run off, *release*, touch nothing; holding forward re-accelerates into
  the wall and turns it into a horizontal bounce.
- **Rocket walls** 260 and 220 are inside the 180..360 band that needs the
  real jump+fire and cannot be done standing (166). No rocket launcher exists
  before the shaft, so the shaft cannot be rocket-skipped. Under `lock y 0` a
  health pack cannot sit "off the running line", so the reserve is respawning
  items: megahealth on the ledge, a large health on wall 1's top.
- **Final overbounce (horizontal).** From wall 2's gate the player leaves at
  <= 320 with no vertical speed, falls 577 in 1.24s and lands 397 out -- inside
  the 6784..7168 stub. The landing flattens fall speed into ~800ups horizontal;
  ground friction eats 4.8% per frame, so the jump has to come on the frames
  right after landing (pressing *on* the landing frame lets `PM_CheckJump`
  overwrite the fall velocity and there is no bounce). Gap 352 with the finish
  100 lower needs ~356ups after a jump, giving roughly 17 frames of window; a
  non-overbounce 320ups jump reaches 317 and falls short. A glide from the gate
  needs 928 units and gets 397.
- **Rescue.** Every pit is a `trigger_teleport` slab 40 above the lava, back to
  the section's approach. The shaft has a strip on its near side (walk left to
  retry) -- reached along x, since y is locked.

## Camera (`scripts/ob_crypt.cam`)

- default: `side`, distance 520, height 110, `lock y 0`.
- `rail` over the pad climb (x 512..3328): the eye pulls back and rises with
  the course so the whole three-pad ascent stays in frame.
- `fixed` in the shaft (x 5104..5392): eye pinned mid-shaft, no follow, so the
  camera holds still and tilts to watch the fall and the bounce back up.
- `side` at distance 760, height 40, over the final overbounce (x 6592..7520) so the stub
  and the finish are both on screen for the jump.

## Files and integration

`maps/ob_crypt.map` / `.bsp` / `.aas`, `public/maps/ob_crypt.bsp`,
`public/ob_crypt.pk3` (`npm run build-oapak`, now per-course image lists with a
BSP shader-lump cross-check), `scripts/ob_crypt.cam`, manifest entries for
every new image, `BUNDLED_MAPS` (`src/main.ts`), `BUNDLED_PAKS`
(`course-select.ts`), deploy workflow copy step, README, `docs/url-parameters.md`.

## Verification (round 1 results)

`npm run course-check` (`tools/course-check.ts`, kept, not a scratch file)
replays every obstacle headlessly against the compiled BSP through the full
`Game` with the y-lock, and parses the `.cam`. All 22 checks pass:

- **Pads**: all three fire, the player reaches P3 at feet 512.125 whether they
  jump on every landing or never jump. Landings at g=800 per the analyzer
  were 1306 / 2160 / 3056; the simulation's g=750 lands later and the
  384-long platforms absorb it, as planned.
- **Strafe gap 1**: a plain 320ups jump from P3's edge falls in the lava and is
  teleported to x 2990 on P3.
- **Iron shaft**: leaves the edge at x 5136 under the gate, reaches the far
  wall at x 5360.9 after 145 frames, horizontal speed exactly 0 on the landing
  frame, launches at **vz 876** (= sqrt(1500 * 512)) on the next frame, apex
  feet 511.7, comes to rest on the exit ledge at x 5555 / feet 416.3 with
  forward held from the launch on. The gate-capped walk-off with forward held
  the whole way lands on the shaft floor, never the ledge.
- **Final overbounce**: the walk-off lands on the stub at x 7005 / feet 319.3
  and bounces to **936ups**. Jumping N frames after landing reaches the finish
  for **N = 1..17** (a 136ms window); N = 0 gets no bounce, as the physics
  predicts (`PM_CheckJump` runs before the clip on the landing frame); N = 18
  at 406ups lands 8 short.

- **Rocket wall 1**: from the ledge with the launcher, forward held into the
  wall, jump then fire straight down the next frame rises 369 and comes to
  rest on top (feet 676.125, health 200 -> 152); the standing shot alone rises
  166 and stays on the ledge. Both match the doc's 381 / 166 figures. Wall 2
  (rise 220) is dimensioned from the same numbers, not separately replayed.

Two observations worth keeping (also recorded in
`physics-for-map-authors.md` and `.agent/docs/side-view-lighting.md`):

- physics-for-map-authors.md quotes a 0.125..0.25 landing window; both drops
  here land with feet at ~0.31 and still bounce at full magnitude. The launch
  on the following frame is the thing to assert, not the landing height.
- Pressing jump ON the landing frame is the one way to lose a guaranteed
  overbounce, so the final hint says "the instant you land, jump" rather than
  "hold jump".

Rendered in the real game with `npm run shot` (devpak `ob_crypt.pk3`, side
camera) at the start, the pad climb (rail zone), the shaft (fixed zone), the
ledge and the final (wide zone): no console errors, every texture resolves, the
pentagram and iron-cross panels glow through the copied OA shaders, the lava
lights the pit walls from below. First pass had every camera-facing (-Y)
platform face black -- all 18 point lights sat over the platforms at y=0 --
fixed with a second row of 15 lights at y=-224 in front of the course, sitting 64 BELOW each platform top so they shine at the faces rather than over them (the first placement, 120 above the tops, still left the start floor's face dark).
`map_play` screenshots are known to stay black (OB-ROCKETS) and were not used.

## Things the build surfaced

- **The pak cross-check is not optional.** The compiler canonicalizes a
  texture name to the spelling in ITS shader list (retail's
  `gothic_light.shader` says `pentagram_light1_3K`), so the BSP referenced a
  name that differs from OpenArena's lowercase file by case. Harmless at
  runtime (`shaderKey` and `pk3.ts` lowercase everything, as Quake's
  `Q_stricmp` does) and the check compares case-insensitively for that
  reason. `q3map_flare` directives also write `flareShader` and `flares/lava`
  into the lump; the renderer draws no flares, so those are exempt.
- **`map_capabilities` reported `compiler.available: false`** while
  `map_compile` worked fine. Try the compile before believing the flag.
- **Shader scripts apply to every mounted course by name.** Copy the exact
  definitions a map needs into `scripts/<map>.shader` -- generated by
  `npm run extract-oa-shaders` (`tools/extract-oa-shaders.ts`, brace-matching
  copies out of oa-pak0) -- instead of bundling a whole OA script.
- `create_box` with `parent: "@entityId"` is how a trigger brush is attached
  to a `trigger_multiple` created earlier in the same batch; `create_jump_pad`
  and `create_teleporter` are batch operations too (the whole entity layer went
  in one 74-operation batch, no deletes, symbolic ids only).
