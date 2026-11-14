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
suggestion) now takes a material census of the result. Each face-connected
boundary component's signed volume is taken about the body's box centre, with
a rounding and curved-face deflection band. A positive component is a piece of
material; a cavity is negative; a sign inside the band is unknown. When the
result holds more than one piece, or the count is unknown, it regroups
box-touching operand pairs, `fuseAll` first and then the pairwise fuse. It
accepts a merge only with fewer boundary components, the parts' exact box and
a volume between the larger part's and their sum. The regrouped body replaces
the original only with the same box and volume. If operands proved to touch
still come back in more certain pieces than contact groups, it refuses with
`union_unmerged_contact`; an unknown count never refuses. Regressions with closed-form oracles
in `test/touching-cylinder-union.test.ts`: annulus area, concave R2/R5 foot
fillet volume, bore cut, circular boss extruded onto a cylinder face, two
overlapping bosses on a flange in all six operand orders, enclosed-cavity
bodies, the typed refusal, hub-on-flange at (1e7, 1e7, 1e7), a tiny hollow
cube at (1e5, 1e5, 1e5), an injected material-dropping retry, a near-zero
sign, and a pattern ×4/×8 bolt-circle subtract about the
world and bore axes. Open: the upstream `fuseAll` fix, then retire
`fuseAllMergingFaceContacts`.
