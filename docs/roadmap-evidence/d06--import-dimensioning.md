---
row: D06
---

Slice D, schema v49 (builds on v48, slice B): Auto-dimension dimensions a
history-less STEP import from the features its faces show. The plan's turned
foot, exported through the kernel and re-imported (11 analytic faces, no
history), gets exactly the plan's eight dimensions: Ø40, Ø33, Ø25, 2× 4 × 45°,
3× R4, 9, 29 and 50, with no blend tangent height, no Ø32 and no 3.5. The
checker groups a step chamfer that runs into a smaller diameter with an end
chamfer of equal angle on the same diameter, and locates it at the corner it
cut (a new `chamfer-corner` point, the 29). It also states revolved blends
from their torus face seen side-on (a radius dimension on a face, `3× R4`),
and calls blend tangent heights, a chamfer's own sharps and the contact Ø32
derived. Auto-dimension now places counted chamfer and blend dimensions and
counted diameters, and gives every dimension it places provenance naming its
requirement. On an import, provenance marks a span to a face no feature
explains as raw geometry (`basis: 'geometry'`), and the preview and inspector
say so. Evidence: `test/drawing-import-dimensioning.test.ts` (the foot import,
a counterbored-plate import and an L-step import whose inner faces are marked,
each placed clear of the rest of the sheet; v49 validation),
`test/drawing-dimension-audit.test.ts` and
`test/drawing-auto-dimension.test.ts`, where the history foot now passes with
eight dimensions as well.
