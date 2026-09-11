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
install, nothing to sign into. Seven courses are built into the page; you can drop
in your own Quake III or OpenArena maps from the course list. The title screen offers
three things: run a course, watch one back, or change how it all looks.

## The movement

Three things fell out of the port rather than being tuned in, which is the best evidence
available that it is right.

**Overbounce works, and it is rare.** Land in the eighth of a unit where Quake skips its
collision clipping and you keep the whole of your falling speed. It has two faces, and
they are the same four lines of code:

- **Run into one** and the fall redirects sideways. A 312-unit drop at 100ups comes out
  at **658ups**.
- **Drop onto one** and it fires you straight back up at the speed you landed —
  **−390ups in, +390ups out**, returning you to the height you fell from. This is the one
  Q3 players mean by "an OB", and it is what gets you to places you otherwise cannot
  reach.

Because the window is an eighth of a unit wide, real overbounce spots are specific
coordinates on specific maps. The HUD tells you when you are on one, and how you would
have to arrive.

**Strafe jumping beats the speed cap.** Quake only measures your speed along the direction
you are *asking* to move, so holding an offset angle keeps the 320ups cap permanently out
of reach. Good play climbs past **1200ups** in ten seconds. The HUD draws the window you
are aiming for and where inside it you actually are.

**125fps jumps higher than 1000fps.** Velocity is snapped to whole units every frame, so
the tick rate decides how much gravity gets rounded away: 48.6 units of jump height at
125, 36.5 at 1000. Q3 players settled on `com_maxfps 125` by feel two decades ago, and
reproducing that ordering from the constants alone is what pinned down the last unknown in
the port.

## Courses

Four courses ship with the game and need nothing else installed: **ob_basics** for
movement, **ob_rockets** for rocket and grenade jumps, **ob_crypt**, a gothic run over
lava that chains three jump pads into strafe gaps, a vertical overbounce down an iron
shaft, two rocket walls and a final overbounce onto the finish, watched through a
scripted camera (`scripts/ob_crypt.cam`: an on-rails pull-back, a fixed shaft camera),
and **ob_yard**, floating slabs in a starfield in the manner of q3dm17: pads whose
flights only reach the next platform with a mid-air strafe, and pads whose flights only
reach it with a rocket fired into the pad the instant it launches you.

Three real DeFRaG maps ship alongside them — **de4th_run1** (a plasma climb), **de4th_run2**
(rocket jumps) and **acc_fuzzle** — from
[Yann39/quake3-defrag-maps](https://github.com/Yann39/quake3-defrag-maps). They started as
test fixtures and became bundled courses because their author built them himself in 2004
and licensed them GPLv3, which is the only reason they *can* ship: every other community
DeFRaG map this project touches has no published per-file licence, so those stay downloads.

Everything past that is your own. Quake III and OpenArena maps work as courses because the
entity layer is a port too, not an approximation — triggers, jump pads, teleporters, doors
and buttons behave the way the map author expected. Drop a `.pk3` onto the course list and
it appears alongside the built-in ones; your files always take precedence over the bundled
kit. Timing follows the defrag convention, so maps built for defrag time themselves
correctly.

A jump pad is the nicest example of why porting beats approximating. Quake does not launch
you at a speed in a direction — it solves for how long a body takes to *fall* from the
target's height and gives you exactly the velocity that arrives there. Which is why a
Quake jump pad lands you *on* its target rather than near it.

## Runs, records and ghosts

Every course you finish is timed and kept. The run screen afterwards shows your splits
against your personal best segment by segment, the sum of your best segments, your top and
average speed, how much of the run you spent airborne, how much of the available strafe
gain you actually took, and the whole run drawn as one speed-and-height trace with your
shots and jumps marked on it. A second tab tracks the course over time.

**Ghosts are real opponents, not animations.** A ghost is a recording of the inputs you
pressed, replayed through the same physics — so it goes exactly where you went, and races
you frame for frame. Export one and send it to someone.

Records are kept per course *and* per mode: the same map played in VQ3 and CPM, or from
the side camera and first person, holds separate personal bests, because they are
different runs. The results screen badges which one you just did.

Anything that makes it easier means no clock. Pausing costs the attempt, dying costs the
attempt, and turning off self-damage turns off the timer with it.

## Playback

Two kinds of recording play back through one viewer: Overbounce's own ghosts, and
**Quake III `.dm_68` demo files**. A ghost is re-simulated, because a ghost is its inputs.
A demo is decoded and interpolated, because a demo is a recording of what a server said —
which is what Quake III itself shows you when you watch one, and the reason a demo can
never be "improved" by re-simulating it.

The demo reader is a port of id's `msg.c`, `huffman.c` and the reading half of
`cl_parse.c`. `npm run demo-info -- <file.dm_68>` reads a demo headlessly and prints its
map, length, physics mode and player.

Ghosts share as a pasted string, because sharing happens in Discord. A run is packed
columnar, delta-coded, deflated and base64'd behind an `OBG1.` prefix — 840KB of JSON for
a 60-second run becomes 4.3KB, and a run up to about 15 seconds fits in a single Discord
message. View angles are stored as 16-bit values and that is lossless, not a compromise:
the 16-bit value is what pmove ran on in the first place. Longer runs share as a file.

**A demo needs its map.** The library drops a `.pk3` the same way course select does, and
a recording whose map isn't mounted still lists — with its map name, time and physics —
it just can't start. Your own personal bests appear there automatically.

**The default is watching, not editing.** A recording opens in the view it was made in:
fixed first person for a `.dm_68`, whichever camera a ghost was set in. Play, pause, a
scrubber, nothing else. `T` opens the timeline, and only then does the camera become
yours: free flight on your own movement binds, keyframed position, FOV, vignette and
chromatic aberration, each keyframe with an easing direction paired to a curve. Every
setting starts with a keyframe at 0:00.0 holding what it opened with, so the first key
you place is somewhere to move *to*. Scrub to a moment, fly the camera where the shot
wants it, and double-click the track to drop a keyframe there — the camera flies between
the two on the curve you picked. Drag a keyframe to retime it, double-click it to remove it. The diamonds along
the top are those same keyframes seen at a glance: click one to jump to it. In and out
markers trim what gets exported without moving the playhead.

**Rockets fly.** A projectile in the air is drawn from the recording itself — a demo
names the entity, its origin and its weapon, a ghost re-simulates the same thing, and one
renderer reads both. The model points along where the projectile has actually been
travelling, so a paused frame shows the rocket flying the way it was flying.

**A ghost is re-simulated, so it makes the noises it made.** Footsteps, jumps, landings,
the gun, the explosion, doors, jump pads — and the marks the rockets left, cleared again
if you scrub back before they happened. A demo is a recording of what a server said, so
it plays the sounds that were in it: the point of view's own footsteps, landings, jump
and shot, and nothing invented.

**Export writes a real file, frame by frame.** Not a screen recording — the renderer is
driven from a list of timestamps derived from the frame rate alone, so a slow machine
produces the same video as a fast one rather than a shorter one. Frames go through
WebCodecs into a WebM container written here (`src/render/video-export.ts`); there is no
muxer dependency.

The map is drawn as a map, not as a backdrop: its items are there, and the subject
carries the weapon they actually had — read from the recording, frame by frame, so
switching guns mid-run switches what they are seen holding.

The ghost is drawn solid here, not the translucent blue it wears when you're racing it.
Racing, it has to read as *not you*; in playback it's the subject.

## Playing it your way

**Physics and camera belong to the course.** Every course declares what it was built for —
VQ3 or CPM, and side-on, chase or first person — and you can override either from the
course list. The override is remembered for that map, not globally.

First person draws the gun in your hands, with Quake III's own walk bob, landing dip and
idle drift — `CG_AddViewWeapon`, ported rather than approximated. There is no separate
viewmodel in Quake: it is the pickup's own world model hung on `<weapon>_hand.md3`, which
is why picking a different gun up changes what you are holding. `cg_drawGun` is the
**View weapon** switch under Settings → HUD, or `?gun=0`.

**Two looks, one switch.** Modern gives you AgX tone mapping, ambient occlusion, real
shadow maps, refractive water and lava that blooms and shimmers. Faithful 1999 turns all of
it off and draws what Quake actually drew. Or set each effect yourself. Nothing in that
panel can move an overbounce spot — the physics cannot see the renderer at all, and the
code is structured so it never can.

Also in settings: what the HUD is allowed to tell you, two rebindable binds per action,
volume, and your name and player model. **Photo mode** pauses the game and gives you a free
camera, depth of field and a screenshot.

## Controls

All of these are rebindable in Settings, and every action keeps two binds.

| | |
| --- | --- |
| **WASD** | move |
| **mouse** | turn &middot; **left** fire &middot; **right** jump |
| **space** | jump |
| **ctrl** | crouch |
| **1 / 2 / 3 / 4 / 5 / 6** | machine gun, rocket launcher, plasma gun, grenade launcher, railgun, shotgun |
| **wheel** | cycle the weapons you are carrying |
| **X** | kill yourself, which restarts the run |
| **Esc** | pause &middot; **R** restart &middot; **F3** debug panel |

Right-click jumps because rocket jumping wants fire and jump on the same hand and within a
frame of each other, and reaching for space to do it is the most awkward thing about the
default binding.

The machine gun, the railgun and the shotgun move nobody. They are there because a course can
put a shootable button in the way, and the railgun in particular because a button far enough
away turns the machine gun's spread into a lottery. The rail is a straight line with a range of
8192 units, id's own number. The shotgun is eleven traces per pull from a seeded pattern (256
of them, one per seed byte, exactly as Quake sends it over the wire), for the button you can
see but cannot hold a crosshair on while strafing past.

## VQ3 and CPM

VQ3 is the default, and it is the mode with the fidelity guarantee: a line-by-line port of
id's own source, bugs included.

CPM is not a verified port and cannot be one, because CPMA's game code is closed source.
What it does have is evidence — every CPM constant here was read out of CPMA 1.53's own
shipped game image rather than taken from community prose, and where the two disagreed the
image decided. Air control, ramp jumps and the 400ms double-jump window are all in.

## More

- **[Every URL parameter](docs/url-parameters.md)** — the diagnostic switches behind the
  settings screens, for bug reports and for looking at something specific.
- **[Developing Overbounce](docs/development.md)** — building it, testing it, and how the
  port is put together.

## Licence

GPLv2-or-later. The movement and collision code is a derivative work of id Software's
GPLv2 Quake III Arena source, so the project inherits that licence. See `LICENSE` and
`NOTICE`.

The three bundled DeFRaG courses are GPLv3, which is one-way compatible: the code in this
repository stays GPLv2-or-later and may be taken under v2 by anyone who takes it *without*
those maps, while a built site that includes them is a GPLv3 work as a whole. `NOTICE`
says so plainly, and names what to drop for a v2-only distribution: the three entries, from
`BUNDLED_PAKS` and from the asset manifest.

Assets come from [OpenArena](https://github.com/OpenArena). Assets from a commercial
Quake III Arena installation are **not** redistributable and must never be committed here.

Overbounce is not affiliated with or endorsed by id Software or Bethesda Softworks.

The load-bearing counter: 61
