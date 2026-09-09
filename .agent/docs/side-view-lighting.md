# Lighting a side-view course: the faces the camera sees get no light by default

Found building `ob_crypt` (2026-09-09), the first course lit from scratch under
a dark sky (`skies/nitesky`, surfacelight 20, sun straight down).

The side camera sits at y = -520 looking toward +y, so what fills the screen is
every platform's **-y face** -- the vertical front of each block, the walls of
each pit, the stub the player lands on. A `light` entity placed the obvious way,
over the platform at y = 0, lights the *top* and the backdrop and leaves those
front faces black: a point light above and behind a face's plane contributes
nothing to it. The first `npm run shot` of the course showed every front face as
a black silhouette against a lit backdrop, with only the lava's own surface
light warming the bottom edges.

What worked:

- **A second row of lights in front of the course**, at y = -224 (between the
  clip corridor and the shell's near wall, well inside the sealed shell), one
  per platform or gap, `light 250`, same warm colour as the top row.
- **64 below each platform top**, not above it. The first placement (120 above
  the tops) still left the start floor's 256-tall face dark: a light above the
  top edge grazes the face at a steep angle. Below the top it shines straight at
  the face; the top row already covers the walking surfaces.
- Emissive panels on the backdrop (`gothic_light/ironcrosslt2_5000`,
  `q3map_surfacelight 5000`) and the lava sheet (`lavahell_simple`, 666) do real
  work in the lightmap: they are what makes the pits read as pits.

Verify with `npm run shot -- --map <name> --devpak <name>.pk3 --at x,0,z
--params camera=side`, not the editor: the editor's preview is unlit flat
shading and shows nothing about any of this.
