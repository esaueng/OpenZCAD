---
row: U01
---

2026-11-26 Fillet, Chamfer and Hole take Split's target-change rule, on the
Remus 2026.1.171 pin (`f210583`). `edgeRefusedInputs` and `holeRefusedInputs`
(`apps/web/src/lib/inPlace/tools.ts`) return `null` for edges or a face of
another body, where they used to name "Edges" or "Face" and keep the old
body's frame under the other body's refusal. The pick takes the old body's
frame down in its own commit (`useInPlaceCommand.ts`, layout effect), whether
the frame on screen was kept under a refusal, had built, or was a superseded
request's (the take-down reads the frame drawn, not only the last one that
built). Left up while the other body
was checked, a frame that had built was still drawn for a paint under that
body's refusal. A late frame of the old body is never drawn. Changes on the
same body are named and kept as before. An input is now named only over the
frame it is measured from: a refusal that takes the frame down also stops it
being kept, so after a refused retry of the very radius that built (R 2 →
refused 3 → refused 2 → refused 30) the bar names nothing over the bare body
instead of "R". `useInPlaceCommand.test.tsx` and `tools.test.ts` cover both
fixes; `test/e2e/fillet-other-body-refusal.spec.ts` records every rendered
frame across a built and three kept-under-refusal switches to another box.
