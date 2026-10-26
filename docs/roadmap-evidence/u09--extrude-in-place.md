---
row: U09
---
Extrude runs in place: a region pick (or E) arms the region's arrow as
before, and the extrude card's form is gone. A second arrow out of the back
face sets an independent back distance, a rig hinged on the foot of the
profile's longest side sets the draft angle, and each chip opens the keypad.
The card's settings moved under the bar's Options with the same refusals
(`lib/extrudeDraft.ts`, shared with the History editor): operation
(Automatic, New body, Add, Cut, Intersect) and its target body, extent
(Distance, To face with its face pick, Through all on Cut with its
direction), One side or Symmetric, Distance, Back distance and Draft angle
typed as expressions, and Reverse direction; Done or Enter creates it. History
edits of an extrude still open its editor card (`extrudeDraft.test.ts`,
`inPlace/extrude.test.ts`, `ExtrudeCommand.test.tsx`,
`extrude-in-place.spec.ts`, `extrude-intent.spec.ts`,
`extrude-to-face-draft.spec.ts`, `extrude-through-all.spec.ts`,
`multi-region-extrude.spec.ts`).
