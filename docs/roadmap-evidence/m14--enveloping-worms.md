---
row: M14
---

Double-enveloping worms (schema v44): `gearType: 'enveloping-worm'`, its
`teeth` the thread starts, `mateTeeth` the teeth of the wheel it wraps,
`diameterFactor` its throat pitch diameter over the module and `faceWidth` its
length; an Enveloping worm choice in the Gear tool (Starts, Teeth for the
wheel, Diameter factor) and edit from History. Built through Remus
`makeEnvelopingWormDetailed`: the Hindley worm whose thread is the surface the
wheel's straight-sided teeth sweep, with exact torus lands and root floors
and certified ruled flank patches. The wheel it envelops is not built. Profile
shift, root fillet, helix angle and teeth on a cylinder are refused. Evidence:
`test/gear-feature.test.ts` (validation and eleven refusals; an m 2, q 10
single-start worm for a 30-tooth wheel whose caps span its end tip diameter,
volume between its throat root and end tip cylinders, every face uniquely
named; a bore reaching the throat root refused as `gear:bore-too-large`),
`apps/web/src/lib/inPlace/tools.test.ts` (the request carries the starts as
teeth and the wheel's teeth as its mate, without spur-only or throat fields;
the count chip is its starts), `apps/web/src/lib/inPlace/edit.test.ts` and
`apps/web/src/lib/featureSummary.test.ts`.
