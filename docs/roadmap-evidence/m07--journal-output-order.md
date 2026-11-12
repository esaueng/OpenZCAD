---
row: M07
---

Move-face journals are read by the kernel's own events, not output position:
`resolveOperationOutput(op, 'face', i)` is the `i`-th result face and names no
source, so the reader had swapped corner-band names across an imported rounded
block on a face-distance edit. Sources are now tagged and carried with
`propagateAttributesForOp`; boss-resize history, now correctly paired, is still
refused because legacy documents store misplaced names for those faces
(ADR-013 M07 amendment; `move-faces-journal-face-map.test.ts`,
`test/face-distance-lineage.test.ts`, `test/cylinder-resize-face-lineage.test.ts`).
