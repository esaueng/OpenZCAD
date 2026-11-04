---
row: K08
---

Through-hole enlargement now rebuilds the shared bore/cone rings after a
shrink, preserving the existing cone carrier and outer mouth while they
remain. The native edit requires complete coaxial bore rings, retained trims
outside both radii, and analytic separation from unrelated surfaces. Cases
that change that topology use a cutter spanning the entire body along the
bore axis, so its end caps cannot leave shelves or pockets below the chamfer.
An enlargement beyond the outer mouth consumes the chamfer cleanly; it does
not preserve the mouth's width or move its outer rim.

`test/through-hole-chamfer-resize.test.ts` covers shrink/re-enlarge sequences
on one and two mouths, native and STEP inputs, before and beyond the outer
rim, exact volume, face census, bore length, watertight mesh, immutable input,
STEP round-trip, and tilted/mirrored 30/60-degree chamfers. Exact coincidence
with the outer rim still refuses on the pinned kernel without changing the
source; no diameter or tolerance is nudged to bypass that refusal.

`test/e2e/through-hole-chamfer-resize.spec.ts` checks the visible worker
preview and applied result through a shrink, outward drag, larger exact
entry, undo/redo, and device-storage reload. Face counts and axial length
detect the old hidden cutter-cap shelf independently of the diameter label.
Stored UV traces and unproved native widening clearances remain outside the
local reconstruction family and require a successful exact boolean.
