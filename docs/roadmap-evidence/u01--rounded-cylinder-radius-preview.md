---
row: U01
---

A rounded primitive cylinder's diameter drag is instant again and edits the
cylinder's radius instead of appending a local "Resize Cylinder" step. Two
regressions, both visible only in full browser runs, had stopped it. First,
the curved-surface outline's preview cache, counted against the mesh
projection's 2 MB budget since #1290/#1333, pushed a Ø140 R2-rimmed cylinder
to about 2.3 MB, so every drag frame went to an exact rebuild. The budget is
now 8 MB (`cylinderProfilePreview.test.ts` installs the outline at that
size). Second, #1276 sent every filleted boss to the kernel's local
blend-group resize. That route now owns only a wall that reaches its cylinder
across a boolean, where seam blends belong to the body. A cylinder whose own
rim blends are all that separate it from its primitive keeps the source edit,
with exact rim replay and parametric history
(`cylinderPrimitiveAncestry.test.ts`). `cylinder-preview.spec.ts` passes all
eight cases, and its radius drag case is now `@ci-smoke`.
