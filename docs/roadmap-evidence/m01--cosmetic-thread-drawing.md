---
row: M01
---

Cosmetic threads drawn in drawing views (no schema change). A cosmetic
thread (slice 4) keeps the tap-drill bore in the model, so no projected
edge shows it; each drawing view now draws it by the ISO 6410-1 convention
(`apps/web/src/lib/drawing/cosmeticThreads.ts`). Every bore of a view's
bodies that a hole with a cosmetic thread drilled is found by its lineage:
the hole's own bore, a bore at a sketch point, or an M02 pattern copy's.
Seen down the bore, the view draws the major diameter as a thin
three-quarter circle with its open quarter upper right, hidden when the
bore opens on the far side. Seen across it, the view draws the major
diameter as two hidden lines along the thread's length and a hidden limit
line across its end. A thread stopped short starts at the bore's end on
the hole's entry face, read from the plane its stored face reference
records (`HoleCallout.entryPlane`, optional). Views that see the bore
obliquely draw none, and so do section views, which would need the
thread's own section convention. The threads are drawn on screen and in
PDF, SVG and DXF exports through `composeSheetPage`, clipped to a detail
view's circle, and read from the model a kept sheet was drawn from until
its Update. Evidence: `test/cosmetic-thread-drawing.test.ts` (on the pinned
kernel, an M6 tap drill in a 10 mm plate: a 6 mm thread in an 8 mm blind
bore read from the entry end; the Ø6 three-quarter circle in the top view
from 90° round to 360°, hidden from below; two hidden lines ±3 off the axis
running 6 down and a 6 wide limit line in the front view; nothing in the
isometric; three threads for a three-copy feature pattern and none for a
plain tap drill; the arc on a composed 1:1 sheet at the view's centre, and
none in a section view).
