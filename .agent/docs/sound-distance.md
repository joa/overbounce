# Sound distance attenuation

Found 2026-09-09: a plasma bolt landing at the far end of a map played at
the same volume as one landing at the player's feet. Doors and `shooter_*`
entities had distance scaling; explosions, grenade bounces, bullet
ricochets and item respawns did not. Every one of those carries its origin
in the `GameFrame`, so the fix was plumbing, not simulation.

## The curve is now a port

`distanceVolume` in `src/audio/sound.ts` used to be a project-invented
linear falloff to 1800 units, honestly labelled "not a port". Quake's own
is in `client/snd_dma.c`, which was not in `refs/` until now -- it is in
the manifest as of this change, along with `snd_local.h` and
`snd_public.h`. `S_SpatializeOrigin` (snd_dma.c:445):

```c
dist = VectorNormalize(source_vec);
dist -= SOUND_FULLVOLUME;        // 80, snd_dma.c:56
if (dist < 0) dist = 0;          // close enough to be at full volume
dist *= dist_mult;               // SOUND_ATTENUATE 0.0008f, snd_dma.c:58
scale = (1.0 - dist) * rscale;
```

Flat to 80 units, then linear to silence at 80 + 1/0.0008 = 1330. That is
shorter than the old 1800, so far doors are now quieter than they were.
`test/audio/distance.test.ts` pins the constants and three points on the
line.

## Design decisions, and why

- **The listener is the player, not the camera.** Quake's listener is the
  view entity's origin: `trap_S_Respatialize( cg.snap->ps.clientNum,
  cg.refdef.vieworg, cg.refdef.viewaxis, inwater )` (cg_view.c:840), which
  in first person is the player's eye, and whose `entityNum` is what
  snd_dma.c:1091 exempts from attenuation. Overbounce's camera sits
  hundreds of units to the side, so using it would make the player's own
  world sound distant while a wall between the two heard nothing. The ear
  is `game.ps.origin`, set once per physics tick via `sound.setListener`.
- **The player's own sounds are never attenuated.** snd_dma.c:1091:
  "anything coming from the view entity will always be full volume". So
  the gun, footsteps, voice, jump pads, teleports and pickups pass no `at`
  and play as before. Only sounds with a position in the world do.
- **Stereo panning is not ported.** The other half of `S_SpatializeOrigin`
  splits left/right by the dot against the listener's right axis. With a
  side camera the player's facing and the screen's left/right are
  unrelated, so panning by the player's yaw would put an explosion on the
  wrong side of the screen half the time, and panning by the camera would
  be an invention. Mono, attenuated, is the honest subset.
- **Out of earshot is not played.** Quake mixes it at zero volume. Not
  starting the source is the same to the ear and saves the node.
- **A sound with a position and no listener yet is full volume.** The
  listener is set per tick; before the first tick nothing positional can
  fire, but the fallback is "loud" rather than "silent" on purpose -- a
  missing `setListener` should be audible as a bug, not hide as quiet.

## Not done

- `target_speaker`. A triggered one is positional in Quake
  (`EV_GENERAL_SOUND` at the entity) unless its GLOBAL spawnflag is set;
  the `CourseEvent` for it carries no origin yet, so it still plays full.
  Wiring it means adding the entity origin to that event.
- Looping sounds (`S_AddLoopSounds`): a rocket in flight, a hum. Not played
  at all here; the flyby one-shot near the player stands in for the rocket.
