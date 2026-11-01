---
row: I02
---
STEP export half of names and colours: the file is AP214
(`AUTOMOTIVE_DESIGN`), the product is the document name, each solid is named
after its body and styled in its display colour (one shared `COLOUR_RGB`
chain per colour), and the header carries the saved file name, the export
time (UTC) and OpenZCAD as the originating system instead of the writer's
`remus_solid`/`output.stp`/2024 placeholders; reals are written in their
shortest exact form with zero residue dropped from points and directions.
Evidence: `step-export-metadata.test.ts`, the rewritten writer-boundary case
in `i02-step-metadata-qualification.test.ts` (names and colours resolved to
the right solid through its faces), the STEP row of the exchange loss
contract now keeping names and colours, and the File › STEP e2e header check.
OpenZCAD's own STEP import does not yet apply them to bodies.
