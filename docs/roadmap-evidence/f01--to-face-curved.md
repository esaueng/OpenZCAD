---
row: F01
---

Curved to-face slice: schema v131 adds `toSurface` beside `toFace` on a
to-face extrude (exactly one of the two). It names a cylindrical face by
verified lineage, as a wrap names its face, with a pick-time centroid the
editor reads before a build. Each rebuild re-finds the face with the wrap's
lineage resolver and reads its exact cylinder, then sweeps from the start
plane past the face's body. It keeps the near side of the cylinder: from
outside, the regions left when an exact solid cylinder is cut away; from
inside, the regions common with it; either way only those standing on the
start plane. The way to the face is the side its middle lies on; from inside
a whole cylinder, where that is level with the start, the stored distance's
sign (Reverse) decides. An offset from the face changes the cylinder's
radius toward the start, and a start offset and a draft apply. A deleted,
ambiguous or non-cylindrical face (a cone), or a cylinder whose axis runs
along the extrusion, reads as unresolved, which a re-pick repairs; a
re-pick can also swap a planar face for a curved one and back. A profile that
passes the cylinder by refuses by name. The viewport's to-face pick now
takes a cylindrical face, and the prompts ask for a face facing the sketch.
Regression evidence: `test/extrude-to-face-curved.test.ts` (closed forms
4 · (120 − ∫√(100 − x²)) under a radius-10 log, a radius-12 offset, a start
offset, from inside the log, a moved log followed, a profile passing it by,
a deleted log unresolved, a cradle cut into a block; entry refusals and a
byte-identical load) and the `@ci-smoke` case in
`test/e2e/extrude-to-face-draft.spec.ts` (the log's wall picked in the
viewport, 321.07).
