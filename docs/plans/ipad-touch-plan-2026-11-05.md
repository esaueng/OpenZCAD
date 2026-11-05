# iPad, touch and Apple Pencil plan

Decided 2026-11-05. Owns the touch/tablet half of [L02](../../ROADMAP.md#l02);
each slice below is one bounded PR recorded as an L02 evidence fragment.

## Starting point (survey of `main` at `3ea3efc`)

What already works:

- Phone-width layouts are tested.
- `pointer: coarse` enlarges the rails, and `hover: none` shows row actions
  that are otherwise revealed on hover (`target-size.css`, `sidebar.css`).
- The drawing sheet has two-finger pinch and pan (`DrawingWorkspace.tsx`).
- The orientation cube, panel resizers and dock grips use Pointer Events with
  pointer capture.
- Undo is on screen (`ViewerToolbar`).
- Autosave flushes on `pagehide` and `visibilitychange`.

What does not:

- **The 3D viewport is mouse-only.** The capture-phase `pointerdown` in
  `ModelViewer` treats every primary press, including touch and pen, as
  select, box-select or handle drag, and `GestureRouter.capture` parks
  `OrbitControls`. So:
  - one finger draws a selection box;
  - a second finger overwrites the tracked press, so there is no pinch;
  - orbit needs Shift, and pan needs the right or middle button.
- **Hover is load-bearing.** Preselection, handle highlighting and the
  sketch rubber band between clicks all need a hover `pointermove`.
- **Pick tolerances are fixed CSS pixels** (edges 14, snap 12, click/drag 6,
  sketch grab 11). Nothing reads `pointerType`, and nothing tells pen from
  finger.
- **Missing touch paths:**
  - The app context menu opens only on a right-button release. A long press
    opens only the topology pick list.
  - There are 17 `dblclick` uses, and iPad Safari fires `dblclick`
    unreliably.
  - Tooltips open on `pointerenter`. About 500 `title=` attributes are never
    seen on iOS.
- **Screen and focus problems:**
  - `.app-shell` is `100vh`, which Safari sizes behind its toolbars.
  - There are no safe-area insets and no `viewport-fit=cover`.
  - Inputs are 14px (the keypad is 13px), so Safari zooms the page on focus.
  - `NumericKeypad` focuses a plain `<input>`, which raises the system
    keyboard on top of the keypad.
- **Platform gaps:**
  - There is no manifest or service worker, and no
    `navigator.storage.persist()`.
  - Safari evicts storage after 7 days for sites not added to the Home
    Screen (ADR-024).
  - The `accept` filters on file inputs can grey out `.openzcad` and `.step`
    in the iOS Files picker.
  - `lib/model.ts` revokes the download blob URL right after `click()`.
- **Renderer limits:** WebGL only, pixel ratio capped at 2, a fixed 3072²
  shadow map, and no handling of `webglcontextlost`. WASM and GPU memory has
  never been measured on iPad.
- **Tests:** Playwright runs Chromium only, with no tablet viewport or WebKit
  project.

## Decisions

1. **Gestures:**
   - One-finger drag on empty space orbits.
   - Box select moves to a Pencil drag and to a selection-mode chip.
2. **Tap** replaces the selection, the same as a click. An "Add" and a
   "Toggle" chip stand in for Shift and Ctrl/⌘.
3. **Two-finger tap is Undo and three-finger tap is Redo**, on by default and
   switchable in Settings.
4. **First target is iPadOS Safari in a tab.** The Home Screen app (manifest,
   service worker, persistent storage) is slice 7.
5. **Choose behaviour per event by `pointerType`, not by detecting the
   device.** An iPad with a trackpad or mouse sends `mouse` pointers and keeps
   desktop behaviour. Coarse sizing follows `@media (pointer: coarse)`.
6. **Real-device acceptance** needs the owner's device list. The proposed
   matrix:
   - A14 iPad (4 GB) as the low end
   - M-series iPad Air
   - M4 iPad Pro with Apple Pencil Pro
7. **Linux WebKit and Chromium touch emulation are not iPadOS Safari.**
   Slices 3, 6 and 8 are not Done until device evidence is recorded.

## Gesture vocabulary (3D viewport, touch)

| Gesture                                            | Action                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| Tap                                                | Select; tap on empty space clears the selection                          |
| One-finger drag, empty space                       | Orbit                                                                    |
| One-finger drag, handle or gizmo                   | Existing handle drag                                                     |
| Two-finger drag                                    | Pan                                                                      |
| Pinch                                              | Zoom about the midpoint between the fingers (zoom-to-cursor maths)       |
| Long press (about 500 ms, under 10 px of movement) | App context menu; the stacked-geometry pick list stays reachable from it |
| Double tap                                         | Our own tap counting, replacing `dblclick`                               |
| Two-finger tap / three-finger tap                  | Undo / Redo (setting)                                                    |

Timing and ownership rules:

- A second finger landing within about 100 ms of the first cancels the
  first's pending tap or select.
- Once a handle drag is captured, extra fingers are ignored, as in
  `SketchMovePointerGate`.
- The touch click/drag threshold is 10–12 px. Touch pick radii are about twice
  the mouse values.
- Safari's `gesturestart` and `gesturechange` are cancelled over the canvas so
  a pinch never zooms the page.

## Apple Pencil (Pencil mode)

- **Turning it on:** it switches on automatically at the first `pen`
  pointer, and a setting overrides that.
- **Pencil** selects, drags handles, draws sketch geometry and, from empty
  space, draws a selection box. It uses mouse-like pick radii.
- **Finger** taps still select. Finger drags only orbit, pan and zoom, and
  a finger never creates sketch geometry.
- **Palm rejection:** touch pointers are ignored while a pen is down and for
  about 300 ms after it lifts.
- **Hover** (Pencil hover on M2 and later iPad Pro): if Safari reports `pen`
  pointermove with no buttons pressed, preselection and the rubber band work
  through the existing hover path. Verify this on a device.
- **Smoother drags:** use `getCoalescedEvents()` when the browser has it.
  Pressure and tilt are not used for geometry.
- **Scribble** (iPadOS handwriting into text fields) must keep working in
  value fields, so pen events over inputs are never cancelled.
- **Out of scope for the web build:** Pencil double-tap and squeeze. Safari
  does not expose them; they would need a native iPad shell, which is a
  separate decision.

## Slices

1. **Screen scaling and iOS basics.**
   - `dvh` heights, matching the existing overlays. Safari sizes `vh` behind
     its toolbars.
   - On the workspace, no page rubber-band scrolling, long-press callout,
     text selection on the model or tap highlight.
   - Under `pointer: coarse`: 16px form controls (iOS zooms the page into a
     smaller focused field) and 44px rail, command and Done/Cancel targets.
   - The keypad keeps its focused field without raising the system keyboard
     (`inputmode="none"` under coarse pointers; a hardware keyboard still
     types). A touch on the field itself raises it, for parameter names.
   - The keypad stays above an open software keyboard (`visualViewport`).
   - iPad-size layout coverage at 768×1024, 820×1180 and 1024×1366 in both
     orientations. This runs in the existing Chromium project with touch
     emulation (`pointer: coarse`, `hover: none`), so CI needs no new
     browser install.
   - `viewport-fit=cover` and safe-area insets move to slice 7. A Safari tab
     already keeps the page inside the safe area; only the Home Screen app
     draws under the home indicator, and that needs an audit of every fixed
     and floating layer.
2. **Gesture recogniser.** A pure multi-pointer state machine in
   `packages/viewport/src/input/` covering the vocabulary above, unit tested
   with synthetic pointer sequences.
3. **Viewport wiring** (`viewer/touchNavigation.ts`).
   - A sequence's first finger still runs the viewport's own press handling.
     If that claims it (a handle, the move gizmo, a footprint, a sketch
     tool's stroke, the armed face), the finger acts exactly as a mouse
     button. Otherwise the recogniser owns it: a tap replays the release as
     the click it is, a drag orbits (or pans where rotation is off), and a
     long press opens the pick list or context menu. Every later finger
     belongs to the recogniser.
   - Camera calls go through `CameraController` (`beginPinchDrag`,
     `panByPixels`, `zoomByPinch` beside the view cube's orbit).
   - Touch picks edges in a band about twice as wide; snap and sketch-grab
     radii move with slice 5.
   - Browser coverage drives real multi-touch through Chromium's input
     domain. A WebKit project is dropped: Playwright's Linux WebKit is not
     iPadOS Safari, cannot send multi-touch, and would add a browser install
     to every CI shard.
   - The Settings switch for two- and three-finger taps moves to slice 4,
     with the other touch preferences.
4. **Hover and keyboard replacements.**
   - Two viewer-bar toggles, for coarse pointers only: Multi-select (a pick
     adds or removes, as Shift and Ctrl/⌘ do) and Free values (no snaps or
     inference, exact drag values, as Shift does). They are workspace-local
     and start off.
   - A finger held 550 ms anywhere in the chrome dispatches a real
     `contextmenu` (`lib/touchLongPress.ts`), so every right-click menu
     works with no handler changes, and swallows the lift's click. A
     `Tooltip` trigger with no menu shows its help instead. Text fields and
     the viewport canvas are left alone.
   - Settings › Viewport switch "Undo with two fingers", on by default, and
     carried by the Worker when an older client saves without it.
   - Already reachable by touch, so unchanged: Redo, Standard views and the
     orientation cube, row actions under `hover: none`, and the command
     search button. Handles stay drawn without hover; only their hover
     highlight is missing, and Pencil hover (slice 6) restores it.
5. **Touch sketching.**
   - Line and arc already draw press–drag–release per segment with a live
     preview, and sketch tools are claimed presses in slice 3, so they run
     unchanged under a finger.
   - A finger gets twice each screen tolerance (`lib/pointerSlack.ts`):
     sketch snaps, the move and offset snaps, the measure snap, the sketch
     grab dot and the ring's band (the dot never grows into the ring), and
     curve picks. The axis picker's 7 px tube is scaled per frame inside its
     rig and stays as it is.
   - An offset magnifier (`viewer/touchLoupe.ts`) follows a finger dragging
     sketch geometry: twice the canvas under the finger with a crosshair,
     above the finger (below near the top edge), naming the snap it took.
6. **Apple Pencil**, as above.
7. **Home Screen app and files.**
   - `viewport-fit=cover` and safe-area insets for the top bar, stage,
     floating islands and fixed layers.
   - Manifest, `apple-mobile-web-app-*` tags, and a service worker caching the
     shell and kernel WASM.
   - `navigator.storage.persist()`.
   - `navigator.share({ files })` export.
   - iOS-safe `accept` filters, with the file checked after picking.
   - Delayed revoke of the download blob URL in `lib/model.ts`, with a
     regression test.
8. **Rendering limits.**
   - Lower pixel ratio during gestures.
   - Smaller shadow map on coarse pointers or low memory.
   - `webglcontextlost`/`webglcontextrestored` recovery.
   - WASM and GPU memory measured on iPad, recorded under W01.

Later and optional: Pencil draw-to-sketch shape recognition, and a native iPad
shell.

## Acceptance per slice

- Mouse and trackpad behaviour is unchanged: the existing viewport, sketch and
  drawing e2e suites keep passing without edits.
- Desktop density is unchanged: coarse rules are scoped to
  `@media (pointer: coarse)`, and the Chromium desktop screenshots in existing
  specs do not move.
- Each slice adds its own regression coverage: CSS contract tests for slice 1,
  unit tests for the recogniser, and `@tablet` browser specs from slice 3.
- Device-only claims (Safari gesture events, Pencil hover, memory) are
  recorded as device evidence, not inferred from emulation.
