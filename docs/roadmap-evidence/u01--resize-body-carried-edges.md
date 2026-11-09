---
row: U01
---

Resize Body through later blends with unnamed picks: dragging the right face
of a Box → Cylinder → Union → Fillet ×3 → Chamfer part from 30 to 22.5 mm
previewed correctly and was refused on release as "Selection changed",
because a later Chamfer/Fillet stored its edges as geometry hashes (the
blended body publishes no name for them) and the width edit moved them. The
rebuild now carries a hash-only fillet/chamfer selection across an upstream
edit only in a provably fixed frame (`exact-edge-selection-transport.ts`):
the same structural label layout with a unique label for each carried
edge; at least one edge that is not carried still resolving by its own hash;
every hash-resolved edge keeping its recorded label; and planes moving along
one line only. A rotation or mirror of the part, a symmetric twin, a
structural change, a body with no fixed edge (a cylinder radius edit) or a
step after a manual suppression still refuses, typed `reference_missing`.
The carried hashes are written in the edit's own revision (refused if they
cannot be), so a reload or a collaborator rebuilds the same edges; the
selection memory is per adapter. Refusals branch on the adapter code instead
of the sentence, and every lost-reference source carries it. "Selection
changed" means only the command's own pick, and a later feature stranded by
the edit is named with "Try a smaller change, or edit it". A refused edit of
an existing step is shown on that step's history row, and only while the
plan edits it in place.
Coverage: `test/upstream-resize-carried-edges.test.ts` (each carry matched
to a fresh pick at the new size, cold reloads, rotation/mirror/equal-sides
refusals, unrelated broken feature, suppression, Heat Sink),
`exact-edge-selection-transport.test.ts`, `refusalSummary.test.ts`,
`machine.test.ts`, `topologyReferenceRepairs.test.ts`,
`HistoryTimeline.test.tsx`, `affectedFeatureTargets.test.ts`, K10 ledgers
re-recorded with cold reopen and app-equivalent commits.
