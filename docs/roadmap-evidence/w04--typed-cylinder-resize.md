---
row: W04
---

Cylindrical-face resize answers its refusal as data: the adapter calls
Remus's `resizeCylindricalFaceDetailed` (Remus #1550) and raises a
`direct-edit` `KernelRefusal` carrying `unsupported_move_face`, its category
and the kernel's cause (`details.reason`, `neighborSurfaceType`), so
`FeatureWarning.kernelRefusal` is filled for a wall that meets a sphere or a
blend and for a blind bore's partial wall. An `unsupported` refusal skips the
small-change waypoint ladder, and the web copy picks its sentence from the
typed cause before the prose table. Nine K10 direct-resize cells (the eight sphere × cylinder
cells and the aligned cylinder × cylinder bore grow, a partial reversed wall) move
from `untyped-refusal` to `typed-refusal`. Evidence:
`packages/kernel-adapter/src/exact-direct-edit-refusal.test.ts`,
`test/sphere-boss-resize-refusal.test.ts`,
`apps/web/src/lib/refusalLanguage.test.ts`,
`test/combination-matrix.ledger.json`.
