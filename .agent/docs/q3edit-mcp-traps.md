# q3edit MCP: traps that cost a round trip

Collected building `ob_grounds` (2026-09-14). Each one failed a call once; none
of them is in the tool descriptions. The older ones (numeric refs shifting after
an entity delete, `map_capabilities` reporting the compiler unavailable while
`map_compile` works, black `map_play` frames) are in `.claude/agents/map-author.md`
section 7 and the `OB-ROCKETS`/`OB-CRYPT`/`OB-YARD` plans.

## Operation fields

- **`map_preview` and `map_apply` require `label`.** Without it the call is
  rejected by input validation before anything is checked.
- **`delete` takes `targets`, an array** (`{"type":"delete","targets":["E0:B21"]}`),
  not `target`. `set_entity_properties` is the one that takes a single `target`.
- **Brush deletes are safe to batch with creates.** A delete of worldspawn
  brushes (`E0:Bn`) followed only by `create_*` operations in the same batch
  never touches a numeric ref after the delete, so nothing shifts. The result
  lists the shifted indices under `changed`; the brush count is the check.
- **`create_box` face order is F0 +X, F1 -X, F2 +Y, F3 -Y, F4 top, F5 bottom**
  (read off `map_inspect` with `includeGeometry`, `ob_strafes` 2026-09-14). F3,
  the MIN-y face, is the one a side camera on -Y sees; F2 is the back. A batch
  that caulked "F3 as the back face" hid every visible front and had to be
  undone. Check one brush's face points before any face-indexed batch.
- **`offset_faces` uses the same face order**: F0 is +X. `ob_circuit` moved
  a finish floor's far end instead of its near edge by guessing F0 was -X;
  `map_preview` returns no bounds, so apply and `map_query` the bounds before
  saving.
- **`map_undo` needs `expectedRevision` and does not save.** After
  apply -> `map_save` -> undo, the `.map` on disk still holds the undone
  revision until the next `map_save` (`ob_circuit`, 2026-09-14). Save after
  every undo.
- **Refer to an object from an earlier batch by its numeric ref**, read from
  that batch's `aliases` output and valid only while no delete has happened
  since. Whether an `@id` from an earlier batch still resolves was not tested.

## Compiling

- **`map_compile`'s `artifactPath` directory must already exist.** A path into a
  directory that does not fails with `ENOENT` on the `.tmp` file it writes
  first; create the directory and compile again.
- **A full compile's result is too large to return inline** (~130 KB of
  q3map/bspc output). It is saved to a file; read `success`, `leaked`, `stages`
  and the `fogs` / `light emitting surfaces` lines out of it with a script.
- **`ClipWinding: MAX_POINTS_ON_WINDING` in `FilterDrawsurfsIntoTree` is a
  long face collecting T-junction verts** (`ob_strafes`, 2026-09-14). A
  12246-long architrave beam had sixteen column capitals under it, each exactly
  as deep in y as the beam, so every capital's corners lay on the beam's bottom
  face edges; `FixTJunctions` added four verts per capital and the winding
  passed q3map2's 64 points. Split long drawn brushes into segments no longer
  than the spacing of whatever abuts them, or make the long brush a few units
  wider than the pieces touching it so their corners are not on its edges (both
  were done; a fast compile confirms the BSP stage in seconds).
- **`map_compile` has a hard 180 s editor request timeout, and a timed-out
  compile writes nothing** (`ob_strafes`, 2026-09-14: 155 brushes, 95 of them
  detail, 44 lights, 188k lightmap texels at `_lightmapscale 2`). The call
  fails after exactly 180 s with `Editor session <id> request <id> timed out`
  (the activity log records `durationMs` 180053 and 180063); the artifact had
  not been written 9 minutes after the call started, so do not count on the
  browser delivering later. Firing another compile straight after a timeout
  dropped the MCP transport twice ("transport dropped mid-call"); the session
  came back on its own. For scale, the same course at 45 brushes and 81k texels
  lit in 53 s in the browser, single-threaded. `fast` (no VIS, no LIGHT) still
  returns in under a second and is how to check the BSP stage.
- **When the browser compile cannot finish, a local q3map2 can.** What it took
  with NetRadiant's q3map2 2.5.17 (`q3map2 -help` prints the stages):
  - A basepath holding `baseq3/pak0.pk3` copied from `assets/pk3/oa-pak0.pk3`
    (the browser compile reads exactly that pak's shader scripts) plus
    `assets/oa/textures` and `assets/oa/env` copied to `baseq3/`. Without the
    images q3map2 warns "Couldn't find image" for every gothic texture, and it
    bakes texcoords from the image size it loads (see "Texture projection").
  - An empty `baseq3/scripts/quark.shader`: OpenArena's `shaderlist.txt` names
    it, the pak does not carry it, and q3map2 stops with
    `Script file scripts/quark.shader was not found`.
  - The saved `.map` with every `"_q3edit_*"` key line removed. The
    `_q3edit_release` value is JSON with escaped quotes, and q3map2 stops with
    `ParseEPair: token too long`. The `// q3edit-*` comment lines are harmless.
  - `-meta -keeplights -leaktest` on the BSP stage (the committed `ob_crypt` and
    `ob_grounds` BSPs keep their lights), then `-vis -saveprt`, then `-light`.
  - Pass `-threads` explicitly; it started with 1.
  - It writes no `.aas` (no BSPC stage). The `.aas` is gitignored and the game
    does not read it.
  Keep the exe and the basepath outside the repository.
- **The compiler reads OpenArena's shader scripts** (`oa_fogs.shader`,
  `oalite.shader`, `oasfx.shader` are in its shaderlist), so an OpenArena-only
  fog or light shader compiles as what it is. "Couldn't find image for shader"
  for a sky, fog or flame shader is expected and harmless.

- **A `full` compile's result is too big to return.** At ~80k lightmap
  texels the output exceeds the tool-result limit and is written to a JSON
  file; read `success`, `stages`, `leaked`, `diagnostics` and the
  `=== Stage` lines out of it with python instead of paging it.
- **`full` fits under the 180 s limit at this size.** `ob_circuit`: 83 brushes,
  63 lights, 79.7k exact lightmap texels; BSP 0.5 s, VIS 3.2 s, LIGHT 74.6 s
  through the MCP, no local q3map2 needed. A `fast` compile's output is also
  ~40 KB of progress counters in context; compile only when a check needs it.

## Texture projection

- **`fit` fits the editor's preview size, the compiler bakes its own.** The
  texcoords in the BSP come from the image size q3map2 loads; the preview the
  editor fits against can differ. `gothic_door/tim_dmarch01` fitted to a
  224-wide face showed half an arch in the game, and
  `gothic_door/xian_tourneyarch_tall2b` at the "correct" 0.25 for its 640x1536
  OpenArena file tiled twice. What worked: leave the default projection (scale
  0.5, offset 0) and size and place the brush so the face spans exactly one
  repeat on world-aligned coordinates (tall2b: 160x384 faces on multiples of
  160 in x, z 0..384). `edit_faces` `scale` is a relative multiplier
  (`[0.5,0.5]` halves the current value); read the result with `map_inspect`
  `includeFaces`.
- **A sky whose second stage is `blendfunc filter` drew as its first stage
  alone** (`skies/nightsky_xian_dm1`: a flat blue `pjbasesky`). `skies/moonsky`
  (additive stages) renders as intended. Check a sky in a shot before choosing
  it.

## Shots for a course

- **`npm run shot`'s `hideHud` hides only the hint line.** For a levelshot with
  no HUD, pass `--width 1536 --height 864` (the size of the existing
  `levelshots/*.jpg`) and hide the overlay through `--eval`:

  ```bash
  npm run shot -- --port 5173 --map <course> --devpak pak0.pk3,<course>.pk3 --player sarge \
    --at x,0,z --width 1536 --height 864 --params camera=side \
    --eval "(() => { for (const e of document.querySelectorAll('body *')) { const c = String(e.className || ''); if (/\bob-/.test(c) && e.tagName !== 'CANVAS') e.style.visibility = 'hidden'; } return 'hidden'; })()" \
    --out shots/<course>-levelshot.png
  ffmpeg -y -i shots/<course>-levelshot.png -q:v 4 levelshots/<course>.jpg
  ```

  The eval runs before the capture, so the picture has no HUD.
- **Mount the start pak for a player model**: `--devpak pak0.pk3,<course>.pk3`.
  With the course pak alone the player is a placeholder box and the impact art
  warns as missing.
