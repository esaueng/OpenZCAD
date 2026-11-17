---
row: D07
---

Slice B, fits, thread classes and general tolerances (schema v105, built on
v101 (#1739); [design](docs/plans/drawing-gdt-design.md#slice-b-fits-thread-classes-and-general-tolerances-schema-v105)):
a diameter may state an ISO 286 fit class, printed with the limit
deviations ISO 286-1 tables 1–3 state for the size the model has now
("Ø8 H7 +0.015/0"; holes F, G, H, JS and shafts f, g, h, js, k, m, n, p,
grades 5–11, up to 500 mm, others refused by name rather than guessed), and
a tapped hole's callout an ISO 965 or UN internal thread class
("M6×1-6H"), broken by name on a plain bore (`not-threaded`) or the other
system's class (`thread-class-mismatch`). The General tolerances tool (W)
places a ruled block printing the ISO 2768-1 linear and angular tables for
class f, m, c or v (with an ISO 2768-2 class), or ± per number of decimals
written and on angles in the sheet's units. Evidence:
`test/drawing-fits.test.ts` (ISO 286 limits against eighteen table values
including range edges, exact ±IT/2 for js and JS, and k above IT7; validation by name; on
kernel bodies Ø8 H7 and g6, Ø25 g6, inch and decimal-comma sheets, a 520 mm
pin out of range; an M6 tapped hole classed 6H, refused 2B, a plain tap
drill not threaded and reamed H7; the ISO 2768 v/m tables and an inch stated
block; layout, SVG, PDF and DXF; the tool draft, undoable commands and the
v104 gate), `DrawingWorkspace.test.tsx` (the block drawn, its class and
scheme changed) and `test/e2e/drawing-fits.spec.ts` (a pin's diameter fitted
H7 and an ISO 2768-mK block placed, exported to SVG and reopened).
