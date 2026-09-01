# Pointer lock: what it will and will not give you back

Everything here was paid for by a bug. The API looks simple and is not.

## Escape is never delivered while the lock is held

The browser eats it to release the lock. A `keydown` for Escape only ever
reaches the page when the pointer is already free, which is what makes the
game's "Esc once to free the mouse, Esc again to act on it" feel natural
rather than something wired on purpose — it falls out of the platform.

The consequence for `src/main.ts`: losing the lock is the pause (the render
loop watches the locked→unlocked edge), and the Escape the page *does* see is
the one after it.

## A relock right after an Escape unlock is refused

Chrome refuses `requestPointerLock` shortly after the user left the lock with
Escape. This is a deliberate anti-trap measure and there is no way to ask for
an exemption.

**The exact gate is UNVERIFIED** and the two candidates predict different
things, so do not write code that depends on either:

- a *time* window (~1s) after the Escape-initiated exit, or
- *user activation*: Escape does not grant it, and the transient activation
  left over from gameplay input expires (~5s), so a relock after idling at the
  dialog would need a click every time rather than only for a moment.

Discriminate by pausing, waiting ten seconds, and pressing Escape: if it still
refuses, it is activation-gated, and the PAUSED dialog's "Esc Resume" hint is
promising something the platform will not always deliver. Until someone
measures it, the code assumes only that **the request can be refused**, which
is true under both.

That refusal window overlaps exactly with the moment the game most wants the
lock back: the player pressed Escape (pause), then pressed Escape again
(resume). **Never treat the request as though it succeeded.** `clearPhase`
did, from Phase 4 until 2026-09-01, and the result was:

1. Escape → lock released → PAUSED.
2. Escape → phase cleared optimistically, lock requested, refused → no
   dialog, simulation live, mouse free, and nothing on screen saying so.
3. Escape → no dialog means "leave the course" → the run is gone.

Reported as "pressing esc once after the game was paused exits the map".

**The fix is to observe the state, not the request.** The pause ends in the
render loop when `input.locked` is true again, wherever that came from:

```ts
if (hudPhase === 'paused' && input.locked && !photoUi) {
  hudPhase = undefined;
  simPaused = false;
}
```

This also happens to cover a canvas click (`input.ts` requests the lock on
any click) and browsers with no promise at all, below.

## `requestPointerLock` does not always return a promise

It returns `Promise<void>` in current Chrome, and `undefined` in Safari and
anything older. `lib.dom.d.ts` types it as a promise regardless, so
`.then(...)` typechecks and then throws `TypeError` at runtime on the browsers
that do not. All three call sites cast:

```ts
const lock = canvas.requestPointerLock() as Promise<void> | undefined;
lock?.catch(() => { /* ... */ });
```

`input.ts` needs the promise form anyway, for a different reason: the raw-input
option is only reachable through it.

## `unadjustedMovement` can reject on its own

`requestPointerLock({ unadjustedMovement: true })` is what turns OS mouse
acceleration off, and it rejects where no raw path exists. The fallback is a
plain `requestPointerLock()` — acceleration back on beats no lock at all. See
`onClick` in `src/input/input.ts`.

## Photo mode

It keeps the pause in effect underneath itself. Since regaining the lock is
what ends a pause, and `input.ts` asks for the lock on any canvas click, every
"resume on lock" path has to exclude photo mode explicitly or a click that got
past the panel resumes the run behind it.
