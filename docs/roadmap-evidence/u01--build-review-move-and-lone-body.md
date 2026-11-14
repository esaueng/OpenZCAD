---
row: U01
---

13 November design review, Move and body picks (I29, I31): the Move card
is titled "Move" as the rail and drawer name it, carries the same state
pill as every other command, words its Options, says its step once (the
bar's hint, which now names the rings and Shift; the "Move/Rotate: …" toast
is gone), and its Cancel or Escape says "Move canceled; nothing was added."
as other commands do. With nothing selected, a model's only body is the
body Scale, Mirror, Split, Rotate about axis, Solid offset and the patterns
start on, as Move already did. A new primitive over a model that has bodies
says that Done adds it as a separate body where it shows. Coverage:
`DirectModelingOverlays.test.tsx`, `loneBody.test.ts`,
`inPlace/tools.test.ts`, and `build-move-and-picks.spec.ts`,
`move-hidden-sketch.spec.ts` and `production-qa-regressions.spec.ts` in the
browser.
