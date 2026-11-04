---
row: M03
---
2026-11-03 chamfer qualification: exact analytic cuts preserve earlier rounds, join shared tangent rails, handle closed circular rims and complete concave corners; all-edge chamfer selection excludes already-smooth boundaries. The rounded-block regression covers every sharp edge individually and together at C0.1/C1, preview/commit, undo/redo/reload and exact STEP export (`test/chamfer-rounded-block.test.ts`, `test/e2e/chamfer-rounded-block.spec.ts`; [Remus #1518](https://github.com/esaueng/remus/pull/1518)).
