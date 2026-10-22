---
row: R01
---

Datum vertex repair (PR #802): History re-picks individual or all stored
edge-vertex slots of three-point/parallel-at-point planes and two-point axes
without changing datum identity, typed points, raw expressions, direction
flags or untouched sources. Multiple lost slots stage before one
exact-preflighted, undoable feature update. Invalid, ambiguous or closed-edge
picks, degenerate geometry, failed affected consumers and stale/cancelled
sessions cannot publish partial changes. Evidence:
`test/datum-vertex-repair.test.ts`, `test/datum-vertex-repair-exact.test.ts` and
`test/e2e/datum-vertex-repair.spec.ts`, covering downstream exact geometry,
retry/cancellation, undo/replay/backup/reopen and compact controls. Boundary
provenance recovery remains separate.
