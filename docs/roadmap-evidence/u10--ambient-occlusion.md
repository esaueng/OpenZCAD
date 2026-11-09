---
row: U10
---

Follow-up, ambient occlusion: settled-frame contact shading in concave
corners (`render/ambientOcclusion.ts`). It is computed once the view has
rested for 150 ms, at half resolution (capped at 1.6 MP), with a
tangent-plane estimator that leaves planar and convex faces untouched, and is
applied inside the body shader so edge ink, overlays and the stage never
darken. Moving frames cost nothing (measured: orbit CPU unchanged, a
sub-microsecond camera check); the settle costs 7–19 ms of GPU once on an
Intel UHD at an iPad Pro 12.9" canvas (2048 × 2732, 128 bodies). Off in
X-ray, wireframe, E2E builds and off-canvas renders; `AMBIENT_OCCLUSION.enabled`
and `window.__ozAmbientOcclusion = false` turn it off
(`ambientOcclusion.test.ts`, `renderProfile.test.ts`).
