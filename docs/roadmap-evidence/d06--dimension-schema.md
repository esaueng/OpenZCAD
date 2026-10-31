---
row: D06
---

Slice B, schema v46 (builds on v44; v45 is D03's claim): Draw annotations can
now dimension a turned or chamfered part. A rim seen side-on is picked as its
silhouette end (`silhouette` point), two face outlines as their virtual sharp
(`virtual-sharp` point, from the kernel's exact planes, cylinders and cones),
and a cone or edge-on plane as a Chamfer dimension (`size × angle`, through
blends). Radius, diameter and chamfer dimensions take a count (`4×`), a linear
span a Ø prefix, any dimension a reference flag (brackets), and any annotation
generated provenance. Older clients refuse the document; load, save and the
account edge refuse malformed additions by name; nothing stores a value. The
checker now counts rim silhouettes as position marks, a symmetric Ø span as a
diameter or bolt-circle pitch, and chamfer dimensions as chamfer groups: the
turned foot's Z positions, both chamfers and a bolt circle's pitch move from
"can't dimension yet" to satisfiable, and a seven-dimension foot sheet passes
with nothing missing or redundant. Evidence: `test/drawing-dimension-schema.test.ts`
(real kernel bodies: the foot as a revolved profile, a planar chamfer, a
two-hole plate; refusals; SVG/PDF byte-stable across a reload; picking),
`test/drawing-dimension-audit.test.ts`, and the e2e in
`test/e2e/drawing-dimensions.spec.ts` picking a cylinder's rims for its height
and a reference Ø.
