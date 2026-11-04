---
row: U01
---

Undo and redo retain an active hole selection by resolving a unique overlapping
coaxial inward bore in the rebuilt history version, then refreshing its diameter,
chamfer span, topology reference and handle. Restoration is scoped to the
project/version and yields to a new selection or explicit clearing. Ambiguous
walls are left unselected, and outward stock walls cannot inherit a deleted
hole's selection. Regression coverage checks geometry, diameter text
and the actual bore overlay after undo/redo of dragged and typed sizes,
including restoration and removal of consumed chamfers
(`cylinderRadius.test.ts`, `through-hole-chamfer-resize.spec.ts`).
