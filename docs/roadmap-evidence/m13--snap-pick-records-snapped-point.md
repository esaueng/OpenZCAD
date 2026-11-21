---
row: M13
---

A Distance pick under a measure snap glyph records the point the glyph names
(QA15-2E-01: "Endpoint" had recorded the edge's midpoint, 57.31 mm measured for
56). Each topology snap candidate now carries its source edge and role, the
click passes it in `PickDetail.snap`, and `measurementTargetFromSnap` records
the matching vertex, midpoint or circle centre by identity, refusing a source
that no longer lands on the marked point (`test/measure-snap-pick.test.ts`,
`packages/viewport/src/snap/topologySnaps.test.ts`, `test/e2e/measure.spec.ts`).
