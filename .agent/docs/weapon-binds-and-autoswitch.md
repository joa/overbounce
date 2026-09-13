# Weapon binds, auto switch, and the second crosshair default

Owner-directed changes, 2026-09-13. Three separate things landed together
because they are one question — "what does this game do when you press a
number" — and each has a trap the next session should not re-discover.

## 1. The weapon keys are Quake III's numbers now

Before: a compact 1-6 of this project's own devising (machine gun, rocket,
plasma, grenade, rail, shotgun), ordered by how often a course wanted each.
The comment on `WEAPON_SLOTS` in `main.ts` argued for it at length and that
argument is now superseded.

After: **2** machine gun, **3** shotgun, **4** grenade launcher, **5** rocket
launcher, **7** railgun, **8** plasma gun — Quake III's own slots. The
argument that beat the old one is short: a Q3 player arrives already knowing
5 is the rocket launcher, and a layout nobody has to learn is worth more than
one with no gaps in it.

**1, 6 and 9 stay unbound.** They are the gauntlet, the lightning gun and the
BFG, none of which Overbounce carries. Filling them with something else would
throw away the only thing the layout is for. `test/input/keybinds.test.ts`
asserts all of this, including that no bind serves two actions.

### What this required

The six weapons became real `ACTIONS` in `keybinds.ts`, so they are
rebindable in Settings > Controls like anything else. That is the part worth
noting for anyone adding a seventh:

- `readBinds` iterates `ACTIONS` and falls back to `DEFAULT_BINDS` per
  missing action, so a player's stored JSON from before this change simply
  gains the new keys the next time it is read. No migration, no version bump.
- `renderControls` iterates `ACTIONS` too, so the rows appeared by
  themselves. So did `clearElsewhere`'s conflict clearing.
- `input.ts` needed a new `consumeActionPressed(action)`. The existing
  `consumePressed(code)` takes a RAW code, and an action has two slots either
  of which may be a mouse button — the question "was this action pressed" is
  about the bind table, not about one key. It consumes **both** slots when
  both fired in a frame; leaving one behind fires the action again next frame.
- `onMouseDown` now banks a press the way `onKeyDown` does. It never did,
  because nothing one-shot had ever been bound to a mouse button. A weapon
  bound to MOUSE 4 would have been silently dead otherwise.

## 2. Auto switch, and the ordering trap inside it

`src/game/autoswitch.ts`, one class, and the only thing in it that can be got
wrong is order.

Overbounce switches only to a weapon you were **not already carrying**. Q3's
own `cg_autoswitch` switches to anything you pick up except the machine gun,
every time — which on a course, where the same pickups respawn along the
route, takes the launcher out of your hands mid-flight because you brushed
one you already had. A weapon you have never held is the case where you
cannot have meant to stay on the old one.

**The trap:** by the time `f.items` is read, the pickup has already happened
and the ammo is already granted. `hasAmmo` — which is how `heldWeapons`
answers "do you have this" — says *yes, carried* for the very weapon that was
just picked up. So "did you already have this" has no source but a remembered
set, and the order is fixed:

```
isNew(picked)        // against what the tick STARTED with
...
sync(heldWeapons())  // then, and only then, take the new reading
```

A sync in the wrong place makes every pickup look old (sync first) or makes
the spawn grant look new (never syncing at spawn). Both are silent: the
feature just does nothing, or fires on the wrong frame.

**A spawn is a sync, not a pickup.** `ClientSpawn` wipes the inventory and
re-grants; FREERUN re-grants all six weapons on every respawn. None of that
is picking something up, so `main.ts` syncs in the `f.respawned` branch —
which runs *before* the item loop in the same tick, so a pickup landing on
the same tick as a respawn is judged against the new inventory.

`test/game/autoswitch.test.ts` drives a real `Game` over real pickups rather
than asserting against a hand-built set, for the reason `own-sfx.md` records
at length: a test written against your idea of the numbers passes against a
rule that never fires. The "already carrying" test waits out the real
`G_WEAPON_RESPAWN` (5s = 625 ticks) and asserts the pickup **did** happen
again, so it cannot pass on an item that never came back.

## 3. Two crosshair defaults, on purpose

`DEFAULT_CROSSHAIR = 4` stays. It is a fact about Quake III's cvar table, it
is cited as one in `crosshair.ts`'s header, and `test/render/crosshair.test.ts`
asserts it. A different house default does not make it untrue.

`OB_DEFAULT_CROSSHAIR = 10` is what Overbounce starts a player on, and it is
what `main.ts` and the Settings picker compare against — both the "(default)"
label and the "store `null` when it equals the default" rule. Getting that
wrong is inverted, not broken: a player picking 10 would store nothing and a
player picking 4 would store `'4'`.

10 goes through `crosshairIndex`'s `% NUM_CROSSHAIRS` like any other value
and lands on letter **'a'**, the first style — the same quirk a Q3 player
typing `cg_drawCrosshair 10` hits. The value is the cvar's, not an index.

`docs/url-parameters.md`'s default column had to change with it. The
`npm run url-params -- --doc` gate does **not** catch that: it compares the
key SET, not the values. It did catch the new `autoswitch` key.
