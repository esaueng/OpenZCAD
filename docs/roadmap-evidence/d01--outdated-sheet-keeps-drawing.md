---
row: D01
---
A sheet whose model changed keeps its last drawing (views, dimensions on that
model, export) for the session behind one compact "Model changed · Update"
pill instead of a full-width banner and outlines; undoing an Update restores it
(`DrawingWorkspace.test.tsx` "keeps the earlier drawing usable after a model
change until Update", `drawings.spec.ts`, `drawing-dimensions.spec.ts`).
