---
row: D01
---

13 November design review, Draw (I62–I66 and the Draw half of I2): a sheet
tab's menu (right-click, Shift+F10 or the visible Sheet actions button)
renames, duplicates, moves and deletes the sheet; F2 or a double-click
renames in place and a tab drags to reorder, one undo step each. A move is
the existing sheet delete and add commands, so an older client replays it
exactly and the document schema is unchanged. A new sheet
takes the next unused "Sheet N". The title block's SHEET cell prints "2 / 3 ·
Details" instead of the paper size. Changing Paper or Orientation lays the
views out again on the new paper in the same undo step, so a smaller sheet
no longer leaves views off the page and export refused. Add view offers the
first orientation the sheet lacks and puts a view with no base in the free
space nearest the middle, clear of the others. A plain wheel zooms the
sheet as in Build, through Build's wheel classifier, pointer-navigation
setting and remembered device. Bill-of-materials rows lose the hover fill
that implied an action. Deleting a sheet or a view says what went ("Deleted
Front view, Section A-A and 4 dimensions.") with Undo. Coverage:
`sheetEdits.test.ts`, `DrawingSheetTabs.test.tsx`,
`DrawingWorkspace.test.tsx`, `test/drawing-sheet-review.test.ts` and
`drawings.spec.ts` in the browser. Open: exporting all sheets as one PDF.
