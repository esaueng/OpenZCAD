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
used by Union, extrude Add and the move suggestion) is narrow and certifies
per contact interface. A result in one face-connected component, or one whose
operands touch nowhere, is returned exactly as before. An interface is a pair
that shares material (a shared interior point or a positive intersection) or
whose exact pairwise fuse joins it (fewer face components, strictly valid,
exact combined box). Vertex- or edge-only contact is no interface. Each
operand gets one interior witness per material lump (a cavity winds −1 and
gets none). An interface requires the lump witnesses its pairwise fuse
encloses together to be enclosed together in the result, by winding number
against the result's boundary components. A witness near a curved chord
re-tessellates that component alone, within a 400k-triangle budget. Lumps no
contact joins are never compared. An interface that does not certify gets its
group repaired on its own operands, `fuseAll` first and then the pairwise
fuse, with per-operand preservation checks. Whatever still cannot be
certified refuses with `union_unmerged_contact` (fail closed). Witness
agreement is evidence at finitely many points, not a proof that no doubled
sheet exists elsewhere. Regressions with closed-form
oracles in `test/touching-cylinder-union.test.ts`: annulus area, concave R2/R5
foot fillet volume, bore cut, circular boss extruded onto a cylinder face, two
overlapping bosses on a flange in all six operand orders, hub-on-flange at 0,
1e5 and 1e7, cavity bodies, injected material-dropping repairs, twelve pins
past the repair cap, a hub beside one or eleven separate thin tubes, thin-wall
tubes on a flange, a no-contact union that tessellates nothing, compound
operands with separate contact regions, cubes sharing only a vertex, a block
on a 0.001 or 0.0001 mm plate in a compound body, and a pattern
×4/×8 bolt-circle subtract about the world and bore axes. Open: the upstream
fixes for remus#1738 and remus#1742, then retire `fuseAllMergingFaceContacts`.
