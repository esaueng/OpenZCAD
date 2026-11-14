---
row: K01
---

Face-touching cylinder union (production QA 2026-11-14 finding #1): on the
`42389c8` pin, `fuseAll` joins two cylinders that meet cap to cap (a hub
standing exactly on a flange, coaxial or not, either order) without a boolean.
The result is one solid that validates and still holds both caps, so the
flange top reads as a full disc, a foot fillet rounds convexly and a later
bore cut drops the hub. Pairwise `fuse` merges that pair but refuses two equal
overlapping bosses that share both cap planes, which `fuseAll` fuses. The
union gate (`fuseUniformSolidChecked`, used by Union, extrude Add and the move
suggestion) now counts the result's positive-volume material pieces (an
enclosed cavity is not one). When the `fuseAll` result holds more than one
piece, it regroups box-touching operand pairs, `fuseAll` first and then the pairwise
fuse, and keeps the result only when it has fewer pieces. If operands proved
to touch still come back apart, it refuses with `union_unmerged_contact`
instead of returning the internal wall. Regressions with closed-form oracles
in `test/touching-cylinder-union.test.ts`: annulus area, concave R2/R5 foot
fillet volume, bore cut, circular boss extruded onto a cylinder face, two
overlapping bosses on a flange in all six operand orders, enclosed-cavity
bodies, the typed refusal, and a pattern ×4/×8 bolt-circle subtract about the
world and bore axes. Open: the upstream `fuseAll` fix, then retire
`fuseAllMergingFaceContacts`.
