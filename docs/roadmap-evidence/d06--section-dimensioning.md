---
row: D06
---

Slice F: section-aware dimensioning. The checker and Auto-dimension measure a
D03 section view's exact cut edges, so a position inside the part (a bore's
floor, a pocket's depth) is stated and placed on the visible cut instead of
on hidden lines or a rim's hidden silhouette; a requirement only a section
marks is reported as "which only section A-A shows". What Auto-dimension can
place only on hidden lines is named in its preview ("Add a section through
the part to dimension … on visible lines"); it never adds a section itself.
A section the kernel cut from the tessellation carries no dimensions and the
advice says so. Evidence: `test/drawing-section-dimensioning.test.ts` (real
kernel: a Ø20 × 30 bushing with a blind Ø8 bore gets 0–12 and 0–30 on section
A-A with zero missing, redundant and unmeasurable, and a 30 − 12 depth is
flagged as a closed chain; a pocketed block's floor moves from hidden lines
onto the section; the turned foot's advice, and its exact cut refused on the
pin) and `DrawingWorkspace.test.tsx` (Auto-dimension places Y on a section).
