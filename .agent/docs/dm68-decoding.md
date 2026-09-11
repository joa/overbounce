# Decoding `.dm_68`, and the four ways to get it silently wrong

Written 2026-09-10, while building `src/demo/`. The plan is
`.agent/plans/PLAYBACK.md`; this is the part worth keeping when that plan is
finished and closed.

## The failure mode is never an error

Every trap below produces a decode that *succeeds*. The file parses, the
snapshot count looks plausible, entities appear. What comes out is nonsense at
coordinates that look like coordinates. So the debugging instinct — "it threw,
find the throw" — does not apply, and the only reliable signal is whether the
decoded data is internally consistent in ways garbage cannot be.

The check that settled it here, and the one to reach for again: find a
mid-run snapshot and read every field of it *together*. In the sample DeFRaG
demo, at serverTime 23832 the POV holds `weapon 5` (WP_ROCKET_LAUNCHER), plays
`torsoAnim 135` (TORSO_ATTACK + `ANIM_TOGGLEBIT`), is pitched 86° down, has
`groundEntityNum 1023` (airborne), is climbing at +1364ups, and has 7 rockets
in `ammo[5]`. That is a rocket jump, and six independent fields agree it is.
No shifted table produces that.

`npm run demo-info -- <file> --entities` exists to make this a one-liner.

## 1. The netfield tables ARE the wire format

`entityStateFields[]` (51 entries) and `playerStateFields[]` (48) in `msg.c`.
A delta message says how many fields changed (`lc`) and then writes exactly
that many change bits *in table order*. Move one line and every subsequent
field reads the wrong bits.

They are extracted mechanically by `tools/gen-netfields.py` rather than
transcribed, and the generator asserts both counts. Transcribing 99 entries by
hand is precisely what CLAUDE.md's "every one that got through was written
from recall" is about.

## 2. The two delta readers look identical and are not

|  | entityState | playerState |
| --- | --- | --- |
| float field | zero bit, then integral-vs-full bit | integral-vs-full bit only |
| integer field | zero bit, then the value | the value, no zero bit |
| arrays | none | stats/persistant/ammo/powerups, separately |

Sharing an implementation between them, or writing the second from memory of
the first, desynchronises the bitstream by one bit per zero-valued field —
which is most fields, most of the time.

## 3. Packet entities are a sorted MERGE, not a list

`CL_ParsePacketEntities` reads ascending entity numbers, and every number in
the *old* snapshot that the new one skips past is implicitly unchanged and
must be carried over. Reading only the numbers that appear on the wire gives a
snapshot missing every entity that did not move — which, on a speedrun map, is
almost all of them. The symptom is a world that empties out as playback runs.

## 4. Delta parents are addressed by the FILE's sequence numbers

Each demo message is framed `int seq, int len, bytes`. A snapshot's `deltaNum`
is an offset back from *that* sequence number, resolved in a 32-entry ring. So
the framing header is not skippable metadata — drop it and nothing after the
first uncompressed snapshot decodes. It also means decoding is strictly
sequential and one-pass; there is no seeking into a demo file, only into the
expanded array afterwards.

## What the file does not tell you

- **The protocol is not in the stream.** It comes from the extension
  (`.dm_68`). `CS_SERVERINFO` happens to carry a `protocol` key on the demos
  seen so far, which is worth cross-checking against — a mismatch means the
  wrong tables, i.e. exactly the silent failure above — but it is a check, not
  a source.
- **`sv_fps` is routinely absent, and 20 is the wrong default.** The sample
  DeFRaG demo runs at 125Hz (`defrag_svfps 125` in `CS_SYSTEMINFO`, 8ms
  between every one of its 5738 gaps). Measure the rate from the modal gap
  between snapshots instead; `demoMeta` does.
- **VQ3 vs CPM is usually unknowable.** `df_promode` (DeFRaG) or
  `server_promode` (CPMA) in the serverinfo, and plenty of servers publish
  neither. `unknown` is a real answer and worth surfacing as one — this
  project's VQ3 claim is a fidelity guarantee earned by porting id's source,
  and quietly defaulting an unlabelled demo to VQ3 would launder a guess into
  it.
- **The filename time is not the duration.** `coldrun[df.vq3.tr]00.06.536(q3a)`
  names a 6.5-second *run* inside a 45.9-second demo that also holds the walk
  to the start line and everything after the finish.

## `ps.events` is a ring, not a list

Two slots, indexed by `eventSequence`. A slot KEEPS its value until something
overwrites it, so reading both slots on every rendered frame fires the same
jump once per frame -- three times per snapshot at 60fps against a 20Hz demo.
`CG_CheckPlayerstateEvents` (cg_playerstate.c) is the rule: walk the sequence
numbers this snapshot covers, and fire one only when it is genuinely new
(`i >= ops->eventSequence`) or when the slot contents changed under a sequence
number the previous snapshot also covered. This one shipped as a bug and was
caught in review, not by a test -- the test came after.

## `EV_EVENT_BITS` has to be masked off, and not masking it broke more than it looked like

Found 2026-09-11 while adding pickup sounds, and it had been silently wrong
for everything else that reads a demo's events.

`G_AddEvent` (`g_utils.c:584-585`) does not store the event number. It stores
the event number OR a two-bit repeat counter:

```c
bits = ( bits + EV_EVENT_BIT1 ) & EV_EVENT_BITS;
ps->externalEvent = event | bits;
```

The counter exists so that the SAME event raised twice in a row still looks
like a change to a client diffing snapshots -- without it, two consecutive
identical events are indistinguishable from one. `CG_EntityEvent` strips it on
its very first line (`cg_event.c:474`):

```c
event = es->event & ~EV_EVENT_BITS;
```

Overbounce never did. `demo-clip.ts` stored the raw value and the interpreters
switched on it directly, so an event only matched its own case when the
counter happened to be 0 -- **one time in four**.

**What that actually cost.** Not just the pickups this was found through.
Everything `G_AddEvent` raises on the POV lands in `externalEvent` with bits,
which includes `EV_PAIN` (`g_active.c:75`) and `EV_DEATH1 + i`
(`g_combat.c:665`). A demo's death sounds were already mapped and already
"worked" -- three times in four they simply did nothing. **That is the shape
worth remembering: a masked-value bug does not fail, it fails
INTERMITTENTLY, and intermittent audio reads as a flaky asset rather than as
a missing bitmask.**

Two decisions, both id's:

- **Mask in the INTERPRETER, not in the decoder.** `PlaybackEvent.event` keeps
  carrying what the server actually said, because the counter is the one piece
  of information the bits exist to convey, and a decoder that throws it away
  cannot be asked later whether two events were a repeat or a duplicate.
- **Do not model the counter.** The sample DeFRaG demo does not follow a clean
  0 -> 1 -> 2 -> 3 cycle at all (its raw values run 531, 787, 787, 275), so any
  code that tried to predict the sequence would be fitting one server's
  behaviour. Mask and move on.

`EV_GLOBAL_ITEM_PICKUP` is a separate matter and is still unreachable: it is a
`G_TempEntity` broadcast (`ET_EVENTS`), not a playerstate field, and
`eventsBetween` reads only `ps.events[]`/`ps.externalEvent`. So a demo where
the runner takes a Quad plays the generic pickup sound rather than
`quaddamage.wav`. Reaching it means surfacing entity events, which is the same
unported `CG_EntityEvent` work the rest of this file keeps running into.

## Performance, measured

255KB / 5739 snapshots decodes in ~290ms. It was 502ms before unchanged
entities were **shared between snapshots instead of cloned** — nothing ever
writes to a parsed `EntityState`, and a speedrun map's snapshot is mostly
speakers and triggers repeated at 125Hz for the whole demo. Everything
reachable from a `Dm68Demo` is immutable by contract as a result; clone before
mutating.

## Testing

`demos/` is gitignored, so no demo is committed and the real-file tests are
opt-in behind `OB_DEMO`, the same shape `OA_MAP` uses for maps. The synthetic
writer in `test/demo/demo-writer.ts` carries the same caveat
`test/collision/bsp-writer.ts` does and it matters more here: it encodes from
the same tables the reader decodes with, so it validates the delta machinery
and can never validate the tables. Both halves are needed.

One asymmetry that will bite anyone writing a demo: `MSG_WriteDeltaEntity`
emits the entity number itself, while the READER pulls the number off first
and passes it to `MSG_ReadDeltaEntity` as an argument. Writing it in both
places desynchronises a gamestate by ten bits, which cost a debugging round
here.
