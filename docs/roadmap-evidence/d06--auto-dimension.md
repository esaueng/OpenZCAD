---
row: D06
---
Slice C, the Auto-dimension command: Draw's Dimension check has an
Auto-dimension button that, with no assistant, previews on the sheet exactly
the dimensions the check finds missing and adds them as one undoable command
on Apply. It reads the checker's own requirement model: one radius or
diameter per unstated size group, and per model axis one baseline dimension
from the lowest datum position to each group of positions not yet linked, so
it closes no chain and states nothing derived. Each goes in a principal view
that sees it true size and visible, preferring the view holding the body's
other dimensions (never the isometric view), on edges whose identity no other
edge shares. Linear dimensions stack outside their view, shortest nearest the
part; nothing overlaps text, other views or the title block, and all stays
on the paper. Existing dimensions are kept and counted; what the check
cannot place yet is skipped and reported. Evidence:
`test/drawing-auto-dimension.test.ts` (on real kernel bodies — box, stepped
part, 2 × 2 hole plate, bolt-circle flange, rounded corner, turned foot:
after Apply the check reports zero missing and zero repeated, every layout is
clash-free, a rerun adds nothing, a user's dimension is kept) and
`DrawingWorkspace.test.tsx` (preview, Apply as one transaction, Escape
cancels, disabled for viewers).
