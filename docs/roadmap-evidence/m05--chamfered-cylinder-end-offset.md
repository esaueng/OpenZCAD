---
row: M05
---

Circular end-face offsets on verified solid cylinders with one or two conical
chamfers move the cap and its chamfer together and extend the cylindrical wall,
keeping the opposite end, end diameter, and chamfer setbacks intact. The exact
radial-section construction carries verified face references and rejects wall
collapse; tubes, additional features, split rims, and freeform surfaces keep the
ordinary kernel path. Regression coverage includes STEP imports/exports, mirrored
and rotated parts, unequal setbacks, compound sibling preservation, repeated
offsets and JSON replay (`test/chamfered-cylinder-cap-offset.test.ts`), plus the
bottom-face Total 240 to 300 preview/apply, undo/redo and reload browser flow
(`test/e2e/chamfered-cylinder-offset.spec.ts`). This is bounded imported-end
editing; general conical face offsets remain unqualified.
