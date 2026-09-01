# Bundling the three DeFRaG courses

Written 2026-09-01, when `de4th_run1`, `de4th_run2` and `acc_fuzzle` went from
"downloaded for tests" to "mounted by course select on a clean clone".

## Why these three and not others

They come from <https://github.com/Yann39/quake3-defrag-maps>, whose author
built the maps himself in 2004 and licensed the repository **GPL-3.0**. That is
the whole reason they can ship: every other community DeFRaG map this project
touches (`mega_rl`, `dfwc2021-7`) has no published per-file licence, so those
stay downloads and never enter `BUNDLED_PAKS`.

The licensing consequence is in NOTICE and is not subtle: a distribution that
includes these maps is GPLv3 as a whole. The code stays GPLv2-or-later, and
dropping the three entries from `BUNDLED_PAKS` and the manifest is all it takes
to build a v2-only distribution.

## How they are packaged

Not committed. `.gitignore` blocks `*.pk3` wholesale and that has not changed;
`tools/assets.manifest.json` fetches each `.pk3` straight into `public/`, which
is where the game serves it from, and `npm run download-assets` on a clean
clone is what puts them there. The same rule as every other fetched asset.

`BUNDLED_PAKS` (`src/ui/screens/course-select.ts`) mounts them, with
`pak0.pk3` — the OpenArena start pak — last, since it is a fallback rather than
a course.

## The texture gap, measured

The maps name **retail baseq3** textures. OpenArena replaces many of those with
its own free art under the *same path*, which is what makes a GPL-only bundle
possible at all; it does not replace all of them.

Measured by parsing each `.bsp`'s shader list and resolving every name against
the mounted set (start pak + the map's own `.pk3`), counting a name as resolved
if a `scripts/*.shader` declares it or an image file exists, and ignoring
`textures/common/*`, which never renders:

| map | shaders | unresolved before | after |
|---|---|---|---|
| de4th_run1 | 42 | 24 | 18 |
| de4th_run2 | 42 | 4 | 2 |
| acc_fuzzle | 64 | 9 | 7 |

The eight textures that closed that gap are in the manifest as
`oa-texture-*` and go into `public/pak0.pk3` via `MAP_TEXTURES` in
`tools/build-startpak.ts` — the start pak rather than a per-map pak, because
the map archives are third-party files this project does not rebuild, and every
course mounts the start pak anyway.

**What is still unresolved, and why it is staying that way.** Each name below
was probed against `openarena.ws/svn` as `.jpg`, `.tga` and `.png`; all
returned 404. OpenArena simply never made an equivalent.

- `models/mapobjects/*` skins — teleporter, lamps, skull, skel, kmlamp,
  wall_lamp3, flare03. These are `misc_model` geometry baked into the BSP at
  compile time, so they really are world surfaces and really do draw
  untextured; they are decoration, not course.
- `textures/gothic_trim/border10`, `border11`, `textures/base_trim/border11light`
- `textures/sfx/metalfloor_wall_5bglowblu`, `textures/skies/toxicsky`,
  `textures/skies/xblacksky` — shader *definitions* in baseq3's scripts, not
  plain images, so even a same-named OA file would not have been enough.
- `textures/costanza1/cretebase2`, `textures/evil7/e7panelwood`,
  `e7panelwood2`

A player who mounts their own Quake III `pak0.pk3` gets all of these back for
free: `Pk3FileSystem` ranks a player's archive above the bundled fallback by
group, so nothing here needs to know whose file is whose.

## Re-measuring

There is no committed tool for this — it was a throwaway script. To redo it:
mount `public/pak0.pk3` at `PakGroup.Fallback` and the map pak at
`PakGroup.Base`, `parseBsp` the `.bsp`, then for each distinct
`bsp.shaders[].shader` check `fs.findImage(name)` and whether any mounted
`scripts/*.shader` declares the name. Skip `textures/common/`.
