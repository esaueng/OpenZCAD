---
row: D06
---

Countersink callouts and outside angles (schema v51). A hole size group whose
every copy carries a coaxial cone of one chamfer group opening onto it is
countersunk; one diameter callout naming the cone's outer rim reads "2× Ø6
THRU, CSK Ø12 × 90°" from the model and states the hole and the cone (instead
of a chamfer dimension), and a blind hole's depth. An angle dimension can turn
one ray onto its edge's extension (`outside`), so Auto-dimension states a
slope as 45° off the part rather than 135° inside. Evidence:
`test/drawing-auto-dimension.test.ts` (Hole-feature countersunk plate: one
callout, no chamfer, nothing missing; sloped part: 45° outside),
`test/drawing-import-dimensioning.test.ts` (v51 validation).
