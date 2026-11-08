---
row: U10
state: Partial
---

Slice 1, no visual change: `OZ_LOOKDEV=1` builds the production renderer and
`test/e2e/viewport-lookdev.spec.ts` captures five fixed scenes
(`test/fixtures/lookdev-scenes.ts`) from three view-cube corners at device
pixel ratio 2, canvas only, into `artifacts/lookdev/<label>`;
`scripts/lookdev-compare.mjs` builds a click-to-flip before/after page
(`test/lookdev-compare.test.ts`). `isBodyMaterial()` replaces the
`MeshPhongMaterial` class checks that gated body buffer reuse and the
selected-face fill, pinned in `bodyUpdate.test.ts`. Baseline captures taken
locally at `3da524a4`.
