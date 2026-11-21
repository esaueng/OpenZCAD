---
row: S02
---

S02-D composite consumers (schema v125, building on v120; v121–v124 are
claimed by the open F01 PRs). Reference distances and angles now measure a
held-line shape's centre (`composite-center`, with the S04-B topology
witness) and an unconverted legacy rectangle's or regular polygon's corners,
sides and centre (`shape-corner`, `shape-side`, `shape-center`), mixed with
primitive and S04-B targets, in every distance mode. Legacy corners use the
region and boundary-token order, and the shape is never converted or
rewritten. Same-target aliases refuse. So do deletion and explicit conversion
of a measured shape, and a direct kind or side-count edit. A parameter-driven
count change leaves the reference unresolved by name and never re-indexes
it. Pre-v125 carriers refuse the new targets. Helper snaps on a shape's centre
are named as that centre. Contract:
[S02-D section](docs/plans/sketch-reference-dimensions-plan.md#shape-centres-and-legacy-shapes-s02-d).
Evidence: `test/sketch-shape-reference-targets.test.ts`,
`SketchReferenceDimensions.test.tsx`, `compositeTargets.test.ts` and
`test/e2e/sketch-shape-reference-targets.spec.ts` (`@ci-smoke`). Datum
targets and a display-unit selector remain open.
