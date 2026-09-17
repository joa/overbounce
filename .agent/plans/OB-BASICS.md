# ob_basics: the tutorial course -- rounds after the original build

Status: one round of playtest fixes built, lit and verified (2026-09-17, the
pad's projection corrected the same day after a second playtest):
the strafe rescue restarts the run from the spawn, the lid over the plasma
and overbounce section has a drawn top, the first launch pad wears
OpenArena's pulsing pad shader. The original build predates the per-course
plans (its design is in `INITIALIZE.md` and `SIDE-CAMERA.md`); this file
starts with that round. Compiled with the user's local q3map2 (the recipe
in `q3edit-mcp-traps.md`); `tools/course-checks/ob_basics.ts` is new and
deliberately small.

## Round 1 (2026-09-17): restart, the lid's top, the pad

The user, verbatim:

> "Same issue with ob_basics: the first strafe islands rescue teleporters
> should teleport back to the spawn. Also, after the plasma climb is an
> obstacle, that prevents the player from jumping. I like that *but* it also
> invites people to skip it (that's good!). The top however does not render
> properly. Also, can we use a different texture on the first jump pad? It
> does not read as a jump pad visually"

### Layout, as found (maps/ob_basics.map; x rightward, y locked to 0)

| x range | z_top | what |
| --- | --- | --- |
| -384..1600 | 0 | the start floor; spawn (-224, 0, 40); start gate x 128..144; the launch pad `trigger_push` x 768..896, z 0..24, aimed at (1200, 0, 144) |
| 1600..1856, 1984..2240, 2416..2672, 2896..3152 | 0 | four strafe islands (gaps 128, 176, 224, 256), a pit floor at -384 under them |
| 3408..4032 | 0 | the rocket floor; a 240 wall up to |
| 4032..4672 | 240 | the rocket-jump ledge; then a 100 wall up to |
| 4672..5600 | 340 | the plasma-climb floor |
| 4928..5992 | lid z 420..492 | **the lid**: 80 over the 340 floor, 64 over the 356 step -- a walk, not a jump, is the way under it |
| 5600..5736 | 356 | the 16 step (achtung stripes), then the block x 5736..5800 up to 356: the walk-off at 5800, a 260 drop |
| 5736..5992 | 96 | the lower floor; the retry passage under the block (x 5736..5800, z 96..176) -> (4860, 0, 368) |
| 5992..6720 | 304 | the finish; stop gate x 6560..6576 |

### What changed, and why

- **The strafe rescue restarts the run.** `tp_strafe` (four slabs under the
  gaps) sent the player to x 620, past the start gate at 128, with the clock
  running -- the same complaint as `ob_strafes` round 5. Its destination is
  now the spawn (-224, 0, 40); the teleport exit's 400 ups carries the player
  through the gate and `target_startTimer` resets the clock
  (`Course.startTimer`, unconditional). The rule is in
  `side-locked-courses.md`.
- **The four slabs are lower.** They filled the pit from -384 up to -16,
  16 under the island tops; the void-catch rule wants 64 after the 18
  step-up. Their tops are at -96 now (margin 78); the pit floor at -384 is
  the surface they protect.
- **The lid's top was caulk.** From the side camera (height 110) the eye is
  under the lid's top (492) while walking, but a jump on the 340 floor right
  after the plasma climb (the lid starts 256 later) lifts the eye to ~522, and
  the caulk top showed as a hole. It is `base_floor/clangdark` like the other
  five faces now. The lid itself stays: the user likes that it stops jumps
  there and that it invites skipping the section.
- **The pad wears `sfx/diamond2cjumppad`** (the pulsing OpenArena pad
  `ob_yard` uses; both stage images, `bouncepad01_diamond2cTGA.jpg` and
  `clown/circ4glow.tga`, were already in the manifest) on its top face,
  one full image over the 128x192 top, the hazard stripes kept on its sides
  -- the same top-only convention as the yard's pads. The first cut used the
  editor's `fit`, which sizes this shader as a 128-px image; the compiler
  bakes from the real 256, and the playtest saw a quarter of the pad. The
  projection is set explicitly now (scale 0.5 / 0.75, shift 0 / 128; the
  rule is in `q3edit-mcp-traps.md`), confirmed in a shot. The trigger brush itself is
  untouched (its size sets the launch: `AimAtTarget` works from the brush's
  centre, so extending it would have moved the landing). The definition is
  extracted into `scripts/ob_basics.shader` (`extract-oa-shaders`), the pak
  kit is `BASICS_KIT` (the clang kit plus the two images and the script);
  `ob_rockets` stays on `CLANG_KIT`. NOTICE lists the script.
- **The levelshot** is the side view before the pad now (the old one was a
  perspective photo with the striped pad in the foreground).

### Verification

Compiled locally (BSP, VIS, LIGHT under a second each, no leak), the three
caches refreshed, `npm run course-check maps/ob_basics.bsp`: all passed.

| check | result |
| --- | --- |
| the pad from the start floor | lands on island 1 (apex 162, down at x 1600: the near edge, as built) |
| the strafe rescue | a fall between the islands lands at x -224, before the gate; the next `start` fires with elapsed 0 |
| void catches | the four strafe slabs 78 under the island tops after the step-up; the passage under the ledge block is a visible return, exempt |
| the lid | one brush at x 4928..5992 z 420..492, all six sides drawn |
| timers, `.cam` | both gates fire; `lock y 0`, the default block only |

Shots on the dev server (`shots/basics-{before,after}-*.png`, gitignored):
`before-lid` / `after-lidtop` (the lid's top drawn from above), `before-pad`
/ `after-pad` / `after-padstand` (the pad image on the top, stripes on the
sides). Left for the playtest: whether the pad reads well enough from the
side camera's grazing angle -- the front face is what the camera sees most,
and it still carries the stripes; the shader on all faces is one edit if not.
