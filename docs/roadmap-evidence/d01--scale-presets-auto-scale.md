---
row: D01
---
Sheet scales and Auto scale: the scale list gains the ISO 5455 enlargements
50:1 and 20:1 and the common intermediates 4:1, 1:4, 1:8, 1:25 and 1:250 (the
starter and "Fit views to sheet" pick from the same list, so they can land on
these). A new undoable **Auto scale** action lays the sheet's views out again
as an evenly spaced grid at the largest preset at which the grid fits above the
title block: views whose centres share a row or column keep sharing it, so
projected views stay aligned, but the gaps are set afresh, so views that
overlap or sprawl after a scale picked by hand come out clean, and a sheet
shrunk by hand grows back to fill the paper. Evidence: `test/drawing-sheets.test.ts`
("auto scales views to the largest preset, spaced evenly in a grid"),
`DrawingWorkspace.test.tsx` (preset list, one-command Auto scale with status).
