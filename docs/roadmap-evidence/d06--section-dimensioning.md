---
row: D06
---

Slice F: section-aware dimensioning. The checker and Auto-dimension measure a
D03 section view's exact cut edges, so a position inside the part (a bore's
floor, a pocket's depth) is required, stated and placed on the visible cut
instead of on hidden lines or not at all; a requirement only a section marks
is reported as "which only section A-A shows". A position marked only by
circles seen edge-on asks for a section through their axis, and the
Auto-dimension preview says "Add a section through the part to dimension …"
for those and for anything it had to put on hidden lines; it never adds a
section itself. A section the kernel cut from the tessellation has no edges
and is named as such. Evidence: `test/drawing-section-dimensioning.test.ts`
(real kernel: Ø20 × 30 bushing with a blind Ø8 bore placed 0–12 and 0–30 on
section A-A with zero missing and zero redundant, and a 30 − 12 depth flagged
as a closed chain; a pocketed block whose floor moves from hidden lines onto
the section; the turned foot's advice, and its exact cut refused on the pin)
and `DrawingWorkspace.test.tsx` (Auto-dimension places Y on a section).
