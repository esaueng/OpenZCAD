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
three-quarter circle, open quarter upper right, where the bore's nearer end
opens toward the viewer with nothing of the view's bodies in front of it
(a ray against their display meshes); it is hidden otherwise. Seen across
the bore, the view draws the major diameter as two hidden lines along the
thread's length and a hidden limit line across its end. Which end of a
bore is its entry is read from the model as it stands: a blind bore opens
at the end its floor (a drill point or a flat disc) does not close; a
thread stopped short in a through bore starts at the end on the hole's
entry face, found now by the name its stored reference gives
(`HoleCallout.entryFace`, optional); a bore where that cannot be settled
draws no thread rather than a guessed one. Views that see the bore
obliquely draw none, and neither do section views and views of another
configuration row. A view drawn without hidden lines draws no hidden thread
line. The threads are drawn on screen and in PDF, SVG and DXF exports
through `composeSheetPage`, clipped to a detail view's circle, from the
model a kept sheet was drawn from until its Update. Evidence:
`test/cosmetic-thread-drawing.test.ts` (on the pinned kernel, M6 tap
drills in a 10 mm plate: a 6 mm thread in an 8 mm blind bore read from its
open end; the Ø6 three-quarter circle from 90° round to 360°, thin from
both sides of a through bore and hidden under a blind one's floor; a 4 mm
thread in a through bore starting on the entry face; the arc hidden under a
lifted cover body and seen without it; two hidden lines ±3 off the axis
running 6 down and a 6 wide limit line in the front view, none without
hidden lines; nothing in the isometric, a section or another configuration
row; three threads for a three-copy feature pattern and none for a plain
tap drill; the arc on a composed 1:1 sheet at the view's centre).
