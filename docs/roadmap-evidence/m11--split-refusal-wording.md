---
row: M11
---

2026-11-26 Split refusal wording (CAD-workflow slice 1a, K10 evidence) on the
Remus 2026.1.171 pin (`f210583`). Slice 0's coupon found two wrong sentences
for a plane that crosses no edge of the body. A strict miss showed the generic
"The exact kernel could not build this result.", and a plane lying flat on a
face was told it "lies exactly along an existing edge". Every Split begun from
a face pick starts on that face at offset 0. The pinned kernel gives the
face touch and the edge touch the same text ("only touches the body and
contains edge N"). So the adapter (`exact-split-contact.ts`) checks the
target's exact planar faces, using each face's analytic normal and plane
equation, never the display mesh. It records the cause on
`kernelRefusal.reason` as `plane_misses_body`, `plane_on_face` or
`plane_on_edge`, and records none when a freeform face or a NURBS-backed
plane could be the face in question. `refusalLanguage.ts` gives each cause
its own sentence and keeps the edge one. Untyped text gets a miss sentence
and a neutral touch sentence. The in-place command bar now translates by the
typed record, as the diagnostics card already did. The coupon's
`wording` cases now assert these sentences: x = 98 and the vertex touch, x = 90
from both sides, and x + y = 0 (`test/cad-workflow-coupon.test.ts`).
`test/e2e/split-recovery.spec.ts` asserts the face sentence at offset 0 and
the miss at +8. `useInPlaceCommand.test.tsx` holds Split preview replies out
of order and shows that a late frame for an earlier offset never enables
Done. Only the current offset's own frame decides the verdict.
