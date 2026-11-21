---
row: S04
state: Complete
---

Status check on main at schema v120 (2026-11-21): the items this row lists
under "Open" (composite corner/side targets for snaps and S02-D dimensions,
region-provenance tokens and explicit legacy conversion) landed in S04-B
(#800) and S04-C (#801), recorded above. The supported subset and the refusal
boundary that the
[composite identity design](docs/plans/sketch-composite-identity-plan.md)
requires are covered. The twelve S04 suites pass locally (139 tests:
`test/sketch-composites.test.ts`, the three
`test/sketch-composite-reference-*.test.ts` suites,
`test/sketch-composite-targets-exact.test.ts`,
`test/sketch-boundary-provenance.test.ts`, the three
`test/sketch-legacy-conversion*.test.ts` suites,
`test/sketch-conversion-qualification-exact.test.ts` and both schema
retention suites). Snapping is covered by
`apps/web/src/lib/sketch/compositeTargets.test.ts`, and browser coverage by
`test/e2e/sketch-composite-targets.spec.ts`,
`test/e2e/sketch-composite-tools.spec.ts` and
`test/e2e/sketch-legacy-conversion.spec.ts`. Composite centres, references on
unconverted legacy shapes and datum targets are S02-D consumers and are
tracked in the S02 row.
