---
row: U08
---

Production design review (PR #890): feature forms suspend model panels and the extra-tools fold while preserving the saved layout and camera. Explicit panel requests override suspension for their editing session; direct switches between sketch or feature sessions reset the release. Header controls own their full 24px hit rectangles in both themes (`usePanelSuspension.test.tsx`, `design-review-fixes.spec.ts`, `panel-dock.spec.ts`).
