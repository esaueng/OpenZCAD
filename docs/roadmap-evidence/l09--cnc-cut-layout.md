---
row: L09
---

CNC-cut layout (docs/cnc-layout.md): File › CNC DXF (palette: Export CNC cut
layout (DXF)) writes the export's bodies, unchanged in the document, laid flat
on their largest planar face (ties to the face facing furthest down), every
planar face then looking straight up projected exactly onto the bed as
LINE/CIRCLE/ARC (polylines only for ellipses and splines), one `Z<height>`
layer per face height in the export unit to 1 µm (a top face must be
parallel to the bed and flat across its vertices), seams between coplanar top faces
left out, parts in rows 10 mm apart with their body names on `LABELS`. Parts
with no flat face or no upward face, and mesh references, are named in the
status; with none left the export refuses by name. A row layout, not nesting;
side walls, slopes and undercuts are not represented. Evidence:
`test/cnc-layout.test.ts` (real kernel: a counterbored plate on `Z10`/`Z7`, a
puck on its cap, a sphere refused, a 0.02° slope refused, a big plate
resting on its intact side; inch output, byte-stable, read back through
the DXF importer), `apps/web/src/lib/cncLayoutDxf.test.ts`,
`test/e2e/cnc-layout.spec.ts`.
