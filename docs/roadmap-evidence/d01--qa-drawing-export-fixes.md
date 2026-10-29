---
row: D01
---
Production QA drawing fixes: views are flagged by their whole footprint and
export is refused while one runs off the paper, with an undoable "Fit views to
sheet"; the composed page and PDF are clipped to the paper; the title block
prints a full ISO date; ⌀ and other common symbols print as Latin-1 stand-ins
with a warning for the rest; the sheet zooms and pans; view labels are
documented as editor-only (`test/drawing-sheets.test.ts`,
`DrawingWorkspace.test.tsx`).
