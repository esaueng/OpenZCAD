---
row: M01
---

Hole tables on drawing sheets (schema v117, up from v116). A `hole-table`
drawing annotation names one view and its place; everything it prints is
read from the model each time the sheet is drawn. Every bore the view sees
down its axis is a row: a hole's own bore, a bore at a sketch point, or an
M02 pattern copy's, found by its face's lineage (`holeOfBoreFace`). Each row
has a tag, X and Y, and a size. Tags take a letter per size, smallest first,
and a number per bore within it, left to right, then bottom to top. X and Y
are measured in the view from the lower-left corner of its bodies' bounding
boxes, in the sheet's number format. The size is the hole's callout written
once per bore (`Ø5 THRU, M6×1 TAP DRILL`). The table is ruled as a parts
list is, and the view carries each tag up and right of its bore's rim. A
view that sees no bore down its axis leaves the table broken, with a reason
that says to place it on a view looking into the holes. Refused: a table
with no view, one stating a value of its own, and below v117 by the content
gate. UI: Add hole table in Sheet Properties (or Y; the phone-width annotation rail has no row to spare, as for general tolerances). One click takes
the view, the next places the table's top-left corner, which then moves
with its view. The table is drawn on screen and in PDF, SVG and DXF exports.
Evidence: `test/hole-tables.test.ts` (the stored shape and its refusals;
the v117 gate; the tool's two clicks; on the pinned kernel a 60 × 40 plate
with a Ø8 hole and an M6 tap drill repeated by a linear pattern, read in the
top view as A1 40/10 and A2 50/10 `Ø5 THRU, M6×1 TAP DRILL`, B1 15/20
`Ø8 THRU`, the B1 tag beside its bore; broken in the front view);
`test/e2e/hole-table.spec.ts`, which drills a hole in place, chooses Add hole
table in Sheet Properties, clicks the top view and then the paper, and finds the A1 row at
20/15 with its tag in the view and the stored table on that view.
