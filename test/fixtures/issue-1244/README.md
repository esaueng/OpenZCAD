# Issue #1244 operands

The two STEP operands of issue #1244, copied unchanged from the Remus
repository (`crates/operations/tests/data/issue_1244_torus.step` and
`issue_1244_holed_block.step` at `24040dd`, Apache-2.0). Remus rebuilt them
from the issue's recipe with an independent B-rep kernel, as FreeCAD would
write them: the torus is one face bounded only by its two seam circles.

| File               | Recipe                                                                                                                         | Volume (mm³) |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `torus.step`       | Torus about Z at the origin, R 7, r 3                                                                                          | 1243.57015   |
| `holed-block.step` | 24 × 18 rectangle centred in XY with a centred r 3 hole, extruded z −6…6, scaled 0.82 about the origin, translated (6, 1, 0.5) | 2671.21696   |

The exact intersection is 570.78893 mm³ and excludes the hole witness
(6, 1, 0.5). The block spans the whole tube height, so the intersection is
∫ 2·√(9 − (ρ − 7)²)·ρ·m(ρ) dρ over ρ ∈ [4, 10], where m(ρ) is the angular
measure of the circle of radius ρ inside the block's rectangle and outside
its hole. Gauss–Legendre quadrature in ρ = 7 + 3 sin t gives 570.788 here
(570.78893 in Remus's data notes, at 32 000 panels); with the block moved
+1 mm in x it gives 514.145.
