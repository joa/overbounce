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

## Emoji: the entity lump is UTF-8, and was being read as latin1

The hints use emoji deliberately (🚀 ⚡ ⬇ ⬆ 🏁 ⏱ ➡) and they came out as
mojibake. **This was a real bug and it was mine**, in `parseBsp`:

```ts
entities += String.fromCharCode(entBytes[i]);   // latin1, one byte per char
```

🚀 is U+1F680, four UTF-8 bytes `f0 9f 9a 80`, and that loop promoted each byte
to its own codepoint — so the string reaching the DOM was four garbage
characters, not one emoji. The lump is now decoded with `TextDecoder('utf-8')`,
which is a strict superset: a pure-ASCII lump decodes byte-identically, and
`test/collision/bsp.test.ts` asserts both halves.

The synthetic BSP writer had the same latin1 bug in reverse, which is exactly
the failure that file's header warns about — writer and parser agreeing with
each other while both are wrong about real maps. It encodes UTF-8 now.

**I first blamed a missing emoji font in headless Chrome and moved on.** That
was wrong and it was lazy: the claim was never checked, and one look at the
codepoints coming out of `parseEntities` would have settled it in a minute. If
text looks wrong, print the codepoints before blaming the renderer.

## One emoji really is missing, and it is not ours

`maps/ob_basics.map` line 1027 contains `"message" "GO! ⏱"` — bytes
`e2 8f b1`, U+23F1. The COMPILED `maps/ob_basics.bsp` contains `"GO!"` and
nothing after it. The map compiler dropped it somewhere between the two, so
that one is upstream of this repository. Every other emoji in the map survives
the compile and now renders.

## Same bug, a third cache: the bundled pak

2026-08-25, `ob_rockets`: `maps/ob_rockets.bsp` and `public/maps/ob_rockets.bsp`
were both current after a rebuild, but the normal `/` course-select flow still
showed the old course. A fourth copy was stale: `public/ob_rockets.pk3`
(`npm run build-oapak`) embeds its own `maps/ob_rockets.bsp`, and course-select
mounts that pak automatically — once a pak carries the map, `loadBundledMap`'s
loose-file fallback in `public/maps/` is never consulted. `?map=ob_rockets`
(which bypasses paks) showed the fresh map the whole time; only the pak-mounted
course-select path was stale. Confirmed by extracting the bsp from inside the
`.pk3` and checking its byte size against the freshly compiled one, not assumed.
Fixed by re-running `build-oapak`. See CLAUDE.md's "Editing a bundled tutorial
map" checklist — this is now step 3 there, not an occasional gotcha.

## Re-fire

The hint triggers carry `wait 5`, so standing in one re-fires every five
seconds. `centerPrint` replaces rather than queues (which is Quake's own
behaviour) and, when the incoming text is the text already showing, refreshes
the hold timer **without** touching the DOM — so a re-fire is invisible instead
of a flicker, and a backlog of the same sentence cannot build up.
