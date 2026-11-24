---
row: L08
---

Tweak links without history: leaving history out and choosing Tweak shares the model's recipe (`tweakableShareDocument`: features and sketches renamed `Feature N` / `Sketch N`, imported file names replaced, no save state, undo history, command log, drawing, reference image or stored import source) instead of imported solids. The Worker stores it in the frozen-model slot and holds the link's mode to the model (`frozenShareLinkMode`, `tweakableShareDocumentProblem`); encrypted links keep the `frozen` grant and visitors read tweakability from the owner-signed model. Visitors tweak parameters without a feature list, and Make a copy freezes the tweaked model to imported solids. The recipe stays in the visitor's browser: the feature list is hidden, not removed (`test/share-link-without-history.test.ts`, `test/e2ee-share-links-without-history.test.ts`, `test/e2e/tweak-link-without-history.spec.ts`).
