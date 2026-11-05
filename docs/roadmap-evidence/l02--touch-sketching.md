---
row: L02
---

Slice 5, touch sketching.

- A finger gets twice the screen tolerance for:
  - sketch, move, offset and measure snaps;
  - the sketch grab dot and the rotate ring's band;
  - curve picks.
- While a finger drags sketch geometry, a magnifier above it shows the
  hidden point at 2× with a crosshair and names the snap it took.

Evidence:

- `pointerSlack.test.ts`
- `session.test.ts` (finger grab and ring band)
- `touchLoupe.test.ts`
- `test/e2e/touch-navigation.spec.ts`: a finger draws a circle, and the
  loupe shows and then clears.
