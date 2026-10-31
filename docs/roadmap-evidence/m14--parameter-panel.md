---
row: M14
---
Gear parameter panel (shared by every in-place command): the bar's Options is
a compact parameter sheet whose values are typed in place (numbers or
expressions, arrow keys and label scrubbing) in their own units, so pressure,
helix, phase and shaft angles read in degrees, profile shift in modules and
diametral pitch per inch rather than in the document's length unit; a gear's
rows show only where they apply (hand and herringbone once a helix angle is
set, mate and shaft angle for a bevel, starts and diameter factor for a
worm, rim for a ring, no sizing while teeth keep the cylinder's diameter),
the tooth form folds away, and a summary gives the resulting module and pitch
diameter. Changing the sizing keeps the tooth size (module 2 becomes 12.7 /in),
the pitch chip edits the pitch the sizing reads, and the default diametral
pitch matches the default module. Evidence: `apps/web/src/lib/inPlace/panel.test.ts`,
`apps/web/src/components/InPlaceCommandBar.test.tsx` and `test/e2e/gear.spec.ts`
(Gear parameters).
