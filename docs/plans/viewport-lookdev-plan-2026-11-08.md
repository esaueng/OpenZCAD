# Viewport look-development plan (8 November 2026)

Roadmap owner: [U10](../../ROADMAP.md#u10).

## Problem

Side by side with a reference CAD tool on the same kind of part, the OpenZCAD
viewport reads flat and washed out. The reference gives each face orientation
its own clear value (tops light, sides mid, fronts dark), carries a soft
highlight across fillets, inks every edge in crisp near-black and outlines
curved surfaces. Ours puts every face in a narrow, bluish band with faint
edges and no outline on a cylinder or sphere.

## Diagnosis (code at `3da524a4`)

| Symptom                                     | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Faces barely separate by orientation        | The body material is `MeshPhongMaterial` (`packages/viewport/src/render/scene.ts`, `createBodyMaterial`). Three.js applies `scene.environment` only to physically based materials, so the PMREM studio environment the viewer builds (`createStudioEnvironment`) never reaches a body. The hemisphere fill's ground colour (`#e2e8f0`) is nearly as bright as its sky (`#d7e6f7`), lifting sides and undersides toward the top-face value. |
| Shading depends on view direction           | The key light is fixed in world space (`ModelViewer.tsx`), so some views light two visible faces identically. Most CAD viewers keep the key relative to the camera.                                                                                                                                                                                                                                                                        |
| Blue cast                                   | Default body `#99a0b2` (`DEFAULT_BODY_COLOR`, design review G2), a cool rim light (`#7aa3d0`) and a cool hemisphere.                                                                                                                                                                                                                                                                                                                       |
| Compressed highlights, shifted body colours | ACES filmic tone mapping.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Faint edges                                 | Tangent (fillet) edges rest at 0.18 opacity (`SELECTION_SEMANTICS.idle.tangentEdgeOpacity`); sharp edges at 1.4 px.                                                                                                                                                                                                                                                                                                                        |
| No curved-surface outline                   | Only B-rep edges are drawn, and a cylinder's or sphere's visible outline is not one.                                                                                                                                                                                                                                                                                                                                                       |
| Low-contrast stage                          | Near-black backdrop and a faint grid (`--color-stage-*` tokens, read by `apps/web/src/lib/stagePalette.ts`).                                                                                                                                                                                                                                                                                                                               |

### Constraints found while planning

- **Phong is deliberate.** Commit `c917b84b` moved bodies from Standard to Phong
  because environment reflections crawled across long tessellation triangles,
  and `ViewportShading.test.ts` pins the material. Any return to a physically
  based material must show, in captures, that the crawl is gone.
- **The material class was named in several places.** Buffer reuse
  (`updateObjectForBody`) and the selected-face fill checked
  `instanceof MeshPhongMaterial`; a class change would have silently sent every
  edit down the full-rebuild path. Slice 1 routes both through
  `isBodyMaterial()` and pins the round trip in `bodyUpdate.test.ts`.
- **E2E builds render without the environment map** (`renderProfile.ts`). A look
  that depends on the environment needs a lights-only fallback close enough that
  colour-sampling specs keep their meaning, or a deliberate baseline refresh.
- **The default body colour is a design-review decision** (G2, 11 October). It is
  a display fallback only (`bodyDisplayColor`), so changing it needs no
  migration, but it is revisited only after lighting changes, since part of the
  blue cast is the lights.
- **Stage colours are theme tokens**, not code; stage changes go through
  `tokens.css` for both themes.

## Slices

Each slice ships with harness before/after captures, iPad/touch frame timings
against `renderBudget.ts`, the light theme checked, thumbnails
(`partThumbnail.ts`) and image export (`viewportImage.ts`) matching the
viewport, and a roadmap evidence fragment.

1. **Harness and material seam (no visual change).**
   `test/e2e/viewport-lookdev.spec.ts` captures five fixed scenes
   (`test/fixtures/lookdev-scenes.ts`) from three camera corners in the
   production renderer at device pixel ratio 2, canvas only.
   `scripts/lookdev-compare.mjs` builds a click-to-flip comparison page.
   `BodyMaterial` / `isBodyMaterial()` replace the class checks.
2. **Lighting.** Darken the hemisphere ground (around `#3a3d42`); neutral rim;
   camera-relative key and fill (the shadow light stays world-fixed); compare
   `NeutralToneMapping` with ACES. Material decision by capture:
   - A. `MeshStandardMaterial` (roughness about 0.55, metalness 0) with a custom
     low-frequency studio environment: bright overhead softbox, mid-grey
     horizon, dark floor.
   - B. Phong with a gradient environment map.
     Choose A only if the sphere and fillet scenes show no crawl. Update the
     `ViewportShading` contracts; add an E2E-profile fallback.
3. **Edge ink.** Sharp edges solid near-black at about 1.6 px (scaled for the
   pixel ratio); tangent edges at about 0.5 opacity, with a view setting for
   all / faint / hidden. Recheck hover and selection contrast in
   `semantics.ts`.
4. **Curved-surface outlines.** Candidate edges between triangles inside each
   smooth B-rep face carry both adjacent normals; the fat-line vertex shader
   (already patched for depth bias) keeps only the ones whose faces straddle
   the view direction. GPU per frame, same width and antialiasing as B-rep
   edges, no post-processing chain. Large STL references are excluded.
5. **Stage.** A slightly lighter neutral backdrop and a visible, quiet grid
   through the tokens, both themes. Revisit `DEFAULT_BODY_COLOR` with G2.
6. **Optional ambient occlusion.** Only if 2–4 leave interior corners flat. It
   is the one item that needs a post-processing chain (multisampled target to
   keep antialiasing, stencil decoration pass preserved), rendered on settled
   frames only and off on touch devices.

Slices 2 and 3 carry most of the visible change; slice 4 is the cylinder and
sphere outline.

## Running the harness

```bash
OZ_LOOKDEV=1 OZ_LOOKDEV_LABEL=before pnpm exec playwright test test/e2e/viewport-lookdev.spec.ts
# change the renderer
OZ_LOOKDEV=1 OZ_LOOKDEV_LABEL=after pnpm exec playwright test test/e2e/viewport-lookdev.spec.ts
node scripts/lookdev-compare.mjs artifacts/lookdev/before artifacts/lookdev/after
```

`OZ_LOOKDEV` builds the production renderer (antialiasing, shadows and the
environment map), like `OZ_CAPTURE` and `OZ_PERF`. Captures are written to the
git-ignored `artifacts/lookdev/<label>`.
