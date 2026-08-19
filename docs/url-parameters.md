# URL parameters

All 39 of them, enumerated mechanically from the source rather than from memory:

```bash
grep -rhoE "\b(get|has)\('[a-z0-9_]+'\)" src/ | sed -E "s/.*'(.*)'.*/\1/" | sort -u
grep -rhoE "params, '[a-z0-9_]+'" src/ | grep -oE "'[a-z0-9_]+'" | tr -d "'" | sort -u
```

Anything not listed here is either not a parameter or has been added since; the
two commands above are the source of truth, not this file.

An unrecognised **value** warns on the console and keeps the default rather than
throwing, because a typo in a URL should not be a blank screen. An unrecognised
**parameter name** is silently ignored — the browser has no way to tell one from
a tracking token.

---

## Loading

| parameter | default | meaning |
| --- | --- | --- |
| `devpak` | — | `.pk3` under `public/` to mount. Built by `npm run build-devpak` from your own Quake III install. |
| `map` | first in the pak | Which map in the mounted paks to load, without the extension. |
| `player` | `doom/phobos` | Player model, as `model` or `model/skin`. Falls back with a console warning listing what is available. |

## Where you start

| parameter | default | meaning |
| --- | --- | --- |
| `at` | the map's spawn | `x,y,z` or `x,y,z,yaw` in Quake units. Drops the player there instead of at an `info_player_deathmatch`. |
| `physics` | `vq3` | `vq3` or `cpm`. VQ3 is the mode with the fidelity guarantee; CPM is reconstructed from community-documented behaviour and GPL reimplementations. |
| `camera` | `chase` | `chase` or `side`. |

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
| `tonemap` | `agx` | One of `none`/`off`, `agx`, `neutral`, `aces`, `cineon`, `reinhard` — the keys of `TONE_CURVES` in `post.ts` and nothing else. `?tonemap=off&ssao=off&aberration=0` is the faithful configuration. |
| `exposure` | `1.6` | Linear exposure applied immediately **before** the tone curve, and only when there is one. Quake's content is display-referred, so a scene-referred curve like AgX never leaves its toe without this. |
| `fxaa` | on | Runs after the sRGB encode, which is why the chain does tone mapping explicitly rather than through the pipeline's appended transform. |
| `aberration` | `0.1` | Radial chromatic aberration. `0.1` is 1.4 pixels at the edge of a 1280-wide frame and exactly nothing at the crosshair. `0` removes the stage. |
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

### Lava

Neither effect is Quake — see `src/render/lava.ts`. Both are switchable because
this is a speedrunning game and anything that blooms into a doorway or wobbles a
ledge edge costs the player information they navigate by.

| parameter | default | meaning |
| --- | --- | --- |
| `lavabloom` | `1` | Bloom strength, `0..1`. `0` removes the stage. `0.35` is the conservative setting. |
| `lavabloomradius` | `0.12` | Spread, in fractions of screen height. |
| `lavashimmer` | `0.007` | Peak heat-haze displacement in UV units. `0` removes the stage. Was `0.0025` and invisible — 1.8 pixels on a noise texture is not an effect. |

---

## Shadows

`src/render/shadow-map.ts`, whose header carries the light-direction
measurements that chose these defaults.

| parameter | default | meaning |
| --- | --- | --- |
| `shadows` | `dynamic` | `blob` (Quake's own `cg_shadows 1`), `dynamic` (a real shadow map steered by the light grid), or `off`. The two are exclusive: two shadows under one player double-darken and read as a bug. |
| `shadowstrength` | `0.35` | How dark a fully occluded pixel goes. Deliberately low, same argument as `ssaomax`. At this setting the shadow is genuinely hard to see on a bright floor — `?shadowstrength=0.9` is how to confirm it exists before concluding it does not. |
| `shadowextent` | `160` | Half-width of the shadow camera's box, in Q3 units. |
| `shadowsize` | `1024` | Shadow map edge length in texels. |
| `shadowelev` | `0.5` | Floor on the light direction's Z. Quake's lights are wall lamps, so grid directions are frequently near-horizontal, and a shadow cast along the floor is enormous and full of acne. Non-optional on de4th_run1, where a quarter of standable cells have the dominant light pointing *downward*. |
| `shadowdamp` | `250` | Direction damping time constant in ms. `0` shows what the raw grid direction does. |
| `shadowbias` | `0` | `LightShadow.bias`. |
| `shadownormalbias` | `4` | `LightShadow.normalBias`, in Q3 units. The better acne fix here — world surfaces carry real normals and a normal offset does not detach a shadow from its caster. |
| `shadowdebug` | off | Draws the raw shadow term instead of the scene. White lit, black occluded, everything outside the shadow camera's box white because the frustum test says so. |

## Powerup glow

| parameter | default | meaning |
| --- | --- | --- |
| `quadglow` | `1` | Scales the additive glow volume around a powerup carrier — Quad, battlesuit and regeneration all have one, in the colour of their own shell shader. `0` removes them; a negative or non-numeric value warns and keeps the default. Named for the Quad because that is the one anyone asks about. An addition, not Quake — see `src/render/powerup-glow.ts` for why it is a sphere and not a `THREE.PointLight`. |

---

## Faithful vs. modern

Every modern effect is on by default. To turn the lot off and see what Quake
actually drew:

```
?tonemap=off&ssao=off&aberration=0&lavabloom=0&lavashimmer=0&shadows=blob&quadglow=0
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
