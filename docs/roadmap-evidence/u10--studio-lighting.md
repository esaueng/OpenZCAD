---
row: U10
---

Slice 2, lighting and material: bodies are `MeshStandardMaterial` (roughness
0.52, dithered) lit by `STUDIO_RIG` (`packages/viewport/src/render/studio.ts`):
a smooth Z-up gradient environment, a key light that turns with the camera,
a dim world-fixed shadow key, a dark floor bounce and `NeutralToneMapping`.
Tops, walls and undersides now separate by value from every lookdev corner
with no tessellation crawl; thumbnails and the exact section fill share the
rig. Contracts: `ViewportShading.test.ts`, `partThumbnailRenderer.test.ts`.
