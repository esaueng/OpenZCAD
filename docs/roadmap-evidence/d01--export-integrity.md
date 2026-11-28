---
row: D01
---

Export integrity: a sheet drawing a body that stands in for a feature that
failed to rebuild is never marked up to date, never updated and never
exported, and names the failed feature (#2382), in the active build or in
the build of a configuration row a view is pinned to (the row is built
before an Update, or a view's move to it, saves the sheet's fence, and a row
the model cannot build holds the fence back the same way), and across a
suppressed step that hands the failed feature's input on under its own id,
where an edit ahead of it is refused only for a failure it newly causes; an annotation laid out
past the paper's edge refuses the export by name instead of printing cut or
missing, by the one edge rule the page draws with, pictures included
(#2166); a view's hidden pieces are deduplicated and joined where they are
pieces of one projected edge (recorded by the projection) or the line
carries straight on from one edge to the next, so the dash runs on along a
curve and a hidden port no longer prints solid, while edges that meet at a
corner stay separate runs (#2073); a section cut from the tessellation
carries an approximation note beside its caption in SVG, PDF and DXF, placed
on the paper clear of the page's other marks, or the export is refused by
the section's name (#2110); and a section's properties
describe the cut from its own drawing state rather than calling a refused
cut exact (#2107). `test/drawing-export-integrity.test.ts` reads each back
out of the exported SVG, PDF and DXF; `DrawingWorkspace.test.tsx` and
`DrawingWorkspace.pinnedRows.test.tsx` cover the workspace refusals, and
`failedHistoryExport.test.ts` the suppressed pass-through.
