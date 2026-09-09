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
- **Stereo panning is ported, on the camera's axis.** The other half of
  `S_SpatializeOrigin` (snd_dma.c:464-485) rotates the source direction
  into `listener_axis` and takes `dot = -vec[1]` -- `axis[1]` is LEFT
  (`AnglesToAxis`, q_math.c:471), so this is the dot against the listener's
  right -- then `rscale = 0.5(1+dot)`, `lscale = 0.5(1-dot)`, clamped at 0.
  Linear, not equal-power: centre is half per ear, hard right is one ear at
  full and the other silent. `panScales` and `listenerPan` in `sound.ts`
  are those two steps.

  The axis is the CAMERA's right, not the player's: with a side view the
  player's facing and the screen's left/right are unrelated, and panning by
  the player's yaw would put an explosion on the wrong side of the screen
  half the time. What the viewer sees on the right is in the right ear. In
  first person the camera's right IS the player's, which is exactly Quake's
  `cg.refdef.viewaxis`. The ear's position stays the player's; only the
  orientation is the camera's: the rendered camera's own +X, rotated by
  `r.camera.quaternion` and mapped back to Quake axes. NOT `cam.pose` --
  that is the side camera's state and stands still in chase and first
  person, which is how the first cut shipped panning that only worked in
  side view (reported the same day as "panning seems static"). Photo
  mode's free camera and first person's roll come for free this way.

  One number is not Quake's: `STEREO_COMPENSATION` doubles both ear gains.
  Quake's centre is 0.5 per ear, and every per-sound volume here was tuned
  against a mono source feeding both channels at 1.0, so the verbatim
  scales would have made the whole game 6dB quieter the day panning
  arrived. Doubling keeps a centred sound where it was and leaves the ratio
  Quake's -- a hard-panned sound is twice a centred one in its ear.

  Mechanically it is two `GainNode`s into a `ChannelMergerNode`, not a
  `StereoPannerNode`: the panner's equal-power law is a different curve.
  The player's own sounds (no `at`) bypass the split entirely.
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
- Hums: the railgun's `rg_hum`, the BFG's. Weapon ready loops are not
  played.

## Missiles in flight (added 2026-09-09)

`CG_Missile` (cg_ents.c:449-455) re-issues `trap_S_AddLoopingSound` for a
missile every frame with its position and `BG_EvaluateTrajectoryDelta`
velocity; `S_AddLoopSounds` spatialises each from the listener at master
volume 127, the same as a one-shot. The rocket's sound is `rockfly.wav`
(cg_weapons.c:744), the plasma bolt's `lasfly.wav` (:795); the grenade
launcher registers none. `MISSILE_SOUNDS` in `sound.ts` is that table, and
`main.ts` keeps one `LoopHandle` per live missile, driving its gain by
`distanceVolume` and stopping it when the missile leaves `game.missiles`.
This replaced the one-shot "flyby" that used to fire at closest approach.

**Doppler is ported, and it is not doppler.** `s_doppler` defaults on
(snd_dma.c:148) and `S_AddLoopingSound` computes

```c
lena = DistanceSquared(listener, origin);
lenb = DistanceSquared(listener, origin + velocity);
dopplerScale = lenb / (lena * 100);
if (dopplerScale <= 1.0) doppler = qfalse;
```

which the mixer (snd_mix.c:393) uses as a playback-rate multiplier. It
exceeds 1 only when the missile's position one second from now is more
than ten times as far from the ear as its position now: moving AWAY, and
close. An approaching missile is never pitch-shifted, and a bolt leaving
the muzzle at 2000ups is sped up by a large factor for the few frames it
is within ~200 units, then settles to 1x. Physically backwards; it is the
zip you hear when you fire a plasma gun in Quake, and it is kept as
written. `snd_mix.c` joined the manifest so the rate interpretation is
checkable. `dopplerScale` in `sound.ts` is the pure function;
`test/audio/distance.test.ts` pins its behaviour at both ends.

Two WebAudio-side choices with no Quake equivalent: gain and rate move
through `setTargetAtTime` with a 10ms constant, because stepping a node's
value at 60Hz clicks; and a paused game mutes a loop rather than stopping
it, so the missile's sound resumes with the missile.
