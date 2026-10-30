---
row: M14
---
Straight bevel gears (schema v41): `gearType: 'bevel'` with the mate's tooth
count and a shaft angle (default 90°), a Bevel choice in the Gear tool and edit
from History, built through Remus `makeBevelGearDetailed`. Module, pressure
angle, addendum and dedendum are heel values and the face width runs along the
pitch cone; the teeth taper from the heel cap toward the cone apex. Flanks are
the kernel's certified spherical-involute fits; profile shift, root fillet,
helix and teeth on a cylinder are refused on a bevel gear. Evidence:
`test/gear-feature.test.ts` (bevel validation and refusals; a 20:40 right-angle
m 2 bevel gear's exact axial height `b·cos δ`, heel tip diameter, volume
between the root and tip cone frusta less its bore, every face uniquely named;
a face width reaching the apex refused as `gear:invalid-parameter`),
`apps/web/src/lib/inPlace/tools.test.ts` (a bevel request carries its mate and
drops spur-only fields) and `apps/web/src/lib/inPlace/edit.test.ts` (an
untouched bevel edit writes back as stored; returning to an external gear
clears the mate and shaft angle).
