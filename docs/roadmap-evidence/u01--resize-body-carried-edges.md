---
row: U01
---

Resize Body through later blends with unnamed picks: dragging the right face
of a Box → Cylinder → Union → Fillet ×3 → Chamfer part from 30 to 22.5 mm
previewed correctly and was refused on release as "Selection changed",
because a later Chamfer/Fillet stored its edges as geometry hashes (the
blended body publishes no name for them) and the width edit moved them. The
rebuild now carries a hash-only fillet/chamfer selection across an upstream
edit that leaves its input structure unchanged
(`exact-edge-selection-transport.ts`: order-free structural labels over
face/edge incidence, seeded only with resize invariants) and the app
persists the new hashes with the commit; preview and commit share that
resolution. A structural change still refuses, typed `reference_missing`.
Refusals now branch on the adapter code instead of the sentence: "Selection
changed" only for the command's own pick, while a later feature stranded by
the edit is named with "Try a smaller change, or edit it". A refused edit of
an existing step is shown on that step's history row, which keeps its value
in view while edited, rather than as a trailing "not built" step.
Coverage: `test/upstream-resize-carried-edges.test.ts` (reported part on four
sides, shrink and grow, plain box, cylinder height, cold reopen, fail-closed),
`refusalSummary.test.ts`, `machine.test.ts`, `topologyReferenceRepairs.test.ts`,
`HistoryTimeline.test.tsx`, `affectedFeatureTargets.test.ts`.
