---
row: S06
---

Normal to sketch returns the camera to the active sketch plane at its
current zoom and target. It uses the sketch plane's standard roll and
keeps the active tool and draft gesture.
Chromium covers the projection switch during entry, preserving perspective
after a cancelled glide, and finishing a circle after changing views and
returning to the sketch plane (`test/e2e/sketch-face-orientation.spec.ts`).
