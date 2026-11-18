---
row: U11
---

A blind, one-sided Extrude can explain when Section View clips its entire
change. Auto reuses the bounds of its standalone sweep, and an explicit New
body uses its result bounds. The advisory follows the current accepted preview
and the active clipping plane.

Show full model turns off the cut while retaining the Extrude draft and camera.
The existing Section View control brings back the same cut in the project
session. The browser regression checks keyboard recovery, live numeric entry,
Cancel, and the committed Cut's History through Undo, Redo, and reload
(`test/e2e/extrude-section-recovery.spec.ts`).
