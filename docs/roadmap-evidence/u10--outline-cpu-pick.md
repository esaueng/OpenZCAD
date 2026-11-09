---
row: U10
---

Curved-surface outlines are now picked on the CPU when the view changes and
draw only the segments on the outline. Drawing every candidate each frame put
58,957 fat-line quads per frame on a filleted sleeve, which slowed
`rotational-direct-edits` past its budget on CI's software rasterizer. That
part now draws about 560 instances per frame instead of 59k, picking costs
about 1 ms per view change, and the lookdev captures are pixel-identical
(`updateSilhouette` and `installSilhouetteUpdates` in
`packages/viewport/src/render/silhouette.ts`, `silhouette.test.ts`).
