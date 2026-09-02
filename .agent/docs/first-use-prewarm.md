# First-use hitches, and the warm-up frame that removes them

Written 2026-09-02, when "the first rocket of a session visibly hitches, and
so does the first look at a portal" was reported and fixed. Read this before
adding a new pooled visual or a new render pass — both have a first-use cost
that is invisible in code review and absent from every headless gate.

## The mechanism

three's WebGPU backend builds a material's WGSL (the TSL node-graph codegen,
on the main thread) and creates its render pipeline **at the material's first
actual draw**. Two things keep a draw from happening at load:

1. **`visible = false`.** Every projectile visual in this project is a pool
   constructed hidden: the missile holders, the rocket and grenade MD3
   clones, the plasma sprite, `effects.ts`'s two particle pools,
   `explosion-fx.ts`'s sprites, `decals.ts`'s mark rings, the ghost box.
   None of their pipelines exist until the first shot of the session makes
   one visible — mid-play, all at once. That was the first-rocket hitch.
2. **A pass that has not run yet.** A pipeline is compiled per render-target
   configuration, so the portal pass's three-attachment 512² target needs a
   SECOND pipeline for **every material in the map** — and `portal-pass.ts`
   only renders when the player is in front of the surface and within 256
   units. First approach to the portal used to recompile the whole world.
   That was the first-portal-look hitch. (The target's GPU textures were
   also allocated lazily, on the first `setRenderTarget`.)

Audio is NOT part of this: fire/explode/flyby sounds were already decoded
ahead of time by the `sound.preload` call on the pointer-lock click.

## The fix (`src/render/prewarm.ts`, wired in `main.ts` just before the loop)

One warm-up frame per course load, rendered while `showLoadingScreen`'s
opaque overlay still covers the canvas (`runCourse` has not resolved, so
`loading.dispose()` has not run — nothing of it is ever seen):

1. `await showWeapon(game.weapon)` — the held gun otherwise attaches lazily
   a few frames into play.
2. `showEverythingForWarmup(r.scene)` — every hidden object made visible and
   frustum culling suspended (an off-screen pool must not dodge the
   compile), with the previous value of each flag recorded.
3. `portalPass?.warm()` — the portal view once, from a synthetic viewer 64
   units in front of the surface, bypassing the facing/range culls. Runs
   while the pools are visible, so their materials compile against the
   portal target too. Leaves a real image in the target; the next culled
   frame's `clearIfStale` blanks it as usual.
4. `waterReflection?.warm()` — the water's mirror view once, from wherever
   the camera is, bypassing its frustum and front-side culls. Same reason as
   the portal: its target is a third pipeline configuration (added
   2026-09-02, `water-reflection.ts`).
5. `r.render()` — the main pass through the real post chain.
6. Restore every flag exactly.

## Three constraints that are load-bearing

- **Lights are never touched.** three hashes a light's `visible` into the
  material light configuration; flipping one forces the very recompiles this
  exists to avoid. The pools already keep lights visible at intensity 0
  (`scene-lights.ts`'s parking note) — pre-warmed by construction.
- **Restore must be exact, per object,** not "hide what we showed" by
  guessed defaults: the grenade clone inside a rocket-showing holder and the
  FPV-hidden player model are semantically hidden, and `decals.ts` sets
  `frustumCulled = false` on purpose (identity-matrix meshes). Covered by
  `test/render/prewarm.test.ts`.
- **The warm frame must use the real passes.** `renderer.compileAsync` or a
  render into some scratch target warms the wrong pipeline configurations;
  the portal target and the post chain's scene pass each need their own.

## What this does NOT cover

- Anything loaded lazily AFTER the warm frame: the ghost avatar
  (`requestGhostAvatar`, on first ghost start) and weapon models other than
  the spawn weapon (first pickup/switch). Both are single models whose
  materials mostly match already-compiled player-model pipelines; if either
  is ever reported as a hitch, extend the warm-up rather than re-diagnosing.
- Browsers/drivers that evict pipeline caches under memory pressure — the
  warm-up is per course load, not per session, which also means re-entering
  a map pays only for what three's own caches dropped.
- Nothing here is measurable by the headless gates:
  `.agent/docs/perf-gate-findings.md`'s instruments never see a first-use
  stall because they measure steady state. Verifying a regression here means
  a DevTools performance capture of the first shot / first portal approach
  on a fresh page load.
