---
row: L02
---

Slice 2, touch gesture recognizer: `packages/viewport/src/input/touchGestures.ts`
turns touch pointer samples into gestures:

- tap and double tap
- long press
- one-finger drag
- two-finger pinch (midpoint pan and spread scale)
- two- and three-finger taps

The timing rules are covered too:

- a second finger takes over from the first;
- the finger left behind after a pinch does nothing;
- a press the host claims for a handle yields nothing more;
- `pointercancel` cancels what was in progress.

It is not yet wired to the viewport; that is slice 3. Evidence:
`touchGestures.test.ts`, which is also in the unit smoke selection.
