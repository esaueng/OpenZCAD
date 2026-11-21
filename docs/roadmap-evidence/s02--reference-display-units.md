---
row: S02
---

S02-F, a separate display-unit selector (no schema change). Reference
lengths have their own per-user display unit: a new
`sketching.referenceDisplayUnit` app setting, either `document` (the
default) or mm/cm/m/in. The reference palette (Show lengths in) and Settings →
Sketching both set it. It converts only the rendered reference labels and
palette rows. Driving dimensions, document units, expressions and saved
references are untouched. An older client's save keeps the stored unit, and a
newer client's unknown unit falls back to `document`. Contract:
[S02-F section](docs/plans/sketch-reference-dimensions-plan.md#reference-display-units-s02-f).
Evidence: `dimensionAnnotations.test.ts`, `SketchReferenceDimensions.test.tsx`,
`test/app-settings.test.ts`, `test/api-routes.test.ts` and
`test/e2e/sketch-reference-display-units.spec.ts` (`@ci-smoke`: 50.8 mm reads
2 in, the exported sketch is unchanged, and the choice survives reload).
