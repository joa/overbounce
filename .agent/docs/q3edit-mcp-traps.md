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
- **The compiler reads OpenArena's shader scripts** (`oa_fogs.shader`,
  `oalite.shader`, `oasfx.shader` are in its shaderlist), so an OpenArena-only
  fog or light shader compiles as what it is. "Couldn't find image for shader"
  for a sky, fog or flame shader is expected and harmless.

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
