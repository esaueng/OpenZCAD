---
row: U08
---

Issue #951: new in-place creation commands suspend model panels and More tools
using the command's stable session identity. Explicit panel/tool requests last
through picks, values and previews, and reset on the next command, including a
relaunch of the same tool or Extrude on the same sketch. Cancel and Done restore
the stored docks, floating windows, unpinned panels and fold without reframing
the camera or changing preferences. Build-only guards, Move and direct drags
retain their existing behavior. Browser coverage is in
`test/e2e/panel-suspension.spec.ts`; existing reference-picking and History
journeys explicitly request the panels they read.
