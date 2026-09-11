# Splitting `src/ui/playback-chrome.ts`

The playback screen's chrome grew to 2732 lines in one function across six
rounds of user feedback. This is the internal reorganisation that broke it
into readable pieces. **Nothing about it is a redesign**: the exported API
(`createPlaybackChrome`, `PlaybackChrome`, `PlaybackChromeHooks`,
`PlaybackChromeOptions`, `formatClock`) and every observable behaviour are
unchanged, and `npm run timeline-drag`'s 19 checks are the proof.

## The seams that were already there

Reading the file end to end, the boundaries were these -- note how many of
them are pure or nearly pure, which is what made the cut cheap:

| lines | what |
| --- | --- |
| 68-262 | the `TrackRow` model, `TRACK_ROWS`, and the value formatters |
| 274-295 | `formatClock` / `formatSpan` |
| 297-645 | the whole stylesheet and `installStyle` |
| 647-681 | `EASE_GLYPH` and `easeButton` |
| 683-763 | the public API types |
| 772-896 | root markup, element refs, the mirrored scrollers |
| 945-1080 | the snapshot undo stack |
| 1089-1226 | `draggable` and `onDoublePress`, the two generic gestures |
| 1230-1342 | the camera pills and the easing picker |
| 1344-1463 | the in/out grips and the ruler's scrub |
| 1465-1563 | the CAMERA MODE segment row |
| 1565-2198 | the per-property track list: lanes, gestures, value cells |
| 2228-2517 | the pause, export-settings and render-progress modals |
| 2519-2732 | the view toggle, the Ctrl+Z handler, the returned object |

## Where each piece went

New files live in `src/ui/playback-chrome/`, named for the file they came out
of rather than `src/ui/playback/` -- one character from `src/playback/`, the
timeline model, which every one of these modules also imports. A copy-pasted
`'../playback/timeline.js'` that silently resolved to the wrong folder is a
class of mistake the longer name removes outright.

- `styles.ts` -- `STYLE` and `installStyle`.
- `format.ts` -- `formatClock` (re-exported from `playback-chrome.ts`, which
  is where its one test and the rest of the app import it from) and
  `formatSpan`.
- `track-rows.ts` -- the row model and the unit conversions, pure.
- `gestures.ts` -- `createDraggable` and `onDoublePress`.
- `history.ts` -- the snapshot undo/redo stack.
- `ease-picker.ts` -- the picker, its glyphs, and the `Selection` the track
  list shares with it.
- `camera-modes.ts` -- the CAMERA MODE row and the segment maths the hatching
  is derived from.
- `track-list.ts` -- the five property rows and every gesture on them.
- `export-dialog.ts` -- `Pe`, the export settings.
- `modals.ts` -- the modal stack: `Pd`, `Pf`, and the export dialog's shell.

## The constraints that made the cut risky

Each of these is behaviour that no type and no unit test would have caught.

1. **Listener order on the lane.** `onDoublePress` registers its
   `pointerdown` BEFORE the retime/fader one. On the second press the double
   handler adds or removes a key and the drag handler then hit-tests against
   the modified track. `track-list.ts` keeps that order.
2. **DOM order in the track list.** CAMERA MODE is appended first and the
   five property rows after it, because `timeline-drag.ts` addresses FOV as
   `:nth-child(3)` and CAMERA POS as the first bare `.ob-pb-lane`.
3. **Nothing renders inside a factory.** The initial paint sequence stays in
   `createPlaybackChrome`, after the history buttons are wired.
4. **`installStyle()` stays the first statement**, because the panel's
   `[hidden]` rule is what keeps the timeline from rendering over `Pb` on the
   first frame.
5. **`armedUndo` has four operations, not three.** Arm, commit, and DROP --
   the lane's `endDrag` clears it directly, because a press that never
   travelled was a click and a click costs no undo entry.

## Findings

Things the read turned up that are worth someone else's attention.

### Two comments disagree with the code, and are left disagreeing

Both are flagged in place rather than corrected, because correcting the prose
would settle a question that is not the refactor's to settle.

1. **`keyCamera` claims it keys the fov.** `PlaybackChrome.keyCamera`'s doc
   says "position, angles and fov", and the paragraph now on `keyCameraAt`
   says "position AND angles AND fov". The row it writes, CAMERA POS, owns six
   ids: `camX/camY/camZ/camYaw/camPitch/camRoll`. **No fov key is placed.**
   Either both comments are stale or an fov key was lost in an edit; from the
   code alone there is no telling which.
2. **`TRACK_ROWS`' doc says CAMERA POS is three tracks.** It is six. The row's
   own comment explains why it took the angles as well, so the two sit next to
   each other saying different numbers.

### Comments that described code that no longer exists

Corrected, and what they described is confirmed gone.

3. **`playhead` and `seekTo` named a "+ Camera key" and a "+ Cue" button.**
   Neither exists anywhere in the file; the only other mention of cues is
   `history.ts` splicing the array. Both comments now say what places a
   keyframe today without naming a button.
4. **`DRAG_SLOP` said it was shared with the ruler.** The ruler's keyframe
   diamonds were removed when the per-property lanes arrived, and the lanes
   are its only caller now.
5. **The ruler was repainted after every keyframe edit.** Six calls, on the
   strength of a comment reading "the ruler draws the timeline's keyframes, so
   a new one shows up there too". It does not, since the same removal.
   `renderRuler` is a pure function of `inPoint`, `outPoint` and `duration`,
   and a key edit cannot move any of the three -- so `track-list.ts` no longer
   takes it at all, which is one less edge between the two files.

### Small duplication

6. **`onHistoryKey` re-implemented `modalOpen()`** inline, three null checks,
   directly under a comment saying "`modalOpen()` already answers it". It now
   calls `modals.anyOpen()`.
7. **Every caller of `renderTracks` also called `renderValues`**, which
   `renderTracks` already ends by doing -- under a comment saying callers
   should not have to remember to. Five such calls removed.
