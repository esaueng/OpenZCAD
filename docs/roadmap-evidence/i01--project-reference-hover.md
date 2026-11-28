---
row: I01
---

The Project tool lights the model edge or face under the pointer before the
click, only when the click would take it as a reference; sketch geometry,
regions and empty space get no highlight, touch shows none, and leaving the
tool drops it (`apps/web/src/components/viewer/sketchReferencePick.test.ts`,
`test/e2e/sketch-reference-hover.spec.ts`).
