---
row: U05
---
Production QA keyboard recovery (2026-10-29): Escape closes the Controls
sheet again (the keymap no longer stands down for a workspace inerted by the
one modal that lends it keys); a press on the viewport releases focus held by
a toolbar tile, so Enter after drawing no longer presses the tile and switches
the sketch tool; and a section cut turned on from command search in View mode
shows there with a Turn off control. Coverage: `useModalFocus.test.tsx`,
`viewportFocus.test.ts` and `keyboard-focus-recovery.spec.ts`.
