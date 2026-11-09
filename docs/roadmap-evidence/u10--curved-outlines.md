---
row: U10
---

Slice 4, curved-surface outlines: cylinders, cones, spheres and fillets now
outline where they turn away from the camera. Interior mesh edges of each
curved face carry both neighbouring normals, and the fat-line vertex shader
keeps only those straddling the view each frame, so the outline is GPU-side
while orbiting and matches the B-rep edges' ink and width
(`packages/viewport/src/render/silhouette.ts`, `silhouette.test.ts`).
