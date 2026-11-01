---
row: D01
---
Sheet tabs scale to many sheets: one row that scrolls sideways (edge fades
mark hidden tabs, a plain wheel scrolls it, the active tab is kept in view)
instead of wrapping into rows that pushed the zoom and export controls down;
an "All sheets" list once the row overflows (number, name, paper, scale, view
and note counts, opened at the active sheet); the paper tag shown only when
sheets differ in paper; arrow keys, Home and End move between tabs and only
the active tab is a Tab stop. Evidence: `DrawingSheetTabs.test.tsx` (paper
tag only on mixed paper, arrow-key selection, list only when overflowing).
