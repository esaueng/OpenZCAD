---
row: I03
---

Four expression fields the registry listed as unvisited gaps are now renamed
and F05-checked like any other: a tapped hole's thread `length` and
`clearance` (lengths) and a sketch pattern's `layout.spacing` (a length) and
`layout.stepDeg` (an angle). A sketch promotion's `sourceData` stays
deliberately unvisited, because it is the verbatim legacy record S04 keeps.
The characterization now pins these four fields as the only visits added to
the frozen hand-written visitor (`test/quantity-registry.test.ts`,
`packages/document-core/src/skipped-expression-fields.test.ts`).
