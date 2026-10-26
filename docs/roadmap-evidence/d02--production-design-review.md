---
row: D02
---

Finishing-body repair (PR #890): an explicit, undoable sheet Update follows unique one-to-one hole/fillet/chamfer/shell/draft/offset results, retaining subshape witnesses, annotation placement and export guards. Additive Thicken results are excluded. Missing, ambiguous and removed edges still require repair. Draw-mode revision saves use the drawing permission guard; new-sheet controls wait for ready geometry. Documents use schema-v39 (built on v38) to fence replay from older clients that would ignore body replacements. Tests: `test/drawing-body-succession.test.ts`, `DrawingWorkspace.test.tsx`, `design-review-fixes.spec.ts`. Production verification remains pending.
