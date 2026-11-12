---
row: AS03
state: Partial
---

Deterministic BOM slice: Assemble's sidebar gains a Bill of materials section
under Parts, Joints and Motion, with one row per part (the live body each
component shows, following its lineage), its quantity and a CSV download
(`item,quantity,part,instances,source_body`). It is a pure derivation from the
saved assembly and body names (`deriveAssemblyBom` in
`packages/document-core/src/assembly-bom.ts`), with no schema change. Rows
follow the assembly's display order and are identical after save and reopen.
The model carries no material or mass, so the BOM has no such columns.
Exploded-view offsets and drawing presentation remain open. Evidence:
`test/assembly-bom.test.ts` (grouping, order, quantities, renamed bodies,
empty assembly, save/reopen, CSV quoting and formula guard),
`AssemblyPanel.test.tsx`, and the `test/e2e/assembly.spec.ts` add-body case
(BOM rows and CSV download).
