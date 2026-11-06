---
row: K05
---

2026-11-05 parametric-first cylinder radius (kernel robustness plan WS4, PR #1241). A diameter drag on a cylinder wall published as `boolean.face.operand.N.(primitive|modifier).cylinder.face.wall` now edits the consumed source Cylinder across one union or subtract. The crossing is bounded:

- It follows fillet and chamfer result bodies and lineage-resolved cap offsets.
- Intersects, kept or copied sources and earlier local wall resizes still stop it.
- A fillet or chamfer holding a hash-only edge pick also stops it. On a plate the kernel's evolution declines to trace the boss seam, so that fillet holds a hash that a resized operand would lose, while the local resize keeps it and succeeds.

A boss or blind bore on a sphere, which the kernel refuses to resize locally, therefore now resizes exactly through its source. Evidence: `test/cylinder-radius-across-boolean.test.ts` (union, union with cap offset, subtract, plate-boss fillet guard) and `cylinderPrimitiveAncestry.test.ts`.

Remaining WS5 gaps:

- The kernel leaves the boss seam on a plate unresolved.
- Sphere hemispheres stay hash-only, so seams against a sphere cannot be named and a seam fillet there still blocks the source route.
