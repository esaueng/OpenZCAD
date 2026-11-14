---
row: K01
---

Face-touching cylinder union (production QA 2026-11-14 finding #1): on the
`42389c8` pin, `fuseAll` joins two cylinders that meet cap to cap (a hub
standing exactly on a flange, coaxial or not, either order) without a boolean.
The result is one solid that validates and still holds both caps, so the
flange top reads as a full disc, a foot fillet rounds convexly and a later
bore cut drops the hub ([remus#1738](https://github.com/esaueng/remus/issues/1738)).
Pairwise `fuse` merges that pair but refuses two parallel r20 cylinders that
overlap by 1 mm or less, whatever their cap planes
([remus#1742](https://github.com/esaueng/remus/issues/1742)); `fuseAll` fuses
them when their caps are shared. The union gate (`fuseUniformSolidChecked`,
used by Union, extrude Add and the move suggestion) is narrow. A result in one
face-connected component, or one whose operands touch nowhere, is returned
exactly as before. Otherwise the operands' proven contact groups are found:
certified distance, shared interior point or positive intersection, or one
pairwise fuse that joins them. Each group is certified as one piece: every
operand's interior witness winds +1 against the result's boundary components,
and all of the group's witnesses are enclosed by the same components. A
witness near a curved chord re-tessellates that component alone, within a
400k-triangle budget. A group that does not certify is repaired on its own
operands, `fuseAll` first and then the pairwise fuse, with per-operand
preservation checks. If it still cannot be certified, the union is refused
with `union_unmerged_contact` (fail closed). Regressions with closed-form
oracles in `test/touching-cylinder-union.test.ts`: annulus area, concave R2/R5
foot fillet volume, bore cut, circular boss extruded onto a cylinder face, two
overlapping bosses on a flange in all six operand orders, hub-on-flange at 0,
1e5 and 1e7, cavity bodies, injected material-dropping repairs, twelve pins
past the repair cap, a hub beside one or eleven separate thin tubes, thin-wall
tubes on a flange, a no-contact union that tessellates nothing, and a pattern
×4/×8 bolt-circle subtract about the world and bore axes. Open: the upstream
fixes for remus#1738 and remus#1742, then retire `fuseAllMergingFaceContacts`.
