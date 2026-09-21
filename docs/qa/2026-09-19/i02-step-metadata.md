# I02 STEP names, colours, and assembly structure qualification

This is a bounded qualification of the current OpenZCAD STEP boundaries on
`origin/main` `efa2662`. It does not claim arbitrary STEP metadata support and
does not change the import runtime, document schema, or pinned kernel.

The semantic fixture
[`i02-step-assembly-metadata.step`](../../../test/fixtures/i02-step-assembly-metadata.step)
is a small independently authored AP214 text fixture. It contains three
`PRODUCT` names, two `COLOUR_RGB` records, two `STYLED_ITEM` records, and two
`NEXT_ASSEMBLY_USAGE_OCCURRENCE` records, deliberately without B-rep geometry.
It is suitable for testing the cheap textual preflight, but cannot qualify
geometry import or assembly placement.

| Boundary                 | Current verified behavior                                                                                                                                                                                                                                                                                               | Evidence                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Textual upload preflight | `parseStepMetadata` returns the file name, all bounded product names, and colour labels. It does not expose style attachment, occurrence parents/children, transforms, or hierarchy.                                                                                                                                    | `test/i02-step-metadata-qualification.test.ts`, semantic fixture                                                        |
| Document import          | The upload flow uses the first product name as the feature/body name and stores the original STEP text or a source reference. `importStepBody` stores optional declared solid indices. There is one imported feature/body; no assembly nodes are created from STEP occurrences and no incoming STEP colour is attached. | `apps/web/src/lib/stepImportRun.ts`, `packages/document-core/src/index.ts`, qualification test                          |
| Exact import             | Remus reads the source into exact solids, normalizes declared length units, reports declared/rejected/flagged solids, and preserves placements in geometry. The report has no names, colours, occurrence graph, or assembly transforms.                                                                                 | `packages/kernel-adapter/src/exact-feature-builders.ts`, `packages/kernel-adapter/src/exact.ts`, existing parity corpus |
| STEP export              | `exportStep` receives body IDs and serializes exact solids. The pinned Remus writer emits a generic `remus_solid` product and no source body name, display colour, `STYLED_ITEM`, or `NEXT_ASSEMBLY_USAGE_OCCURRENCE`. Separate solids remain separate in the shape representation.                                     | qualification test; `test/parity/corpus-metrics.ts` checks exported solid count                                         |

The existing `d-multi-two-boxes.step` fixture qualifies the geometry half of
this boundary: it imports as one body whose exact representation declares two
solids, and the existing selected-solid tests exercise `solidIndices`. That is
separate-solid preservation, not assembly hierarchy preservation. A future I02
slice needs a geometry-bearing AP214 assembly fixture with explicit product
definitions, occurrence transforms, and per-component style assignments, then
must carry a reviewed semantic model through document persistence and export.
The fixture should assert both exact volume/placement and the product-to-body
mapping after export and reimport; no implementation should infer hierarchy
from product labels alone.

## Checks

Node 22.23.1 was used. The focused qualification test passes with the pinned
translator/kernel packages. `git diff --check` passes. The full CI matrix,
browser E2E suite, merge, and deployment are outside this qualification.
