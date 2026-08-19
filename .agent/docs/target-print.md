# `target_print`, and two things that wasted time

Port of `SP_target_print` / `Use_Target_Print` (`g_target.c:142`). Small, and
the code is unremarkable — this is the part that was not.

## It is a port, and the tier matters

`target_print` is real id source, so it sits in the same fidelity tier as the
rest of `src/game/entities.ts`. That is worth stating because its neighbours in
`Course.use()` are not: `target_startTimer`, `target_checkpoint` and
`target_stopTimer` are defrag conventions with no id source behind them, and
the code says so out loud. Do not let the new case drift into that group.

All three of id's branches send the identical `cp "<message>"` and differ only
in the recipient — spawnflag 4 the activator, 1 and 2 the red and blue teams,
none of them everybody. With one client and no teams every branch collapses to
the same result, so **the team bits are unreachable here rather than dropped**.
A map that sets them still prints; `test/game/target-print.test.ts` asserts
that across all five spawnflag combinations.

## The stale BSP

The port was finished and correct and **nothing appeared on screen**, through
several rounds of looking at the wrong things.

`maps/ob_basics.bsp` has 15 `target_print` entities and 17 `trigger_multiple`.
`public/maps/ob_basics.bsp` — the copy the game actually fetches, because
`loadBundledMap` does `fetch('/maps/<name>.bsp')` — had **zero and four**. It
was a build from before the tutorial hints were added to the `.map`.

Both are gitignored, so neither is in the repository and nothing warns when
they diverge. **If a map's entities do not behave, diff the two copies before
touching any code:**

```bash
npx tsx -e "..."   # or the two-line parseEntities check in the git history
```

`ob_basics` is now in `BUNDLED_MAPS`, so `?map=ob_basics` loads it without a
pak. It needs a texture pak mounted alongside for anything but a magenta
checkerboard — `&devpak=dev-q3dm6.pk3` is enough to look at the HUD, and still
reports `base_floor` and `toxicsky` missing because those are the map's own.

## Emoji render, but not in the harness

The hints use emoji deliberately (🚀 ⚡ ⬇ ⬆ 🏁 ⏱ ➡) and the `.map` is UTF-8.
Nothing in the path transcodes: `Course` reports `target.raw['message']`
verbatim and `Hud.centerPrint` assigns it with `textContent`, never
`innerHTML` — map text is untrusted input and this one arrives from a `.bsp` a
player supplied.

**Headless Chrome here has no emoji font**, so `npm run shot` renders "GO! ⏱"
as "GO!" with a blank glyph. That is the screenshot harness, not the data —
the test asserts the string survives byte for byte. Do not "fix" it by
stripping to ASCII.

## Re-fire

The hint triggers carry `wait 5`, so standing in one re-fires every five
seconds. `centerPrint` replaces rather than queues (which is Quake's own
behaviour) and, when the incoming text is the text already showing, refreshes
the hold timer **without** touching the DOM — so a re-fire is invisible instead
of a flicker, and a backlog of the same sentence cannot build up.
