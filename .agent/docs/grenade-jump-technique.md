# Grenade jumps: the useful technique is inverted from rockets

Measured headlessly against this repo's own simulation (`src/game/weapons.ts`,
`src/game/missiles.ts`), same method as `physics-for-map-authors.md`'s rocket table:
a `Game` settled on a flat floor, one shot fired, apex tracked over 600 ticks.

| technique | rocket rise | grenade rise |
| --- | --- | --- |
| standing shot / drop-and-wait | 166 | **78** |
| jump, then fire | 368-381 | **72** |

For the rocket launcher, jumping before firing is strictly better (it's the
whole point of the "real technique" — see `physics-for-map-authors.md` section 4).
**For the grenade launcher, jumping first is very slightly worse.** Firing straight
down at your own feet while standing still and not moving again gives more rise than
jumping first.

This falls out of two differences between the weapons, not one bug:

- The grenade leaves the muzzle at only 700ups (vs. the rocket's 900) and follows a
  ballistic `TrType.GRAVITY` arc rather than a straight line, so it spends longer in
  flight and lands further from directly-beneath-the-player when the player has
  jump-added upward velocity at the moment of the shot — a bit of the muzzle's launch
  energy goes into carrying the grenade sideways/upward before it detonates, instead
  of it staying point-blank.
- `bounceHalf: true` — a grenade that doesn't detonate on contact bounces once and
  keeps going. Fired downward while airborne, it has more room (and time) to bounce
  away from the player before the fuse (2500ms) or a wall stops it, weakening the
  splash at detonation versus the standing case where it drops and stays essentially
  at the feet.

Net effect: **"drop it at your feet and don't move" is both the simplest grenade-jump
technique to teach and the best-performing one in this engine**, the opposite of the
rocket launcher's "jump then fire." `maps/ob_rockets.map`'s grenade station teaches
exactly this ("fire straight down and DON'T MOVE — the fuse launches you when it
pops"), sized to a 64-unit ledge (comfortable margin under the measured 78, well
above a plain jump's ~48.6).

Not yet measured: whether firing at a nearby WALL (not the floor) while grounded
beats the flat-floor number, or how sensitive the 78 is to a few ticks of movement
before the fuse pops. Both would need their own headless runs before being taught
as techniques.
