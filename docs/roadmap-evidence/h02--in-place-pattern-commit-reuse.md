---
row: H02
---

QA 2026-11-14 finding #16: an in-place pattern's Done commits the command its preview built (same ids and name) with that preview's exact result, instead of rebuilding the whole history again in a cold disposable worker. The preview is built with the live lineage demand, so the live rebuild after Done restores it from its checkpoint (`test/pattern-preview-commit-reuse.test.ts`). Closing the card cancels the preview's worker job (`useGeometryWorker` `syncOnce` signal), the card's Cancel stops a pattern Done still rebuilding, a slow preview counts its seconds, and Done applies a count still being typed in Options (`test/e2e/in-place-axis-picks.spec.ts`).
