---
row: M14
---

Throated worm wheels (schema v43): `throated: true` on a worm wheel, with an
optional `outsideDiameter`; a Throat choice (Plain or Throated) and an Outside
diameter value under Options in the Gear tool, and edit from History. Built
through Remus `makeWormWheelDetailed` with `throated`: across the throat, half
way across the face, each tooth's tip is an exact torus patch about the worm's
axis at its root clearance, and either side it stands at the outside diameter
(kernel default: the throat diameter plus one module). The flanks stay the
crossed helical wheel's, so contact is still at points. Throated is refused off
a worm wheel, and an outside diameter without it. Evidence:
`test/gear-feature.test.ts` (throated validation and refusals; an m 2, q 10,
30-tooth throated wheel at outside diameter 65 builds without warnings with
its 65 mm outside diameter, volume bounds, `tooth[k].throat` and tip half
faces all uniquely named, a plain wheel without throat faces; an outside
diameter below the tips refused by the kernel),
`apps/web/src/lib/inPlace/tools.test.ts` (a throated wheel sends its throat and
outside diameter, 0 leaves the default, a plain wheel or a worm sends
neither), `apps/web/src/lib/inPlace/edit.test.ts` (an untouched throated edit
writes back as stored; making it plain clears both fields) and
`apps/web/src/lib/featureSummary.test.ts`.
