# CNC cut layout

L09's CNC hand-off: _File › CNC DXF_ (or _Export CNC cut layout (DXF)_ in the
command palette) writes the export's bodies — the selection, or every shown
body — laid flat as one DXF R12 file for a laser cutter or router's CAM.

## What it does

1. **Copy.** The bodies are read from the build; the document is not changed.
   A body with several solids gives one part per solid.
2. **Lay flat.** Each part rests on its largest planar face. When two faces
   tie (a plate's two sides), the one whose outward normal points furthest
   down in the model wins, so a part modelled lying flat keeps its
   orientation.
3. **Project the top faces.** Every planar face that then looks straight up
   is projected onto the bed. A top face is parallel to the bed, so the
   projection is exact: lines, circles and arcs are written as `LINE`,
   `CIRCLE` and `ARC`, and only curves R12 cannot carry (ellipses, splines)
   as polylines within 0.02 mm. An edge shared by two coplanar top faces is
   a seam, not an outline, and is left out.
4. **Layers by height.** Each face height above the bed gets its own layer,
   named `Z` and the height in the export unit to three decimals, with `_`
   for the decimal point (R12 layer names cannot hold a `.`): a 10 mm plate
   with a 3 mm deep counterbore cuts its outline and the counterbore on
   `Z10` and the counterbore floor and the hole on `Z7`. A CAM template maps
   each layer to a depth.
5. **Arrange.** Parts are placed left to right in rows about as wide as the
   layout is tall, 10 mm apart, each with its body name as text on `LABELS`
   under it. This is a row layout, not nesting: parts are not rotated or
   packed into each other's gaps.

The file states its unit (`$INSUNITS`), which follows the export unit
setting like every other export.

## What it leaves out

A part with no planar face (a sphere), or with no planar face looking
straight up once laid flat (a wedge resting on its base), is left out and
named in the status; when nothing is left the export refuses with those
names. Mesh references have no exact faces and are left out too.

Only faces that look straight up are cut. Sloped and curved surfaces, side
walls, undercuts and draft are not represented: a chamfered top edge shows
as the smaller top face, not the stock outline. The file is a 2.5D cut
layout, not a toolpath.

Tests: `test/cnc-layout.test.ts` (real kernel bodies: a counterbored plate on
two height layers, a cylinder on its cap, a sphere refused; units,
determinism, read back through the app's DXF importer),
`apps/web/src/lib/cncLayoutDxf.test.ts` and `test/e2e/cnc-layout.spec.ts`.
