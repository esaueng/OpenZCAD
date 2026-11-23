---
row: I03
---

Stored-unit conversion phase 3 (`docs/plans/i03-stored-unit-conversion-plan.md`
§3.4): an imported mesh's referenced payload may state its own units
(`payloadUnits`, schema v153), absent meaning the document's, and the kernel
scales the triangles on load and keys the mesh conversion cache by the scale,
so a conversion can leave the content-addressed blob alone. Nothing writes the
field yet (`imported-mesh-payload-units.test.ts`, `imported-mesh-schema.test.ts`).
