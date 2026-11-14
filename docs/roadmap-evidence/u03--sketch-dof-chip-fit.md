---
row: U03
---

13 November design review I38 recheck: the sketch state chip under Solve
wraps a count of 10 or more as "12" over "DOF" inside its 30×22 px box,
where "12 DOF" on one line ran 6 px out past its border
(`sketchContracts.test.ts`, `sketch-review-fixes.spec.ts`).
