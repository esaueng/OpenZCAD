---
row: D02
---

The broken-annotation warning offers **Delete all broken**, removing only
unresolved dimensions and note leaders on the current sheet in one undoable
transaction. Healthy annotations and other sheets are preserved. Cleanup waits
for every view to finish drawing and is unavailable during rebuilds, read-only
access or a proposal preview, so temporary section/leader resolution failures
cannot remove saved annotations. Stable lineage and unique geometry hashes
continue to update dimensions; removed or ambiguous geometry still requires
an explicit re-pick rather than a guessed substitute. Evidence:
`DrawingWorkspace.test.tsx` and `test/e2e/drawing-dimensions.spec.ts`.
