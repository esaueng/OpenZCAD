---
row: U03
---

I43 (docs/reviews/design-review-2026-11-13.md): inside a sketch Escape only
steps back; on the last rung the first press arms the exit and says "Press Esc
again to leave the sketch", and only a second press within 3 s leaves (Finish
Sketch still leaves in one click). A value prompt open in a sketch (dimension,
fillet radius, offset) reads "Esc cancel" and its Escape neither leaves nor
arms the exit (`sketchExitConfirm.test.ts`, `prompt.test.ts`,
`viewport.spec.ts`, `sketch-modify-tools.spec.ts`,
`sketch-review-fixes.spec.ts`, `design-review-followups.spec.ts`).
