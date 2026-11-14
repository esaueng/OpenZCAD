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
them when their caps are shared. The
union gate (`fuseUniformSolidChecked`, used by Union, extrude Add and the move
suggestion) now takes a material census of the result. Each face-connected
boundary component's signed volume is taken about the body's box centre, with
a rounding bound (γ(n+5) of the determinants' permanent) and a curved-face
deflection band. A component inside its band is measured again at a deflection
relative to its own extent. A positive component is a piece of material and a
cavity is negative; a component still inside its band is uncertain, on its
own. When the result holds more than one piece, or any uncertain component, it
regroups box-touching operand pairs, `fuseAll` first and then the pairwise
fuse. Each merge must keep an interior witness of every operand strictly
inside, every part's box within tolerances relative to that part's own size,
and a volume between the larger part's and their sum, to a slack tied to the
smallest operand. The regrouped body must also keep the original's witnesses,
box and volume. If the certain pieces alone outnumber the operands' proved
contact groups, it refuses with `union_unmerged_contact`. Regressions with closed-form oracles
in `test/touching-cylinder-union.test.ts`: annulus area, concave R2/R5 foot
fillet volume, bore cut, circular boss extruded onto a cylinder face, two
overlapping bosses on a flange in all six operand orders, enclosed-cavity
bodies, the typed refusal, hub-on-flange at (1e7, 1e7, 1e7), a tiny hollow
cube at (1e5, 1e5, 1e5), injected material-dropping retries (including a
0.5 mm boss lost off a 2 m flange at 1e7), twelve pins on a flange past the
repair cap, fine features judged at their own scale, an uncertain component
beside certain ones, and a pattern ×4/×8 bolt-circle subtract about the
world and bore axes. Open: the upstream fixes for remus#1738 and remus#1742, then retire
`fuseAllMergingFaceContacts`.
