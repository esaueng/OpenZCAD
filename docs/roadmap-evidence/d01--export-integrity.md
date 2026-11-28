---
row: D01
---

Export integrity: a sheet drawing a body that stands in for a feature that
failed to rebuild is never marked up to date, never updated and never
exported, and names the failed feature (#2382); an annotation laid out past
the paper's edge refuses the export by name instead of printing cut or
missing (#2166); a view's hidden pieces are deduplicated and joined so the
dash runs on along a curve and a hidden port no longer prints solid
(#2073); a section cut from the tessellation carries an approximation note
beside its caption in SVG, PDF and DXF (#2110); and a section's properties
describe the cut from its own drawing state rather than calling a refused
cut exact (#2107). `test/drawing-export-integrity.test.ts` reads each back
out of the exported SVG, PDF and DXF; `DrawingWorkspace.test.tsx` covers the
workspace refusals.
