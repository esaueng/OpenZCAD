---
row: K10
---

Issue #1244 (torus ∩ holed block kept the hole on Remus 2026.1.122): on the `24040dd` pin the issue's STEP operands intersect exactly in both orders (570.759 mm³ against the closed-form 570.789, hole witness excluded), and app-modelled operands refuse by name (`exact_only_unattainable`), both fresh, after a cold reload and after an upstream edit (remus d9d51f52). Intersect results, from the Boolean feature and extrude Intersect, are now also checked against their operands: a point the kernel classifies inside the result and outside either operand, confirmed by its dual-method classifier, refuses as `intersect_kept_outside_material` (`result-acceptance.ts`, `test/intersect-material-acceptance.test.ts`).
