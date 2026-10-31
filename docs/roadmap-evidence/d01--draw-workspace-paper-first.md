---
row: D01
---
Draw workspace "paper first" layout (design direction A, chosen 2026-10-31):
sheet tabs, the sheet's sync state, zoom and Export PDF/SVG over the sheet in
place of the left sheet column and the panel-bottom export; annotation tools
on a floating icon rail beside the paper with one-key shortcuts (H, V, A, R,
D, G, N; Esc backs out of a tool, then a selection); a contextual properties
panel (sheet settings, or the selected view's or annotation's); editor view
names at a readable on-screen size; while the model rebuilds, the sheet keeps
its last drawing faded, with the rebuild's feature progress, and stays
unexportable; and an editor-only dark paper toggle (per device) that never
reaches PDF or SVG. Evidence: `DrawingWorkspace.test.tsx` (faded last
drawing while rebuilding, tool keys taken ahead of the workspace shortcuts
and never from a field, dark paper remembered) and the drawing e2e specs
updated for the moved controls.
