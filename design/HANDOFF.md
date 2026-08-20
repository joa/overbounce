# Overbounce UI — design handoff

Four `.dc.html` files, all 1280×720 frames. Open any of them directly in a browser.

| file | frames | what it specifies |
| --- | --- | --- |
| `Overbounce HUD spec.dc.html` | Sa Sb Sc Sd Se Sh, then Sg + Sf | the in-run HUD: one layout, six runtime states, then the OB readout and anchors + tokens |
| `Overbounce Screens.dc.html` | 1e, 3a, 3b, 1g | title menu, asset loader (empty + mounted), course select |
| `Overbounce Results.dc.html` | Ra, Rb, Rc | post-run: personal best, slower run, cheats active, Career tab |
| `Overbounce Settings.dc.html` | Ta, Tb, Tc | Movement, Display, HUD |

The HUD mockups are drawn over `refs/backdrop.png`. The original was a retail Quake III
frame and was removed for exactly the reason `.gitignore` excludes `shots/` and NOTICE
forbids committing that content; the file now in its place was supplied by the project
owner as license-compatible. It is not OpenArena and not verified against NOTICE's own
per-asset documentation standard the way the OpenArena textures in
`tools/assets.manifest.json` are, so treat its licensing as the owner's representation
rather than independently confirmed provenance if it is ever redistributed beyond this
repository.

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
| `PAUSED` | translucent dialog over the frozen frame — quick settings + restart + courses |

## Decisions worth not re-litigating

- **Graphs are small and cornered.** A 150×58 trace reads because you read its slope, not
  its values. Nothing instrumentational goes in the sightline.
- **OB help has two registers.** Verbose card for a newcomer, bare letter for everyone
  else; `Auto` retires the explanation per method after two clean landings. Both drawn in
  `Sg`; only one is on screen at a time.
- **One OB readout, not VOB + HOB.** Same code path in `PM_WalkMove`; two rows would imply
  a distinction that is not there (`tools/diag/vob-hob.ts`).
- **Physics and camera are per course**, declared by the map, `AUTO` by default; the
  override is remembered per map, not globally. Course select's rail control is a *filter*
  ("built for"), never a setting.
- **Pmove tick rate is a physics setting, not a graphics one.** The sim steps at a fixed
  tick regardless of what the browser paints (vsync caps painting at ~60 either way). 125
  jumps highest: 48.6u vs 46.7u at 60 and 36.5u at 1000.
- **Anything that makes it easier means no clock.** Cheats, self damage off, and
  all-weapons/infinite-ammo are all untimed — no clock, no ghost, no record. Course select
  states the cost on the control with a `TIMED` badge before you start.
- **Pausing costs the attempt.** The clock stops and the run can no longer be recorded, the
  same rule as death — otherwise pause is a free look at the course.
- **Settings surface five things.** The other 33 URL parameters are diagnostics and stay in
  the URL. Panels print the URL they would produce, so a setting and a bug report are the
  same string.
- **The loader is a screen, not a modal**, reached only from *Load .pk3 assets*. Course
  select carries its own drop region so adding a map never routes through it.
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

## Not designed yet

- **Ghost picker** — Results and course select both link to it
- **Lesson flow** — the 8 lessons the on-ramp implies: sequence, pass condition, hand-off
  to real courses
- **Loader mid-parse progress state**
- **Controls and Audio settings panels** — nav items exist, contents not designed
- **Leaderboards** — nothing in the repo is networked; out of scope until it is
