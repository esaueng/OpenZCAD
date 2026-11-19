---
row: U11
---

A refused in-place Fillet radius or Chamfer distance no longer sends its
chip and keypad far off the model. The edge arrow had been drawn at the
refused value (a 1000 mm radius stood 1000 mm along it, at the canvas
edge). It now stands on the value the kept preview built from, at the edge
being edited, while the chip and its keypad still read the refused value
so it can be tapped and fixed. Face Offset and Extrude do not share this
path: their arrows are the viewer's own offset and region rigs, and face
Offset already draws its arrow at the displayed move while the chip reads
the typed value. The selection-first Fillet keeps its last valid radius on
its chip. Coverage:
`useInPlaceCommand.test.tsx` and the Chromium smoke case
`test/e2e/in-place-refused-value-chip.spec.ts`.
