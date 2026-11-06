---
row: K08
---

2026-11-05 WS6 ladder step 2 for a cylindrical wall resize: remove the blends
incident to the wall, resize the sharp wall, rebuild the blends
(`exact-direct-edit-reblend.ts`). It runs only after the plain resize refuses.
Recognition reads every curved neighbour of the wall through the kernel's
`getBlendRegion` proof and requires each band to roll between the wall and one
exact plane or cylinder support carrier; a chamfer, sphere, freeform or
partial band fails closed and the original typed refusal stands. Bands are
removed with `resizeBlend(…, 0)`, rebuilt exact-only (`filletDetailed`) and
accepted only when the rebuilt bands are proven regions of the recorded
classes and radii, the re-blend volume mirrors the removal, and the existing
`assertWallResizeAccepted` gates pass. The result is one direct-edit row with
no output lineage claim (faces re-resolve by fingerprint). K10 on Remus
`2026.1.123`: six cells move from typed refusal to qualified against
independent oracles, with no other state change: box×cylinder fillet-seam
`direct-grow` (aligned and off-centre, union and subtract) and the imported
twin's upright R2 `wall-grow` / `wall-shrink`, so R1–R3 now pass on the
upright synthetic twin. Tilted and chamfered-seam R2 cells are unchanged
(`exact-direct-edit-reblend.test.ts`, `cylinder-radius-across-boolean.test.ts`).
