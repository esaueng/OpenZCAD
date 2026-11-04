---
row: M03
---

2026-11-03 chamfer qualification: exact analytic cuts preserve earlier rounds, join shared tangent rails, handle closed circular rims and complete concave corners; all-edge chamfer selection excludes already-smooth boundaries. The rounded-block regression covers every sharp edge individually and together at C0.1/C1, preview/commit, undo/redo/reload and exact STEP export (`test/chamfer-rounded-block.test.ts`, `test/e2e/chamfer-rounded-block.spec.ts`; [Remus #1518](https://github.com/esaueng/remus/pull/1518)).

The complete 33.712389 mm line–R3 arc–line chain is qualified separately at C1,
C0.5 and C0.1. Preview/commit parity, strict validity, unchanged source,
Undo/Redo, saved replay and STEP reimport remain asserted in
`test/chamfer-curved-chain.test.ts` and the tagged browser regression
`test/e2e/chamfer-curved-chain.spec.ts`. Independent OCCT measurements of all
three STEP exports match the closed-form bevel integral within 1e-6 mm³,
with one retained cylinder and one conical bevel. The original excluded
full-support setback contract remains enforced by the analytic fallback.
