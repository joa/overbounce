# URL parameters

All 85 of them, enumerated mechanically from the source rather than from memory:

```bash
npm run url-params           # the list
npm run url-params -- --doc  # diff it against this file; non-zero if they disagree
```

`tools/url-params.ts` is that mechanism, and `--doc` is what makes the claim
above checkable rather than merely stated. Anything not listed here is either
not a parameter or has been added since — run the command, do not trust the
prose. Two traps it exists to avoid, both of which had already let a parameter
through: a line-oriented grep misses a call that wraps across lines (which is
how `mapoverbright` stayed hidden), and matching every `get('…')` in the tree
sweeps up `surfaceparms.has('lava')` along with the real ones.

An unrecognised **value** warns on the console and keeps the default rather than
throwing, because a typo in a URL should not be a blank screen. An unrecognised
**parameter name** is silently ignored — the browser has no way to tell one from
a tracking token.

Twenty-two of these 85 are also **settings**: `src/ui/local-settings.ts`'s
`SETTING_KEYS` (`obhelp`, `debugpanel`, `strafegauge`, `strafehelper`, `ghost`,
`crosshair`, `sensitivity`, `volume`, `muted`, `player`, `playername`,
`tonemap`, `shadows`, `ssao`, `lavabloom`, `lavashimmer`, `fogfeather`, `fog`,
`aberration`, `motionblur`, `water`, `fxaa` — every one Settings or PAUSED's QUICK SETTINGS surfaces a
control for) persist to `localStorage`, and a URL value for one of them
overrides storage for that page load without replacing it. Every other
parameter below is a diagnostic in the sense R7 always meant it: URL-only,
gone the moment the tab closes, chosen specifically so that pinning one in a
link reproduces a bug exactly rather than quietly becoming someone's new
default.

---

## Loading

| parameter | default | meaning |
| --- | --- | --- |
| `devpak` | — | `.pk3` under `public/` to mount. Built by `npm run build-devpak` from your own Quake III install. |
| `map` | first in the pak | Which map in the mounted paks to load, without the extension. Also selects a bare `.bsp` from `public/maps/` when no pak carries it — `ob_basics`, `ob_rockets`, `mega_rl`, `hntourney1`, `feliz-a1`. |
| `player` | `doom/phobos` | Player model, as `model` or `model/skin`. Falls back with a console warning listing what is available. |
| `playername` | empty | The nameplate on an exported result screenshot (`results-export.ts`). Empty is anonymous. It goes nowhere but into a PNG the player asks for, and an unreadable store falls back to empty rather than failing the export — a screenshot must not die over a nameplate. |

## Where you start

| parameter | default | meaning |
| --- | --- | --- |
| `at` | the map's spawn | `x,y,z`, `x,y,z,yaw` or `x,y,z,yaw,pitch` in Quake units. Drops the player there instead of at an `info_player_deathmatch`. Pitch is positive DOWN, and it exists because a horizontal surface — water, lava, a floor decal — is edge-on from a level camera and cannot be judged in a screenshot without it. |
| `physics` | `vq3` | `vq3` or `cpm`. VQ3 is the mode with the fidelity guarantee. CPM is reconstructed from community-documented behaviour and GPL reimplementations, with every constant read out of CPMA 1.53's shipped VM bytecode (`.agent/docs/cpma-constants.md`) — which settles the numbers without making it a verified port. |
| `camera` | `chase` | `chase`, `side` or `fpv`. `fpv` is the classic Quake first-person view, for the id maps — it hides the player model, the collision hull and the aim laser. The laser exists because aim is invisible from a side view; in first person the crosshair does that job. There is no first-person weapon model, because Quake draws a separate viewmodel MD3 that this project does not load. `side` reads the map's own `scripts/<mapname>.cam` if one exists — the perpendicular axis, fixed/rail zones and the occlusion cutaway radius are all authored there rather than as URL parameters; see `.agent/plans/SIDE-CAMERA.md`. Course select's AUTO resolves to `side` automatically when a `.cam` is present. |
| `selfdamage` | `1` | `0` is defrag's no-self-damage mode: **full knockback, no health loss**, so every rocket jump behaves identically and only the health economy changes. Not auto-detected — there is no key in the entity lump or the worldspawn that marks a map as no-damage, and DeFRaG controls it server-side. |

## HUD

Display/audio-only — none of these can move an overbounce spot, the same guarantee every
render-layer parameter on this page already carries. `obhelp`, `debugpanel`, `strafegauge`,
`ghost`, `crosshair` and `volume`, along with Display's `tonemap`/`shadows`/`ssao`/`lavabloom`/
`lavashimmer`/`fogfeather`/`fog`/`aberration`/`motionblur`/`water`/`fxaa` below, are **settings, not URL state** —
`src/ui/local-settings.ts` persists them in `localStorage`, and Settings/PAUSED's QUICK
SETTINGS panel (`design/Overbounce HUD spec.dc.html`'s `Sh`) write there, not to the
address bar. A parameter listed here still works exactly as documented, but as an
*override* for the current page load only: present in the URL, it wins over whatever
storage says; absent, storage's value applies; changing it through the UI clears any
stale URL override for that one key so a refresh cannot resurrect it. Pinning one of these
in a URL therefore still reproduces a state exactly — "a setting and a bug report are the
same string" survives the move to storage — it just no longer *becomes* the permanent
setting on its own. Changing any of these never reloads the page (R8) — a reload would
drop every `.pk3` mounted in memory, forcing a re-select. Seven of the eleven Display keys
(`tonemap`/`ssao`/`aberration`/`motionblur`/`lavabloom`/`lavashimmer`/`fxaa`) are pure post-processing
and apply immediately even mid-course; `shadows`, `water`, `fogfeather` and `fog` are baked in
at course start — the first three into world-mesh materials and `fog` into the post chain,
which is compiled against the map's own fog volumes — so a change to any of them takes effect
next time the course starts, same as the Movement tab's Physics/Camera pickers already work.

| parameter | default | meaning |
| --- | --- | --- |
| `obhelp` | `auto` | `full`, `auto` or `letter` — the overbounce readout's verbosity. `auto` is meant to retire the explanation per method after two clean landings, but nothing in this codebase generates the landing event that would drive that yet, so it currently reads exactly like `full` until it does — see `hud.ts`'s own file header. |
| `debugpanel` | `1` | Where **F3** starts (pos/yaw/ground/jumps/cpu/fps, top-right). F3 still toggles it live either way; this only sets the opening state. Separate from `stats`, which is a different panel (the perf overlay `stats.ts` owns). |
| `strafegauge` | `1` | `0` removes the airborne strafe-quality bar entirely, rather than just never triggering its window. |
| `strafehelper` | `0` | `1` draws a line from the crosshair to where your aim should be, as long as the turn you still owe, disappearing once you are within a flick of it. Same conditions as the gauge: airborne, above wishspeed. Off by default — it is a teaching aid, and a runner who has internalised the angle does not want it in the frame. |
| `ghost` | `1` | `0` skips loading and racing a saved ghost. The run's own usercmd stream is still recorded regardless — a later session's ghost race needs it even if this one opted out of racing. |
| `crosshair` | `4` | First person only. `0` hides it; otherwise one of the ten Quake III styles (`% 10`, wraparound included — `10` lands back on style `0`'s letter, the same quirk `cg_drawCrosshair 10` has). `4` is Quake III's own stock default. See `src/render/crosshair.ts` — the index/count math is a verified port of `CG_DrawCrosshair`; the icon art is an original recreation, since the real `.tga`s are a retail asset not in the GPL source. |
| `volume` | `60` | Master volume, `0`-`100`, `SoundSystem`'s own gain node. Out-of-range or non-integer values are clamped/rounded with a console warning, same as `hull`. |
| `muted` | `0` | `1` starts muted. Separate from `volume=0` and deliberately so — muting and unmuting has to return the player to the level they chose, which means remembering it. |
| `sensitivity` | `5` | Mouse sensitivity, `0 < s <= 30`. Anything outside that keeps the default and warns: `0` is a view that will not turn, which a player would read as the game having frozen. |

## Development affordances

These exist so headless verification is possible. They are not gameplay
features, and none of them is Quake.

| parameter | default | meaning |
| --- | --- | --- |
| `give` | — | `quad`, `battlesuit`, `regen`, `haste`, `flight`, comma-separated. Grants for 30 minutes at spawn. Exists because "run to the Quad, pick it up and screenshot within 30 seconds" is not something a headless harness does reliably. |
| `use` | — | Fires a `targetname` at load, as a `trigger_multiple` would. Exists because q3dm7's floor door is opened by a button in a different room, so no amount of settling produces a screenshot of it open. |
| `overview` | off | Frames the whole map from outside with no camera collision. For eyeballing that world geometry built correctly. |
| `collision` | off | Draws the brush hull physics actually uses instead of the map's real surfaces. The right thing to debug traces against and the wrong thing to look at. |
| `stats` | on | `off` hides the performance overlay. |
| `explosions` | `auto` | `classic` keeps the original sprite explosion; `fancy` insists on the newer one, falling back silently if the loaded pak has none of its textures; `auto` picks `fancy` when the assets are actually there. Same shape as `hull`. See `.agent/docs/fancy-explosions.md`. |
| `hull` | `auto` | The orange wireframe box around the player — the collision hull physics actually uses. `auto` draws it only when there is no player model to draw instead; `on` forces it back over the model, for checking the art against the hull; `off` removes it entirely. It used to be drawn over the model at 0.15 opacity, which read as a cage. |
| `laser` | depth tested | `xray` restores the see-through aim laser. The default is depth tested, because the muzzle sits inside the player's torso and an untested line draws across their own chest. `xray` costs that and buys an aim indicator no wall can hide, which from a side view is a real trade rather than a bug. |

**`give` sets personal bests.** A run made with a granted powerup is recorded
like any other. Whether that is right is an open question — see the note at the
bottom.

---

## Post-processing

All of it is in `src/render/post.ts`, whose header carries the measurements
behind these numbers. `?post=off` skips construction of the whole chain.

| parameter | default | meaning |
| --- | --- | --- |
| `post` | `on` | `off` disables the entire chain. |
| `tonemap` | `agx` | One of `none`/`off`, `agx`, `neutral`, `aces`, `cineon`, `reinhard` — the keys of `TONE_CURVES` in `post.ts` and nothing else. `?tonemap=off&ssao=off&aberration=0&motionblur=0` is the faithful configuration. |
| `exposure` | `1.6` | Linear exposure applied immediately **before** the tone curve, and only when there is one. Quake's content is display-referred, so a scene-referred curve like AgX never leaves its toe without this. |
| `fxaa` | on | Runs after the sRGB encode, which is why the chain does tone mapping explicitly rather than through the pipeline's appended transform. |
| `aberration` | `0.1` | Radial chromatic aberration. `0.1` is 1.4 pixels at the edge of a 1280-wide frame and exactly nothing at the crosshair. `0` removes the stage. |
| `motionblur` | `0.2` | Multiplier on the speed-driven motion blur. Curve: no visible blur at 320ups (default run speed), slightly visible at 600ups, full strength at 1200ups — quadratic ease-in, so speed above 1200 buys nothing more. `0` removes the stage. The default is deliberately low: a good run spends much of its time above 1000ups, so at `1` the blur is not an occasional flourish but most of the frame, and it costs the player the ledge they are aiming at. |
| `gamma` | `1` | `s_gammatable`, in the sRGB domain. See `color-mapping.ts`. |
| `overbright` | `0` | Overbright bits applied at output. |
| `mapoverbright` | `2` | Overbright shift baked into lightmap bytes at map load. Works with `?post=off`, unlike the two above. |

### SSAO

| parameter | default | meaning |
| --- | --- | --- |
| `ssao` | `world` | `off`, `world`, `all`, or a bare strength `0..1`. `world` masks the effect to geometry passed to `markAoWorld`, so a spinning item does not shimmer as its own occlusion changes. |
| `ssaostrength` | `1` | How much of the computed occlusion to apply. |
| `ssaoradius` | `24` | Occlusion radius in Q3 units (~inches). Quake is about one unit per inch, so the node's own metre-scale default of 0.25 is a quarter of an inch and invisible. |
| `ssaomax` | `0.35` | Hard cap on how much SSAO may darken a pixel. A corner can never drop below 65% of its lit value. Legibility, not taste — overbounce spots are judged by eye from sub-unit geometry. |
| `ssaoresolution` | `0.5` | Fraction of the backbuffer the AO runs at. **The cost dial.** At 1080p this is 2.00 ms against 0.74 ms, for eight percent of the effect. |
| `ssaosamples` | `16` | GTAO samples per pixel. |
| `ssaodebug` | `off` | `ao`, `depth`, `normal`, `mask` — puts an intermediate buffer on screen instead of the game. Diagnostic views take no tone curve and no lava effects, because a bloomed occlusion buffer is a buffer that lies about its own values. |

**Fog attenuates SSAO**, and there is no option for it because there is no
reason to want it off: a corner seen through dense fog is not visible, so
shading one invents an edge the player cannot see. A fogged surface writes
`1 - density` into the AO mask instead of `1`, so the occlusion fades out at
exactly the rate the fog fades in. `?ssaodebug=mask` shows it — a fogged
surface is grey where it used to be flat white.

It has to happen there rather than in the post chain: on a lit material Quake's
`RB_FogPass` lands in `outputNode`, *after* the lighting, so by the time the
frame reaches the AO stage the fog is baked into a colour with no density left
to read.

### Lava

Neither effect is Quake — see `src/render/lava.ts`. Both are switchable because
this is a speedrunning game and anything that blooms into a doorway or wobbles a
ledge edge costs the player information they navigate by.

| parameter | default | meaning |
| --- | --- | --- |
| `lavabloom` | `1` | Bloom strength, `0..1`. `0` removes the stage. `0.35` is the conservative setting. |
| `lavabloomradius` | `0.12` | Spread, in fractions of screen height. |
| `lavashimmer` | `0.007` | Peak heat-haze displacement in UV units. `0` removes the stage. Was `0.0025` and invisible — 1.8 pixels on a noise texture is not an effect. |

### Water

`?water=faithful` is the reference picture and is produced by the ordinary
shader compositor — Quake's water is a stack of `blendFunc GL_dst_color GL_one`
passes, which fold exactly into one filter-blended draw. See
`.agent/plans/WATER.md` for why that used to render as a black blob.

`?water=modern` applies the same factor to a *displaced* sample of the scene,
which is refraction, and mixes in a *reflection* by Fresnel — a third render
pass, the world drawn again through a camera mirrored in the water plane and
clipped at it. Neither is Quake: Quake's water bends nothing and reflects
nothing.

| parameter | default | meaning |
| --- | --- | --- |
| `water` | `modern` | `faithful` or `modern`. |
| `waterrefract` | `0.012` | Peak refraction displacement in screen UV units, about 8 pixels at 720p. `0` leaves the sample where it is, which makes modern mode match faithful. |
| `waterstretch` | `0.5` | How much a grazing view stretches the refraction; `1 + this` at full grazing. `0` makes it view-independent. Deliberately below the physical value: grazing is exactly where a screen-space sample lands on something that is not behind the water, and at `1.5` the far end of q3ctf2's pool broke into black bands. |
| `waterreflect` | `1` | Multiplier on the Fresnel reflection weight (Schlick, `F0 = 0.02`, lifted by `waterreflectmin`): about 0.5 at the side camera's ~12° view of a pool at the player's feet, a full mirror toward the horizon. `0` removes the reflection pass entirely, not just the weight. |
| `waterreflectmin` | `0.2` | Floor under the Fresnel curve: the weight is `min + (1 - min) * schlick`. `0` is the physical curve, where a pool seen from above reflects two percent and shows nothing; `0.2` shows the room in it without hiding its floor. Clamped to 1. |
| `waterreflectres` | `0.5` | The reflection target's size as a fraction of the drawing buffer, in `(0, 1]`. The pass draws the whole world again, so this is the cost knob. |
| `waterdebug` | `off` | `reflection` draws the raw mirrored sample at full weight; `fresnel` draws the weight as grey; `facing` the cosine it is built from. Diagnostics, like `portaldebug` — and read the greys with a pixel probe, a 0.35 weight looks white next to a dark map. |

The reflection mirrors the *render* camera rather than the player's eye — a
portal is composed for whoever looks through it, a reflection is read back in
screen space by whatever drew the screen — and one plane is rendered per frame:
of those with a surface on screen and the camera above them, the one that can
cover the most of the screen. Its weight never
mixes toward the water's own factor, which is a coefficient rather than a
colour; the first Fresnel attempt did exactly that and blew the pool out to
white. `.agent/plans/WATER.md` has the history.

Modern water composites its lightmap in its own stage rather than through the
material, so that the reflection is not lit by the lightmap of the surface it
bounces off. One consequence: `?lightmapintensity` does not reach modern water.
Faithful water is untouched.

### Fog volumes

Everything about a fog volume comes out of the BSP and is a port of
`RB_FogPass` — except one number. Quake measures fog along the **view ray**, so
the density a surface gets is `sqrt(distance travelled through the volume /
depthForOpaque)`. A first-person eye stands in the room; a sidescroller's
camera sits a thousand-odd units off to the side, which multiplies that
distance by three or four and saturates the curve almost the moment the ray
crosses the volume's top plane. `sqrt`, whose slope at zero is infinite, does
the rest. de4th_run1's ground fog came out as a flat red slab with a knife edge
along the top instead of as fog.

`?fogfeather` multiplies the density by a `smoothstep` over the first fraction
of each volume's own depth, measured from its visible side down along the view
ray. It is a fraction and not a distance in units so that a shallow fog is not
erased by a value tuned on a deep one; below 1 it leaves the deep part of every
volume at exactly `R_FogFactor`. The volume boundary itself — a surface outside
the brush takes no fog at all — is Quake's own edge and is untouched. See
`src/render/fog.ts`'s header.

A marched box has a box's edges, and from OUTSIDE a volume that is what you see:
its top hangs in the room as a razor-straight plane. `?fogfeather` answers that
here the same way it answers the analytic cliff — the density is faded in from
every face, over that fraction of each half-extent, and the three axes
multiplied together so the corners round off too. Standing inside a volume the
boundary is behind you and none of this shows, which is exactly why the first
pass at it was judged from the wrong place.

`?fog=volumetric` throws the analytic pass away entirely and RAYMARCHES the same
volumes in the post chain instead: for each pixel, intersect the view ray with each
fog brush's box, clip it at the depth buffer, and integrate Beer-Lambert through it.
The extinction comes from `depthForOpaque` — `sigma = -ln(0.02)/depthForOpaque` — so
the density is still the mapper's number and q3dm7's two pools stay as different from
each other as their author made them. See `src/render/volumetric-fog.ts` and
`.agent/plans/VOLUMETRIC-FOG.md`.

The two paths are mutually exclusive, not additive: `RB_FogPass` tints the surfaces
inside a volume and the march composites over the finished frame, so running both
tints everything twice. `?fog=volumetric` therefore switches the analytic pass off
for world surfaces and models alike.

One behaviour difference worth knowing: `GeneratePermanentShader` gives a translucent
non-fog shader no fog pass at all, so in Quake the glass and blended grates inside a
volume stand out unfogged. The march does not know they are special, and fogs them.

| parameter | default | meaning |
| --- | --- | --- |
| `fog` | `volumetric` | `volumetric` or `analytic`. Faithful asks for `analytic`. |
| `fogfeather` | `1` | **Both paths.** How soft a volume's boundary is, as a fraction — of the volume's thickness below its top plane for analytic, and of each half-extent inward from all six faces for the march. `0` is the hard edge in both: `R_FogFactor` verbatim, or the bare box. `1` spreads the fade across exactly the whole volume, so the far face still lands on the density Quake asks for. **Above 1** the ramp runs off the far side and never gets there, which thins the fog as well as softening it — a real thing to want on a dense volume. Settings' slider goes to 2; the parameter itself has no upper bound. |
| `fogsteps` | `16` | **Volumetric only.** March steps per volume. |
| `fogdensity` | `0.5` | **Volumetric only.** Multiplier on the `depthForOpaque`-derived extinction. Half, because Quake's number was authored against `RB_FogPass` — a stain applied once per surface by how far the ray travelled to reach it. Integrated properly through the volume the same coefficient is much heavier, and at `1` the volumes read as paint. |
| `fognoise` | `0.6` | **Volumetric only.** How much the density varies, `0..1`. `0` is homogeneous, which integrates to the analytic answer. |
| `fognoisescale` | `192` | **Volumetric only.** Noise features per this many Q3 units. |
| `fognoisespeed` | `0.05` | **Volumetric only.** How fast the noise drifts. |
| `fogdebug` | `off` | **Volumetric only.** `dir`, `dist`, `span`, `alpha`, `origin`, `enter` — put one intermediate of the march on the screen. A march prints nothing and cannot be stepped; this is how both of its real bugs were found. Take it with `&tonemap=off`, or the curve rescales what you are trying to read. |

### Lit materials and dynamic lights

The renderer's materials are real lit ones — see `.agent/plans/LIGHTING.md`.
`?lit=off` restores the previous unlit pipeline in full, including the
hand-rolled dlight compositing, and is the reference every change to the lit
path is compared against.

| parameter | default | meaning |
| --- | --- | --- |
| `portals` | `on` | `off` skips the portal's second render pass. A portal renders the whole scene again from another viewpoint, so it is the most expensive single thing in a frame on a map that has one — q3dm7 is the only map in the rotation that does. |
| `portalrange` | the shader's | Overrides `portalRange` — the distance over which a portal surface fades to its own haze — in Q3 units. Being able to push it to either extreme is how you tell "the fade is wired and the constant is wrong" from "the fade is not running at all". |
| `portaldebug` | off | `view` draws the portal's rendered view alone, with none of the shader's stages over it; `nofog` keeps the stages but drops the `alphaGen portal` one. Between them they separate "the second pass is wrong" from "the compositing over it is wrong", which look identical in the finished frame. |
| `lit` | `lambert` | `lambert`, `standard` or `off`. **Standard is known-broken on this content**: on q3dm6 the pentagram's gold inlay renders solid black under `MeshStandardNodeMaterial` and correctly under Lambert, from the same albedo and the same lightmap — and not because of the specular lobe (`?roughness=1` is black too) or the post chain. Lambert is also what Quake does: `RB_CalcDiffuseColor` has no specular term. |
| `lightmapintensity` | `π` | Scales the lightmap's contribution as irradiance. **π is derived, not dialled in**: three applies `BRDF_Lambert`, which divides by π, and the old multiply did not. At π the lit picture matches `?lit=off`. |
| `roughness` | `0.9` | `standard` only, which is not the default. High on purpose — a Quake texture has no roughness map, so a low value gives every surface the same plastic sheen. |
| `metalness` | `0` | `standard` only. Quake has no metal workflow. |
| `lightscale` | `1` | Taste multiplier on **dynamic** light intensity — rockets, plasma, the Quad, and nothing else. Standing still with nothing in flight every slot is parked at intensity 0, so the knob is arithmetic on zero and looks broken; fire a rocket to see it. 1 means full brightness at half the light's radius; the intensity itself is `radius² / 4`, which is arithmetic rather than taste — three's punctual lights are physical, and at one-unit-per-inch a plausible-looking small number is invisible. |
| `shadowlights` | `2` | How many **dynamic** lights cast shadows — same scope as `lightscale`, so it does nothing until something is in flight. Two is a rocket and a plasma ball at once. This was `0` until 2026-09-03 on two grounds, one of which no longer holds: a point shadow is still six cube faces per light per frame, but "the player on the floor is already shadowed by the grid-steered directional light" stopped being true when `?shadows=lights` became the default and that light stopped casting. The old row also warned that a casting point light in r0.185 blackens every fragment outside its radius (q3dm6's pentagram inlay) — **re-derived 2026-09-03 and it did not reproduce**, on a dynamic light or a map light. Reserved-but-empty caster slots are free: they are parked outside the map with `shadow.autoUpdate = false`, so they cost nothing until something is actually in flight. |
| `lightshadowsize` | `512` | Shadow map edge length per cube face. |
| `missilelight` | `4` | Multiplier on a rocket's, plasma ball's and explosion's light **radius** — how far it reaches, not how bright it is. Quake's own rocket radius is 200 units, about two player-heights, and three's `distance` is a hard cutoff, so at 1 the light and the shadow it throws live in a small sphere moving at 900ups and almost nobody ever sees one from a side camera. 4 is a rocket that lights the corridor it is flying down. `?lightscale` will not help here: it changes brightness, not where the shadow can land. `?missilelight=1` puts id's own radius back. |

| parameter | default | meaning |
| --- | --- | --- |
| `worldshadows` | follows `shadows` | Let the MAP cast into the shadow map, not just the models and items on it. **On under `?shadows=lights`, off under `?shadows=dynamic`** — one flag with two right answers: in `lights` the casters are lamps and projectiles, and a declared light that cannot reach the architecture is just a second player shadow, while in `dynamic` the caster is the steered light whose direction leans as you walk, and a whole map swinging with it is the reason `lights` exists. `=1` and `=0` override either way. **Ignored under `?lit=off`** (an unlit world samples the shadow map through a patched `colorNode`, and casting into a texture it samples is a WebGPU read-write hazard that blanks the frame) and inert unless shadow mapping is on at all. Costs a pass over the world per casting light — measured on q3dm6 under four casting wall lamps, 188 draws to 398 and 57k triangles to 253k; on q3ctf2, whose 165 world batches make it the heaviest map in the set, about +90 draws and +90k triangles per casting light. What it buys is the part a lightmap cannot have: geometry casting from a light that MOVES. Under the near-vertical sun of an id map it is nearly invisible; under a `?maplightshadows` wall lamp it is the difference between a cone that washes over a staircase and one that stops at it. |

A dynamic light attached to the thing carrying it never casts, even at
`?shadowlights=1` — the Quad's light sits at the player's own origin, so a
casting version spends its life occluded by the player holding it. A rocket in
flight is the opposite case and does cast. That is per light, not global.

### The map's own lamps and torches

Quake ships the list: q3dm6 declares 113 `light` entities and q3dm7 declares
301, with colours, intensities and — for a third of them — a `target` that
makes them spotlights. See `.agent/plans/MAP-LIGHTS.md`.

**These are already in the lightmap, baked**, and it cannot be un-baked, so
they run at a low scale: what they add is response to proximity, and for the
flames a flicker, which is the one thing a baked lightmap cannot do by
construction. Lit modes only.

| parameter | default | meaning |
| --- | --- | --- |
| `maplights` | `0.3` | Overall scale. `0` disables the feature. Low because the lightmap already contains every one of these — raising it toward 1 double-counts the map. |
| `maplightpoints` | `4` | Pool slots for plain lights. A fixed pool: 301 lights cannot all exist, and changing the light count recompiles every material. |
| `maplightspots` | `4` | Pool slots for spotlights — a Q3 `light` with a `target`. **How many exist is the map's decision**: 32 of q3dm6's 113, but only 10 of q3ctf2's 983, so on a CTF map the extra slots have nothing to fill them. |
| `maplightshadows` | `4` | How many spot slots cast. Under the default `?shadows=lights` these and `shadowlights` are where every shadow in the game comes from, and with `?worldshadows` on with them, a lamp's cone stops at the geometry it hits instead of washing over it. Four rather than two because two was not visible: on the q3dm6 staircase the two-caster frame is close enough to the unshadowed one to argue about. **Empty slots are free** — a slot with no lamp near enough is parked with `shadow.autoUpdate = false` — so the cost is per lamp actually in range. Lower it to `2` on a map where that is too much. |
| `maplightpointshadows` | `0` | How many PLAIN slots cast. Separate from `maplightshadows` because a point shadow is a **cube** — six render passes to a spot's one. It works (`LIGHTING.md`'s finding 3 was re-derived here on 2026-09-03 with two casting map point lights over q3dm6's pentagram, and the inlay stayed lit); it is simply expensive, and on a map like q3ctf2 where 973 of 983 declared lights are plain points the pool is always full, which took 52fps to 30. Raise it on a small map, or on one with no spotlights at all — that is the case where "declared lights cast" is otherwise vacuous. |
| `maplightrange` | `900` | Cull radius. A light fades out over the last fifth of it rather than switching off — a wall lamp popping out reads as the level breaking, where a rocket doing it is over in a frame. |
| `maplightflicker` | `2` | How much a torch's brightness swings, over a range of `[1 - value/2, 1]` — so `2` is the full swing from dark to full, and also the ceiling: past it the multiplier goes negative and a torch would subtract from the lightmap, so values above 2 are clamped. **Needs a torch, and most maps have none**: a light only counts as one with an `animMap` + `q3map_surfaceLight` surface within 96 units. q3dm6 has 0 of 113; q3ctf2 has 8 of 983, and with ~1000 lights competing for 4 pool slots even those only flicker from a few tens of units away. The console line at load says how many the map declared. Deterministic, so a screenshot is reproducible, and phase-offset per light so a row of torches never beats in unison. |

### Seeing any of it

| parameter | default | meaning |
| --- | --- | --- |
| `lightsonly` | off | **A diagnostic: turn the bake off and the real lights up.** A Quake lightmap already contains every declared lamp at full strength, so a lamp's shadow only removes the 30% `maplights` adds on top and is invisible without diffing screenshots. This drops `lightmapintensity` and `sunlight` to 0 and raises `maplights` to 4 and `maplightpointshadows` to 2, so the only thing lighting the map is the thing casting the shadows. Each is still an ordinary parameter and an explicit one wins, so `?lightsonly&maplights=1` is a dimmer version of the same picture. Player and item models are lit from the light GRID rather than these lights, so they stay lit while the world goes dark — expected, and not what the mode is showing you. Not a setting: it is deliberately absent from Settings, because pinning a diagnostic in a URL is the whole point of one. |

`npm run light-pool -- --map q3dm6 --at 192,-888,200` prints what every
slot actually holds, which is the only way to tell an empty slot from a dim
one. See `.agent/docs/light-knobs.md` — including why reading the pool from a
backgrounded browser tab reports every light as dead.

The world **receives** shadows and by default does not cast them; models cast
and receive. A casting world renders the map again per shadowed light —
measured on q3dm6, 189 draws to 511 — and what a lightmap already contains,
baked, is exactly static geometry shadowing itself. `?worldshadows` turns it on
anyway, for the part a bake cannot have: geometry casting from a light that
moves.

---

## Shadows

`src/render/shadow-map.ts`, whose header carries the light-direction
measurements that chose these defaults.

| parameter | default | meaning |
| --- | --- | --- |
| `shadows` | `lights` | `lights`, `dynamic`, `blob` (Quake's own `cg_shadows 1`) or `off`. **`lights`** casts from lights that are actually somewhere — the map's declared `light` entities and the game's rockets and plasma. The grid-steered directional light is kept and still *illuminates* (it is ~9% of frame brightness); it just does not cast. **`dynamic`** lets it cast too, which was the default until 2026-09-03: its direction is sampled from the light grid at the player's own cell, so it leans as you move, and once `?worldshadows` let the architecture cast, the whole map swung with the player. It remains the mode that works on a map whose own lights are sparse, and it is what `?lit=off` falls back to, since an unlit material has no lights to cast from at all. `blob` and `dynamic` are exclusive: two shadows under one player double-darken and read as a bug. Under `?lit=off` the dynamic mode hand-patches a shadow term into each material; under a lit mode the material receives it natively and the hand patch is skipped — doing both is a WebGPU validation error, because the same shadow texture would be read and written in one scope. |
| `shadowstrength` | `0.35` | How dark a fully occluded pixel goes. Deliberately low, same argument as `ssaomax`. At this setting the shadow is genuinely hard to see on a bright floor — `?shadowstrength=0.9` is how to confirm it exists before concluding it does not. |
| `shadowextent` | `160` | Half-width of the shadow camera's box, in Q3 units. |
| `shadowsize` | `1024` | Shadow map edge length in texels. |
| `shadowelev` | `0.5` | Floor on the light direction's Z. Quake's lights are wall lamps, so grid directions are frequently near-horizontal, and a shadow cast along the floor is enormous and full of acne. Non-optional on de4th_run1, where a quarter of standable cells have the dominant light pointing *downward*. |
| `shadowdamp` | `250` | Direction damping time constant in ms. `0` shows what the raw grid direction does. |
| `shadowbias` | `0` | `LightShadow.bias`. |
| `shadownormalbias` | `4` | `LightShadow.normalBias`, in Q3 units. The better acne fix here — world surfaces carry real normals and a normal offset does not detach a shadow from its caster. |
| `sunlight` | `0.5` | How much the shadow-casting directional light ILLUMINATES, on top of driving the shadow map. **Also the lit pipeline's shadow depth** — a lit surface receives the shadow natively, and what a shadow removes is this light's contribution, so `?sunlight=0` turns dynamic shadows off with it. |
| `shadowdebug` | off | Draws the raw shadow term instead of the scene. White lit, black occluded, everything outside the shadow camera's box white because the frustum test says so. **`?lit=off` only** — it patches a `colorNode`, and a lit material does not go through that path. |

**`shadowstrength` and `sunlight` belong to different pipelines**, and the game
warns on the console if you set the one that does not apply:

| pipeline | shadow depth knob | why |
| --- | --- | --- |
| `?lit=off` | `shadowstrength` | The shadow is a hand-patched multiply into the material's `colorNode`, the only way to darken a material with no lights. |
| lit (default) | `sunlight` | The surface receives the shadow natively; a shadow is the *absence of the sun*, so its depth is the sun's contribution. |

`sunlight` was `1` — three's default, chosen when the light only had to point
somewhere and never revisited when the lit-material migration turned it into a
real contributor. At `1` it added `1/π = 0.32` of white to every surface facing
it: measured on q3dm6, mean frame brightness `52.0` with no sun against `61.1`
at `1`. `0.5` halves that wash and keeps a shadow that still reads — the two
cannot be separated with one directional light.

---

## Faithful vs. modern

Every modern effect is on by default. To turn the lot off and see what Quake
actually drew:

```
?lit=off&tonemap=off&ssao=off&aberration=0&motionblur=0&lavabloom=0&lavashimmer=0&fogfeather=0&fog=analytic&shadows=blob&water=faithful
```

The physics is unaffected by every parameter on this page except `physics`
itself. Nothing in the render layer can move an overbounce spot — that is what
the import boundaries in `eslint.config.js` are for.

---

## Open question

`?give=` grants a powerup, and a run made with one is recorded to personal bests
like any other. In a game whose product is comparable times, that is probably
wrong; the fix (a "tainted run" flag that suppresses the record) is not written
because it is a design decision rather than a bug.
