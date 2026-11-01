---
row: U01
---

An untouched Total prefill preserves the exact signed drag offset, rather than
subtracting an unrounded mesh baseline from rounded display text. Applying an
untouched zero offset cancels without creating a feature. Explicitly edited
values, captured first keys, expressions and unit changes retain normal numeric
evaluation, including editing back to the same displayed text.

`NumericKeypad.test.tsx` reproduces the rounding defect at zero and nonzero
initial offsets and checks explicit text/unit round trips. The mm/inch browser
cases in `test/e2e/face-offset-total.spec.ts` check unchanged Apply, local depth
through a hole versus an unobstructed pick on the same face, expression entry,
negative relative Offset, history count, undo/redo and persistence after reload.
The analytic width comparison uses the existing display tessellation budget;
mesh-derived local material depth is not an exact global body dimension.
