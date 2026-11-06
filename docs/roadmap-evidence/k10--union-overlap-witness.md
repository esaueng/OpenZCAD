---
row: K10
---
Union connectivity no longer calls overlapping box×sphere bodies disconnected.
The pin has no certified box/sphere distance and refuses their exact
intersection, so an overlap that was never proven used to be reported as
"2 disconnected groups". `sharedInteriorPoint` (`exact-boolean-helpers.ts`)
now proves shared volume from a point that both `classifyPoint` and
`classifyPointRobust` place strictly inside both solids, probed only in the
operands' common box. Tangent, stacked, gapped and near-corner pairs yield no
witness and still refuse as disconnected. The 27 box×sphere raised and sliver
union cells keep `untyped-refusal`, but now with the correct reason: the
kernel's fuse fails strict validation ("1 shared edges have inconsistent face
orientations"), which is an upstream defect, not a connectivity fault.
Analytic witness checks, closed-form cap volumes, and adapter regressions on
both sides are in `test/union-connectivity.test.ts`. This also answers the
misdescription noted under K01 (QA CAD-001).
