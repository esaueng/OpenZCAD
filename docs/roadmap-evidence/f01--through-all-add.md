---
row: F01
---

Add-through-all slice: through all now takes an add as well as a cut,
with its one explicit target and a side. It adds no stored field and no
schema bump, and an older client refuses an add through all by name. The
extrusion fills the target's exact span along the sketch normal (forward,
backward or both) and joins the target, so a tab sketched off the target's
edge grows through its whole thickness. Resizing or moving the target changes
the span, and nothing derived is stored. New-body and intersect through all
stay refused at entry, and a side the target does not reach refuses by name.
The Extrude bar offers Through all (and its Direction) on Add, and the status
line reads "Extruded the region through all of the target, added to the
body." Regression evidence: `test/extrude-through-all-add.test.ts` (both
sides 16000 + 80, forward and backward 16000 + 40, a thicker plate followed,
a missed side refused, entry refusals, the editor and the status line) and the
`@ci-smoke` case in `test/e2e/extrude-through-all.spec.ts` (16016 → 16080 →
undo). Remaining: multi-target through all and to-face on a curved face.
