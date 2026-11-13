---
row: U03
---

Sketch findings of the 13 November design review
(`docs/reviews/design-review-2026-11-13.md`): a refused dimension or relation
no longer paints the committed sketch as conflicted and names the refused
value, never itself as its culprit (I35); a sketch re-opened from History or
the Inspector starts in Select, and a sketch row opens on double-click (I36);
a tool's type strip is a column against the rail that folds away on the
first canvas press (I37); the committed sketch is classified after each
change, its fully constrained edges turn green without a manual Solve, and a
DOF chip with a colour legend stays under Solve (I38); a selected line takes
a driving length from Distance or the new Dimension key (D), and Construction
has X (I39, I46); the view pans a selection clear of its editor (I40); under
600px a sketch keeps Undo, Redo and the relations in the right column (I41);
Extrude from a sketch preselects only regions outside holes and its Cancel
returns to the sketch (I42); Parallel, Perpendicular, Concentric and Arc have
their own glyphs (I44); and sketch copy uses people's names ("corner 2 of
Rectangle 1", "end of Line 3"), labels length fields in document units and
the text size "Em size (mm)" (I10, I11). Coverage:
`test/e2e/sketch-review-fixes.spec.ts`, `objectLabels.test.ts`,
`extrudePreselect.test.ts`, `SketchToolRail.test.tsx`,
`HistoryTimeline.test.tsx`, `machine.test.ts`, `prompt.test.ts`.
