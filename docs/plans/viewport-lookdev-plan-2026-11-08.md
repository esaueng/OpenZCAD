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

   **Outcome (8 November).** A, in `packages/viewport/src/render/studio.ts`
   (`STUDIO_RIG`). The environment is one smooth Z-up curve (zenith 1.0, nadir
   0.15) plus one broad overhead lobe; the sphere and fillet captures show no
   crawl. Three findings from the captures shaped it: a horizon kink in the
   gradient reflected as a ring on spheres, so the curve is continuous; an
   underside went nearly black from below (the camera key keeps world-up), so
   the nadir is 0.15, not 0.05; and a planar face's new gentle gradient banded
   to a one-level contour on 8-bit output, so the body material dithers. The
   rim light is gone; the world key only casts the shadow (0.45). The exact
   section fill and project thumbnails use the same rig; E2E builds (no
   environment) raise the hemisphere to 0.95 instead.
   Seen in passing, not caused here: a faint ring where a body crosses Z = 0
   (ground decorations), present in the baseline captures too.

3. **Edge ink.** Sharp edges solid near-black at about 1.6 px (scaled for the
   pixel ratio); tangent edges at about 0.5 opacity, with a view setting for
   all / faint / hidden. Recheck hover and selection contrast in
   `semantics.ts`.

   **Outcome (8 November).** Idle edges are `#0b0d10` at full opacity and
   1.5 CSS px (widths are CSS pixels, so they already scale with the pixel
   ratio); tangent rims rest at 0.42. Thumbnails take the same ink. The
   all / faint / hidden setting is deferred: the display modes already offer
   shaded without edges, and nothing yet asks for a third state. Outlines
   that fall on a silhouette still vanish against the dark stage, where half
   the line lies over it; slice 4 and the stage pass address that.

4. **Curved-surface outlines.** Candidate edges between triangles inside each
   smooth B-rep face carry both adjacent normals; the fat-line vertex shader
   (already patched for depth bias) keeps only the ones whose faces straddle
   the view direction. GPU per frame, same width and antialiasing as B-rep
   edges, no post-processing chain. Large STL references are excluded.

   **Outcome (8 November).** `packages/viewport/src/render/silhouette.ts`:
   candidates are the interior mesh edges of each non-planar B-rep face
   (vertices welded by position so periodic seams join; coplanar neighbours
   dropped), carried in `BodyEdgeOverlay.silhouetteEdges` with the resting
   sharp-edge style, visibility and selection outline. About 5 ms per 4k
   triangles and 35 ms per 65k to build, once per body change; bodies over
   150k triangles get none. Against the dark stage an outline that borders
   only the backdrop stays subtle, which the stage pass addresses.

5. **Stage.** A slightly lighter neutral backdrop and a visible, quiet grid
   through the tokens, both themes. Revisit `DEFAULT_BODY_COLOR` with G2.

   **Outcome (8 November).** The dark stage is a neutral graphite
   (`#222428` → `#18191c` → `#121315`, grid `#5a5e66` / `#878c95`) instead of
   near-black with a blue cast; outlines, the ground shadow and the grid now
   have something to read against. The light stage already read well with
   the new shading and is unchanged (`OZ_LOOKDEV_SCHEME=light` captures it).
   `DEFAULT_BODY_COLOR` moves from `#99a0b2` to `#a2a6ae`: the same
   lightness, desaturated, since the studio shading no longer washes top
   faces out (G2's reason for the darker steel) and the blue read as a blue
   part. `stagePalette.test.ts` now pins the graphite fallback to the dark
   tokens.

6. **Optional ambient occlusion.** Only if 2–4 leave interior corners flat. It
   is the one item that needs a post-processing chain (multisampled target to
   keep antialiasing, stencil decoration pass preserved), rendered on settled
   frames only and off on touch devices.

   **Outcome (9 November).** Done without a post-processing chain; see
   _Ambient occlusion_ under Follow-up.

Slices 2 and 3 carry most of the visible change; slice 4 is the cylinder and
sphere outline.

## Follow-up (8 November)

- **Seam rings.** The faint ring at a sphere's equator, first taken for a
  ground-plane artefact, was the shading: the kernel splits one smooth
  surface into several B-rep faces, and the normal smoothing creased every
  face boundary, so each side kept its own one-sided normal. Tangent face
  pairs (`tangentFacePairs`, the measure the tangent edge ink already used)
  now share normals across their boundary; genuine creases stay split, and a
  deferred-topology preview still outlines every face boundary.
- **Ambient occlusion.** Slices 2–4 left concave corners (a boss meeting a
  block, a duct's inner corners) reading flat beside the reference, so
  `packages/viewport/src/render/ambientOcclusion.ts` adds contact shading
  computed only on settled frames, which drops the two objections slice 6
  anticipated:
  - _No chain._ The occlusion is applied inside the body shader: it samples a
    half-resolution occlusion buffer at its own pixel and scales its own
    lighting (ambient fully, the camera key at 0.55). The canvas keeps its
    multisampling and stencil, and edge ink, silhouettes, hover and selection
    overlays, the grid and the backdrop are never darkened. A selected face's
    fill is a clone without the hook.
  - _Settled only, so touch keeps it._ A frame whose camera or solids differ
    from the last one hides it; 150 ms after the last change one extra pass
    computes it (normals and depth of the opaque solids into a 1.6 MP-capped
    half-resolution target, a 12-sample spiral estimate, a separable
    edge-aware blur) and it fades in over 180 ms. The camera check tolerates
    last-bit float wobble: a camera at rest is re-derived every frame, and an
    exact compare re-armed the settle forever.
  - _Look._ The estimator counts a sample only as far as it rises above the
    surface's tangent plane and only within the radius (5% of the solids'
    bounding diagonal, clamped to 3–36 buffer pixels), so planar and convex
    faces get exactly nothing — the sphere, filleted cylinder and rounded
    block captures are pixel-identical to main — and a silhouette casts no
    halo onto the stage or a face behind it. The body shader upsamples
    against its own depth, so a rim never borrows another surface's shade,
    and skips the work with one filtered fetch where nothing is occluded. At
    the boss-on-block junction the darkest pixel drops about 36 of 255 levels.
  - _Gates._ Off in X-ray and wireframe, in E2E builds (`RenderProfile`),
    and for any render into a target or with another camera (thumbnails,
    image export). `AMBIENT_OCCLUSION.enabled` is the switch;
    `window.__ozAmbientOcclusion = false` turns it off for a capture or a
    timing. Section views keep it: the prepass clips with the same planes,
    and caps occlude.
  - _Cost_ (Chromium, 1024 × 1366 at DPR 2, CPU throttled 4×, 128 bodies,
    Intel UHD through D3D11; the machine was under heavy unrelated load, so
    medians are noisy): orbit frames unchanged (CPU median 57–75 ms with,
    64–66 ms without, the same range); a moving frame's check is under 1 µs and a
    still frame's walk of 128 bodies about 150 µs unthrottled. The settle
    compute is 7–19 ms of GPU once per rest, and a redraw at rest with the
    occlusion shown costs the same as without it (interleaved medians 47.8
    vs 49.1, 40.0 vs 40.9, 58.1 vs 53.0 ms). Buffers: about 14 MB at that
    canvas (RGBA8 normals, 32-bit depth, two R8 occlusion buffers).
- **Interaction states.** `lookdev: interaction states` captures a hovered
  face, a selected face, a selected body and X-ray on the boss-on-block
  scene. Under the studio rig all four read clearly, so their tints and
  dimming are unchanged.
- **Tangent edge setting.** The all / faint / hidden choice deferred in
  slice 3 now ships as Settings › Viewport › **Tangent edges**: Show, Faint
  (the default, the 0.42 rim above) or Hide (`viewport.tangentEdges`, an
  app setting the Worker carries across older clients' saves). It governs
  resting rims in Shaded + edges only. Wireframe and X-ray still draw every
  edge in one ink, and a selected body still outlines its rims. Hide turns
  off the tangent batch's material, not the line, so PickService still
  reaches a hidden rim: hovering or selecting one draws it in the hover and
  selection batches. Curved-surface outlines are unaffected, and thumbnails
  keep the default look (they build their own lines). `OZ_LOOKDEV_TANGENT_EDGES`
  makes the harness capture a given choice.

## Running the harness

```bash
OZ_LOOKDEV=1 OZ_LOOKDEV_LABEL=before pnpm exec playwright test test/e2e/viewport-lookdev.spec.ts
# change the renderer
OZ_LOOKDEV=1 OZ_LOOKDEV_LABEL=after pnpm exec playwright test test/e2e/viewport-lookdev.spec.ts
# OZ_LOOKDEV_SCHEME=light captures the light stage
node scripts/lookdev-compare.mjs artifacts/lookdev/before artifacts/lookdev/after
```

`OZ_LOOKDEV` builds the production renderer (antialiasing, shadows and the
environment map), like `OZ_CAPTURE` and `OZ_PERF`. Captures are written to the
git-ignored `artifacts/lookdev/<label>`.
