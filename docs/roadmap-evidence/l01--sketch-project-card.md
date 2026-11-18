---
row: L01
---

Project cards draw saved sketch curves and points when a model has no live body meshes. Reopening a sketch-only project replaces a cached empty preview, and Settings redraw can rebuild the same card. Regression coverage includes a cached empty card, an open curve on an offset plane, and a sketch-only card across browser reload (`projectThumbnailCapture.test.ts`, `partThumbnailRenderer.test.ts`, `projectThumbnailRegeneration.test.ts`, `project-thumbnails.spec.ts`).
