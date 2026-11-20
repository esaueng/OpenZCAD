---
row: L09
state: Complete
---

3MF colours for OrcaSlicer: alongside the core `basematerials` group, each
distinct body colour is written as its own Materials-extension
`m:colorgroup` (declared under `m`, not required), and each object's
`pid`/`pindex="0"` selects it. Read from the importers' source: OrcaSlicer
(main 2026-11-20) keeps one colour per `m:colorgroup` by `pid` and reads no
`basematerials`, so bodies now start on their own filaments; Bambu Studio
(main 2026-11-17) reads both groups and resolves the same colours.
PrusaSlicer (main 2026-11-06) reads no 3MF colour in any encoding (`pid` and
`pindex` are parsed and unused, `basematerials` handling is commented out, no
`m:colorgroup` reader), so no file change can colour bodies there; recorded
in docs/exchange-loss-contract.md. Trade-off: an object names one property
group, so a core-only 3MF reader now binds no colour to it (the colours
stay listed in `basematerials`). Not confirmed in a running slicer.
Evidence: `three-mf-labels.test.ts`, `test/exchange-round-trip.test.ts` and
`test/e2e/three-mf-names-colors.spec.ts` (filaments 1 and 2 by the Orca and
Bambu import rules in `test/support/three-mf-export.ts`). With the CNC-cut
layout the row's scope is delivered.
