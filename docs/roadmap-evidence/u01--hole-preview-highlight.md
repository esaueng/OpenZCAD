---
row: U01
---

Hole resize previews retain the selected bore when rebuilding chamfered mouths
moves its axial endpoints. Selection resolves the unique overlapping coaxial
cylinder at the radius of the displayed worker frame, so a newer pointer value
cannot redirect the highlight. Regression coverage checks reversed axes and
chamfer transitions, plus the rendered bore overlay and absence of whole-body
selection emissive during shrinking, enlargement, release and cancellation
(`cylinderRadius.test.ts`, `through-hole-chamfer-resize.spec.ts`).
