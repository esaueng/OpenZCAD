---
row: S02
state: Complete
---

S02-D datum consumers (schema v129, building on v126; it was claimed as
v126, renumbered when F01's #1846 took that number first, with v127 and
v128 claimed by F01's #1847 and #1851). Reference distances
measure from the sketch origin, and reference angles measure against its X
and Y axes (`sketch-origin`, `sketch-axis`), in the sketch-local frame that
R01 resolves for a datum-backed sketch. The value is unchanged by a plane
offset. The targets carry no object and never block a deletion. Same-datum
pairs refuse, and so do pre-v129 carriers. Contract:
[datum section](docs/plans/sketch-reference-dimensions-plan.md#sketch-origin-and-axes-s02-d).
Evidence: `test/sketch-datum-reference-targets.test.ts`,
`SketchReferenceDimensions.test.tsx` and
`test/e2e/sketch-datum-reference-targets.spec.ts` (`@ci-smoke`). With S02-D
composite consumers (v125) and the S02-F display-unit selector, the row's
remaining composite, datum and display-unit scope is delivered. The earlier
sentence saying these "remain open" is superseded. Driving-distance modes
stay outside S02.
