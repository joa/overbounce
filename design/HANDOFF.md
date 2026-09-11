# Overbounce UI — design handoff

Four `.dc.html` files, all 1280×720 frames. Open any of them directly in a browser.

| file | frames | what it specifies |
| --- | --- | --- |
| `Overbounce HUD spec.dc.html` | Sa Sb Sc Sd Se Sh, then Sg + Sf, then Si + Sj | the in-run HUD: one layout, six runtime states, the OB readout and anchors + tokens, then photo mode |
| `Overbounce Screens.dc.html` | 1e, 1g, 1h, 1i | title menu, course select as tiles and as a sortable list (owns its own pk3 mounting), map-load spinner |
| `Overbounce Results.dc.html` | Ra, Rb, Rc | post-run: personal best, slower run, cheats active, Career tab |
| `Overbounce Settings.dc.html` | Ta, Tb, Tc, Td | Display, Controls, Audio, Player |
| `Overbounce Playback.dc.html` | Pa, Pb, Pc, Pe, Pf, Pd | new: load a demo/ghost, default playback, expanded timeline, export settings, render progress, pause menu |

`refs/backdrop.png` is a real gameplay frame (cropped from `shots/assembled-post-on.png`),
used only as the backdrop behind HUD mockups. Not an asset to ship.

## Tokens

Taken from the repo, not invented — `index.html`, `src/render/hud.ts`,
`src/render/pak-ui.ts`, `src/render/stats.ts`.

```
background      #101014     rail background  #0e0e12     panel alt   #1a1a21 / #13131a
panel           #15151b     seam / border    #22222c     controls    #2a2a34 / #33333f
text            #e8e8ec     secondary        #c8c8d2
dim             #8a8a96     unavailable      #4a4a54   <- unavailable state ONLY
accent          #e8622a     (favicon orange, index.html)

speed ramp (speedColor())  <320 #e8e8ec · <500 #7ee081 · <800 #ffd166 · <1200 #ff9f45 · else #ff6b6b
health                     >50 #e8e8ec · >25 #ffd166 · else #ff6b6b
armour                     #7ec8e0, dimmed #4a4a54 at zero (must stay visible at zero)
ammo                       0 #ff6b6b · <=3 #ffd166 · unlimited #8a8a96
OB letters                 G,J #7ee081 · p,P #ffd166 · r,R #ff9f45 · B #62d0ff · none #ff4d4d
strafe gauge               track #26262e · window #2f6f3a · optimal #7ee081 · you #e8e8ec
```

Type: **Barlow Condensed** 400/500/600/700 for headings and numerals (always
`font-variant-numeric: tabular-nums` on numbers), **JetBrains Mono** 400/500/700 for data,
labels and paths. Uppercase mono labels carry `letter-spacing: .14–.22em`.

`#4a4a54` is not a third text colour. Anything a player needs to read is `#8a8a96` or
lighter; `#4a4a54` means unavailable (an unreachable step, a disabled button).

## Menu shell

Every non-HUD screen shares one shell, so they are one component:

```
224px left rail on #0e0e12, 1px #22222c right border, 24px vertical padding
   wordmark, then an uppercase mono section label, then rows:
   active row = 3px #e8622a left border + rgba(232,98,42,.1) background
60px header, 1px #22222c bottom border, 26–28px side padding
   left: uppercase Barlow 26px title   right: mono status line
body: 22px top / 26–28px side padding, 14px gaps, one #15151b card per decision
   card = explanation left (max ~58ch), control right, 18px/22px padding
footer: 1px #22222c top border, secondary actions left, primary CTA right
```

Back is always in the same spot: top-right of the 60px header, next to (left of) the
status line, labelled plainly "Back" — never an arrow glyph, never "Back to courses"/
"Back to title" (a screen can be reached from more than one place, so the label can't
promise a destination). Modal dialogs are the only exception.

Segmented controls are the standard control: 1px `#2a2a34` border, 4–5px radius, active
segment `#e8e8ec` on `#101014` text, inactive `#8a8a96`.

## HUD anchors (1280×720 reference)

24px inset on every edge. The middle 60% of the frame and the ground plane in front of the
player stay clear — only a modal may sit there.

```
top-left      clock: timer, pb, ghost delta, splits. 236px column, numerals right-aligned
top-right     map identity; optional debug panel below it (F3), 62% opacity
bottom-centre speed instrument: 76px number, cap bar, strafe bar, 150×58 trace
bottom-left   overbounce readout
bottom-right  vitals: health, armour, weapon + ammo
```

States — same DOM throughout, elements toggled (the `classList.toggle('hidden')` discipline
`hud.ts` already uses):

| state | what changes |
| --- | --- |
| `RUNNING` | everything live; timer green |
| `IDLE` | pointer unlocked, clock 0.000, no strafe gauge, controls modal centred |
| `FREERUN` | map has no timer entities — no clock and no splits at all |
| `FINISHED` | clock frozen amber, splits complete, hands to Results after 2s |
| `DEAD` | run voided, health ramp at its red end, restart / courses actions |
| `PAUSED` | translucent dialog over the frozen frame — quick settings + photo mode + restart + courses |

Photo mode (`Si`/`Sj`) is entered from the pause dialog: an ephemeral settings panel
(tone-mapping, DOF, vignette, chromatic aberration — mirrors Settings without persisting),
free-cam movement, and a screenshot action (click copies to clipboard, shift-click saves).
The capture itself (`Sj`) is a blank frame stamped with the wordmark + version, matching
Results' styling.

## Decisions worth not re-litigating

- **Graphs are small and cornered.** A 150×58 trace reads because you read its slope, not
  its values. Nothing instrumentational goes in the sightline.
- **OB help has two registers.** Verbose card for a newcomer, bare letter for everyone
  else; `Auto` retires the explanation per method after two clean landings. Both drawn in
  `Sg`; only one is on screen at a time.
- **One OB readout, not VOB + HOB.** Same code path in `PM_WalkMove`; two rows would imply
  a distinction that is not there (`tools/diag/vob-hob.ts`).
- **Physics and camera are per course**, declared by the map, `AUTO` by default; the
  override is remembered per map, not globally. Camera adds a fourth option, `FPV`, beyond
  auto/chase/side. Course select's Collections rail is a single "All courses" list for now —
  Tutorial/Strafe/Overbounce/Rocket groupings aren't built (no levelshot or tag source yet).
- **Results shows the mode a run was set with.** PHYS/CAM badges (e.g. `VQ3`/`FPV`) sit next
  to the "PERSONAL BEST"/"FINISHED" label, not the time — a run only makes sense next to the
  settings it was posted under, and the label row is where that context reads as context
  rather than a bolted-on stat.
- **Pmove tick rate is a physics setting, not a graphics one.** The sim steps at a fixed
  tick regardless of what the browser paints (vsync caps painting at ~60 either way). 125
  jumps highest: 48.6u vs 46.7u at 60 and 36.5u at 1000.
- **Anything that makes it easier means no clock.** Cheats (self damage off,
  all-weapons/infinite-ammo) are untimed — no clock, no ghost, no record. This is a URL
  param (`?selfdamage=0`) read at run start, not a course-select toggle — course select's
  `TIMED`/`FREERUN` badge just states what the map itself declares.
- **Pausing costs the attempt.** The clock stops and the run can no longer be recorded, the
  same rule as death — otherwise pause is a free look at the course.
- **Settings surface four panels — Display, Controls, Audio, Player.** Movement was cut: physics
  and camera are per-course (see above), not player settings, so nothing in Settings can move
  an overbounce spot. The other URL parameters not covered by these panels are diagnostics and
  stay in the URL. Panels print the URL they would produce, so a setting and a bug report are
  the same string.
- **There is no loader screen.** It was cut — course select mounts the bundled kit itself
  and carries its own drop/browse region, so adding a map never routes through a separate
  destination. "Load .pk3 assets" and "Learn the movement" are both gone from the title menu
  for the same reason: nothing built needs to detour through them.
- **Career stats live on results**, because that is when a player wants them: a strip on the
  run itself, the full speed-per-hour-played curve on a second tab.

## Implementation notes

- Nothing in the render or UI layer may affect physics — the ESLint import boundaries in
  `eslint.config.js` already enforce this and the designs assume it.
- The HUD is DOM over the canvas, as `hud.ts` is today. Keep it in `#overlay`
  (`pointer-events: none`); anything interactive — the pause dialog, the loader — mounts on
  `document.body` instead, per `pak-ui.ts`'s existing note.
- Menu screens are ordinary DOM, not canvas. They can be one component with a rail, a
  header, a card list and a footer.
- Two web fonts (Barlow Condensed, JetBrains Mono). If they must be self-hosted, subset to
  latin + the few glyphs used: `· → ⇒ Δ ° ✓ —`.

## Playback (new)

A third title-menu destination alongside Run a course and Settings, for viewing and
cinematically recording `.dm_68` demos and Overbounce ghosts.

- **Loading mirrors course select.** A demo needs its map mounted to play, so `Pa` reuses
  the drop/browse pattern, plus a ghost-specific path: paste, drop, or load a `.obghost` file.
  Paste is the important one — sharing happens as a copied string in Discord, not a file.
  A demo whose map isn't indexed shows a red "Map missing" status and its SELECT/Start
  playback actions stay disabled.
- **Default view is chrome-light** (`Pb`): the demo plays in its proper camera immediately —
  fixed FPV for `.dm_68` (that's what Q3A demos recorded), whatever the ghost's own camera
  selection was for Overbounce ghosts. Play/pause and a scrubber, nothing else, `T` expands
  the timeline.
- **The ghost is not translucent here** — unlike photo mode's players, it's the primary
  subject of a recording, not a passive reference.
- **Timeline (`Pc`)** switches the view to free cam and adds cue points, per-property tracks
  (camera position, FOV, vignette, DOF, chromatic aberration — the same properties photo
  mode exposes, now keyframeable) and an easing picker per keyframe: a direction
  (LINEAR / IN / OUT / EASE) paired with a curve family (QUAD / CUBIC / BOUNCE) — direction
  alone is meaningless, so picking OUT auto-pairs a family (e.g. Ease Out Cubic).
  In/out markers on the ruler trim the exported range independent of playhead position, so
  scrub position and export range are separate concerns. "Export video" opens `Pe`; tracks,
  cues and trimming are all optional — the default is still just watching the demo play.
- **Export settings (`Pe`)**: resolution (720p/1080p/2160p/4K, default 1080p), framerate
  (30/60/120, default 60), bitrate slider (default 16 Mbps), and the export range read from
  the timeline's in/out markers (not re-editable here — one source of truth). "Start
  rendering…" leads to `Pf`, a progress dialog with percent, time remaining and cancel.
- **Esc menu (`Pd`)** is Resume / Restart playback / Settings / Back — a pause dialog, so
  it's the one place "Back" doesn't sit top-right; it's a stacked list of actions.
- **Selecting a demo starts it.** `Pa`'s row action is PLAY, not SELECT — there is nothing
  else to do with a selected demo, so a separate "Start playback" footer CTA was removed.
- **Timeline (`Pc`) tracks show their live value**, not just the curve: FOV/vignette/
  chromatic aberration each print a numeric readout (click to type) beside the track, and
  the track itself is a drag-to-set control at the playhead. Undo/redo sit in the toolbar,
  left of "Hide timeline". The ruler's cue-point diamonds were removed as redundant with
  (and confusing next to) the per-property keyframes below; the ruler now sits in the same
  label/track/value grid as the property rows so 00:00 lines up with the first reachable
  pixel of the track, and both the ruler and the track list scroll horizontally together.

## Not designed yet

- **Ghost picker** — Results and course select both link to it
- **Lesson flow** — the title menu's "Learn the movement" entry is gone until this exists
- **Leaderboards** — nothing in the repo is networked; out of scope until it is
