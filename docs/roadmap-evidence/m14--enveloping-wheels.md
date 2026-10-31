---
row: M14
---

Double-enveloping wheels (schema v45): `gearType: 'enveloping-wheel'`, its
`teeth` its own teeth, `mateTeeth` the starts of the worm that drives it,
`diameterFactor` and `wormLength` that worm's, `faceWidth` its face and
`outsideDiameter` beside the throat; an Enveloping wheel choice in the Gear
tool (Teeth, Starts, Diameter factor, Worm length, Outside diameter) and edit
from History. Built through Remus `makeEnvelopingWormWheelDetailed`: the
Hindley straight-sided tooth exactly in the mid-plane and, off it, straight
sections fitted inside the tooth the worm would hob (sampled, not proven, and
disclosed as approximate), creased along the mid-plane line; tips on the
throat torus and the outside cylinder. Profile shift, root fillet, helix
angle, a throat option and teeth on a cylinder are refused, and a worm length
on any other gear. Evidence: `test/gear-feature.test.ts` (validation and
thirteen refusals; an m 2, 30-tooth wheel for a single-start q 10, 24 long
worm whose volume lies between its root and outside cylinders, every face
uniquely named with both flank halves; a throat wider than the face refused
as `gear:invalid-parameter`), `apps/web/src/lib/inPlace/tools.test.ts` (the
request carries the teeth, the worm's starts as its mate, the worm length and
outside diameter, without spur-only or throat fields; the count chip is its
teeth), `apps/web/src/lib/inPlace/edit.test.ts` and
`apps/web/src/lib/featureSummary.test.ts`.
