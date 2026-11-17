---
row: I02
state: Complete
---

STEP structure slice (schema v96): import reads a file's product structure
through Remus `importStepStructure` (esaueng/remus#1818): every placed
occurrence is its own body where the assembly places it, named after its part
(or solid), coloured as the file colours it, and filed in Objects folders
following the assembly tree; the feature records `stepReader: 'structure'` so
replay, undo/redo and reopen rebuild the same placed solids, and a file whose
structure cannot be read falls back to the flat reader and says so. Export
writes Objects folders as an AP214/AP242 assembly (project root, folder
sub-assemblies, one part per body, identity placements) without changing the
solids a flat reader sees. An independent XCAF reader reads OpenZCAD's folder
export as the same tree with exact placements and colours, and an independent
writer's nested assembly (a geometry-free sub-assembly placed twice, one
rotated) imports with exact placed bounds. Evidence:
`test/step-structure-import.test.ts` (independent assembly through the real
import run, names/colours/folders round trip, flat fallback, schema gate),
`step-export-metadata.test.ts` (assembly writing), `test/e2e/step-structure.spec.ts`
and `docs/exchange-loss-contract.md`.
