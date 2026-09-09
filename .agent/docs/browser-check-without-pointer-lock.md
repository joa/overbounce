# Verifying a weapon in the browser from automation

Learned 2026-09-09 while checking the shotgun's muzzle puff. Two things
stop a Chrome-automation session from simply "clicking to play and firing",
and both have a workaround.

## 1. Automation never gets pointer lock

`canvas.requestPointerLock()` from a synthesized click is refused (no
error, `document.pointerLockElement` stays null). Without the lock the run
stays frozen behind the "Click to play" panel (`simPaused`, `main.ts`), the
`mousedown` handler in `input.ts` returns early, and `held` is cleared on
every `pointerlockchange`.

Fake it from the page:

```js
const canvas = document.querySelector('canvas');
Object.defineProperty(Document.prototype, 'pointerLockElement',
  { configurable: true, get: () => canvas });
document.dispatchEvent(new Event('pointerlockchange'));
```

`input.ts` reads `document.pointerLockElement === canvas` in its
`pointerlockchange` handler, so this flips `state.locked` and the loop
resumes. Keys then work through synthetic events on `window`
(`new KeyboardEvent('keydown', { code: 'KeyF' })`); `onKeyDown` does not
check the lock. Mouse buttons still will not fire, so bind the action to a
key first -- the binds store is `localStorage['overbounce.keybinds.v1']`,
shape `{ attack: ['Mouse0', 'KeyF'] }`, read once at load, so set it and
reload.

## 2. The MCP tab is hidden except while a screenshot is taken

`document.visibilityState` is `hidden` in the automation tab group, so
`requestAnimationFrame` never fires and `game.time` does not advance --
EXCEPT during a screenshot, which makes the tab visible for a few frames.
So a keydown dispatched between screenshots is never seen. Hold the key
down (dispatch `keydown` with no `keyup`), take the screenshot, then
release. The shot fires and the puff spawns inside the screenshot's own
window of frames, which is also why the puff is visible in it.

## 3. `?map=<name>` mounts no pak

The dev-testing path (`loadBundledMap`, `fs: null`) loads the loose `.bsp`
only: no weapon models, no `smokepuff3`, no fancy explosions, and
`explosionFx` is null. To see textured effects go through course select
(`/` with no `?map=`), which mounts `BUNDLED_PAKS`. The debug handle is
`window.overbounce` (`game`, `sim`, `cam`, `shotgunSmoke`, `smokeTrail`,
`explosionFx`, ...), and every effect pool has a `debug()` reporting
`live`/`textured`.
