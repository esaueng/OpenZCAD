---
row: M11
---

2026-11-26 Split refusal wording (CAD-workflow slice 1a, K10 evidence) on the
Remus 2026.1.171 pin (`f210583`). Slice 0's coupon found two wrong sentences
for a plane that crosses no edge of the body. A strict miss showed the generic
"The exact kernel could not build this result.", and a plane lying flat on a
face was told it "lies exactly along an existing edge". Every Split begun from
a face pick starts on that face at offset 0. The pinned kernel judges this
from edges alone. It gives the face touch and the edge touch the same
refusal, and it refuses a plane through an R5 sphere at z = 1 as "entirely on
one side", just as it refuses z = 6. The adapter (`exact-split-contact.ts`)
reads no kernel prose. It takes the typed category and records a cause on
`kernelRefusal.reason` only where the target's exact B-rep proves it:
`plane_misses_body`, `plane_on_face` or `plane_on_edge`. A proof needs a body
of one shell and analytic planar faces, with every vertex on one side within
the kernel's own slack, max(1e-7, span·1e-10). A face counts as on the plane
only when all of its vertices are within that slack and its normal matches.
Any other body gets no cause. `refusalLanguage.ts` gives each cause its own
sentence and keeps the edge one. Without a cause, the miss and the touch get
neutral sentences that claim neither. The in-place command bar now
translates by the typed record, including for an edited Split that repeats
its stored failure. The coupon's `wording` cases assert these sentences
(`test/cad-workflow-coupon.test.ts`): x = 98 and the vertex touch, x = 90
from both sides, x + y = 0, and x + k·y = 0, an edge touch whose face lies
1e-6 off. The sphere cells claim no cause. An `it.fails` pins the refused
z = 1 sphere split as a K10 capability boundary.
`test/e2e/split-recovery.spec.ts` asserts the face sentence at offset 0 and
the miss at +8. `useInPlaceCommand.test.tsx` holds Split preview replies out
of order and shows that a late frame for an earlier offset never enables
Done.
