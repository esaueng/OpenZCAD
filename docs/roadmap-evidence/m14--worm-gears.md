---
row: M14
---
Worms and worm wheels (schema v42): `gearType: 'worm'` (its `teeth` are the
thread starts, its face width the length) and `gearType: 'worm-wheel'` (the
worm's starts as `mateTeeth`), both with the worm's `diameterFactor`; Worm and
Worm wheel choices in the Gear tool with Starts and Diameter factor under
Options, and edit from History. Built through Remus `makeWormDetailed` (a
cylindrical involute ZI worm, certified involute-helicoid flank fits) and
`makeWormWheelDetailed` (the helical wheel of the worm's hand at helix angle
equal to the lead angle, transverse module the worm's axial module). The pair
is a crossed helical drive with point contact, not a hobbed throated wheel.
Lead angles over 45° and profile shift, helix angle, herringbone and teeth on
a cylinder are refused. Evidence: `test/gear-feature.test.ts` (worm and wheel
validation and refusals; a single-start m 2, q 10 worm's exact length, tip
diameter and a volume between two and three fifths of its thread annulus over
the core, every face uniquely named; its wheel's tip diameter and volume
bounds; a bore reaching the worm's root refused as `gear:bore-too-large`),
`apps/web/src/lib/inPlace/tools.test.ts` (a worm sends its starts as teeth, a
wheel as its mate, without spur-only fields; the worm's count chip is its
starts) and `apps/web/src/lib/inPlace/edit.test.ts` (untouched worm and wheel
edits write back as stored; returning to an external gear clears the worm
fields).
