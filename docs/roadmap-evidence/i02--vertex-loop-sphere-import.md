---
row: I02
---

A whole sphere written as one `ADVANCED_FACE` bounded only by a pole
`VERTEX_LOOP` (OCCT/FreeCAD AP214) imports as one valid closed solid on the
pinned Remus 2026.1.135, beside the current model, and later imports stay
usable; an off-surface vertex loop is still refused naming the entity
(#1245; `test/step-vertex-loop-sphere.test.ts`,
`test/fixtures/step/vertex-loop-sphere.step`, `test/e2e/step-bodies.spec.ts`).
