# A demo's rocket explodes now, and the bug only a real demo could find

What `CG_CheckEvents` actually takes to port, written down because reading the
function is not enough to port the function.

## The one-line version

**Entity numbers are recycled, so "did the event value change" is not a
sufficient dedup.** The rest of this file is why that costs you one explosion
in fourteen, silently, in the middle of a run.

## How an event reaches a demo at all

Two different ways, with two different dedup rules, and id uses one field for
both (`cg_event.c:1174`):

- **A freestanding event entity** (`eType > ET_EVENTS`) fires ONCE for the
  life of that entity number. The event number is `eType - ET_EVENTS`.
  `EF_PLAYER_EVENT` means it is about `otherEntityNum` rather than about the
  event entity itself.
- **An event riding an ordinary entity** (`es.event`) fires whenever the value
  CHANGES. `EV_EVENT_BITS` exists for exactly this: the server rotates two
  bits so the same event twice running arrives as two different numbers.

A rocket is the second kind, and how it gets there is worth knowing.
`g_missile.c:412-423` does not replace the missile with an explosion entity --
it sets `EV_MISSILE_MISS` on the missile and changes its `eType` to
`ET_GENERAL`. The missile BECOMES the explosion, keeping its `es.weapon`,
which is what `CG_MissileHitWall( es->weapon, ... )` reads to decide the mark,
the burst and the sound.

`eventParm` on an impact is `DirToByte(normal)`: an index into a 162-entry
table, not an encoding. `src/math/dirs.ts`.

## The bug

`coldrun`, the one real demo in the tree, scans as six distinct missile entity
numbers and **532 appearances** of `es.event == 51`. The ratio is the dedup
stated as data -- the event rides on the entity for as long as the server
keeps sending it, and the client fires it once.

Fourteen rockets actually explode in that demo. A first implementation fired
thirteen.

The missing one: entity number **148** is a rocket that explodes at 23.2s and
a different rocket that explodes at 32.5s, and **both carry the identical raw
event value 307** (`EV_MISSILE_MISS` with one `EV_EVENT_BIT` set). The server
had no reason to rotate the bits -- nine seconds and a different entity
lifetime apart, there was nothing to disambiguate from. So "did the value
change" says no, and the second explosion never happens.

id does not have this problem because of a line in a **different file**:
`CG_ResetEntity` (`cg_snapshot.c:36`) clears `previousEvent` once the entity
has been absent for `EVENT_VALID_MSEC` (300, `bg_public.h:345`), and nine
seconds is comfortably more than that.

**Reading `CG_CheckEvents` is not enough to port `CG_CheckEvents`.** The rule
lives in the function that resets the state, not in the one that reads it.

## Two more things that are easy to get wrong

**Walk every snapshot the playhead crossed, not just the one it landed on.**
The POV's own events survive a skipped snapshot because they arrive in a ring
indexed by a sequence number, so a comparison of sequences spans any gap. An
entity event has no sequence -- it is a value sitting on an entity, and the
only way to see one that appeared and went again is to look at the snapshot it
was in. `coldrun` is 125Hz; a 60fps frame crosses two of its snapshots, so
reading only the second drops about half the events in every recording. The
failure looks like an unreliable renderer, not like a skipped read.

A scrub crosses thousands, so the walk is capped (`MAX_EVENT_CATCHUP`, 16) and
re-baselines silently past it -- the same thing the first sample of a fresh
clip does, for the same reason.

**A decal is state and a sound is an event.** `playEvents` returns early on
`emit === 'off'`, which is right for something that is only ever sound and
would drop every explosion mark on a scrub. Entity events go through
`playEntityEvents` instead, which stamps the mark and the burst unconditionally
and gates only the sound -- the rule `playFx` already documents for a ghost.

## How to check any of this yourself

```bash
npm run demo-info -- <file.dm_68> --scan      # every snapshot, by eType and event
OB_DEMO=<file.dm_68> npm run test:demo        # the walk against the file
```

`--scan` was added for exactly the question this file answers, and it answers
a second one before you write anything: **a solo DeFRaG run contains no second
player and no mover at all**, so anything built to draw those cannot be
verified against it. `test/demo/demo-writer.ts` builds fixtures from the same
tables `src/demo/` decodes with, so a green `npm run test:demo` would not
notice either.

The split that works: a **real** demo proves the decode, which a synthetic one
never can; a **synthetic** demo on a map this project actually ships reaches
the renderer, which a real demo of `coldrun` cannot.
