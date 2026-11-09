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

### Frame timing on an iPad-class proxy (9 November)

Measured, but **by proxy, not on a device**: no iPad or iOS simulator is
available to the agents. `test/e2e/perf-frame-timing.spec.ts` (`OZ_PERF=1`;
see [Browser test suites](../browser-test-suites.md)) drives a six-second
one-finger orbit through Chromium's touch input domain in an iPad
Pro-sized touch viewport (1366 × 1024, device pixel ratio 2, coarse pointer
so the touch render budget applies), with CDP CPU throttling ×1, ×4 and ×6,
on six heavy curved scenes (`test/fixtures/frame-timing-scenes.ts`). The
browser was headless Chromium 156 on Windows, drawing through ANGLE D3D11 on
the laptop's Intel UHD integrated GPU: an i7-10750H, whose single core is
roughly an A12–A13 iPad's, and a GPU nearer a base iPad's than an M-series
one, at the full 2732 × 2048 backing store. It is not Safari, not Metal, has
no thermal limit and no 120 Hz ProMotion. ×4 and ×6 are harsher than any
current iPad's CPU. Read the numbers build against build, not as a device
budget.

Pre-U10 is `3da524a4` (the parent of #1288); main is `a1102d8e` (U10 slices
1–5 and the seam follow-up). Each cell is the median of three runs,
interleaved pre/main, pre → main. Frame = requestAnimationFrame interval
while orbiting; dropped = 60 Hz refreshes with no new frame; GPU = timer
query time per frame; body install = `oz:viewer.bodies` on import, including
the outline-candidate build. Runs spread widely (other agents built on the
same machine), and the throttled rows most of all; the full tables with
min–max spreads are in the PR.

| Scene             | CPU× | Frame p50 ms |  Frame p95 ms |   Frame p99 ms | Dropped % |  GPU p95 ms | Body install ms |
| ----------------- | ---: | -----------: | ------------: | -------------: | --------: | ----------: | --------------: |
| rounded-block     |    1 |  16.7 → 16.7 |   33.4 → 50.0 |   49.9 → 166.7 |   22 → 41 | 19.8 → 23.4 |         44 → 84 |
| rounded-block     |    4 |  33.3 → 33.3 | 116.6 → 100.0 |  183.4 → 183.3 |   63 → 59 | 29.4 → 26.8 |        95 → 291 |
| rounded-block     |    6 |  49.9 → 50.0 | 133.3 → 133.4 |  183.4 → 233.4 |   67 → 68 | 32.4 → 41.1 |       447 → 518 |
| gear-60t          |    1 |  16.7 → 33.3 |   33.4 → 33.4 |    83.3 → 50.1 |   31 → 39 | 21.3 → 26.2 |       168 → 334 |
| gear-60t          |    4 |  33.4 → 33.3 | 183.3 → 116.6 |  233.3 → 183.2 |   67 → 64 | 36.4 → 31.1 |     1830 → 1159 |
| gear-60t          |    6 |  33.3 → 50.0 | 183.3 → 116.6 |  283.3 → 133.3 |   71 → 69 | 33.8 → 47.3 |     1351 → 2120 |
| filleted-block    |    1 |  16.7 → 16.7 |   33.4 → 33.5 |   183.3 → 83.4 |   29 → 34 | 20.7 → 24.3 |       282 → 306 |
| filleted-block    |    4 |  33.3 → 33.3 |  166.7 → 83.3 |  233.4 → 116.7 |   70 → 49 | 28.2 → 29.6 |       476 → 628 |
| filleted-block    |    6 |  49.9 → 33.3 | 150.1 → 116.6 |  183.4 → 250.1 |   67 → 66 | 32.7 → 31.3 |       747 → 783 |
| torus             |    1 |  16.7 → 33.2 |  133.4 → 50.0 |  266.7 → 166.6 |   52 → 43 | 25.5 → 26.4 |       274 → 290 |
| torus             |    4 |  33.3 → 33.4 | 100.0 → 150.1 |  216.7 → 250.0 |   56 → 66 | 24.8 → 47.5 |      560 → 1943 |
| torus             |    6 |  33.3 → 50.0 | 116.7 → 216.7 |  216.6 → 250.0 |   61 → 76 | 36.4 → 43.5 |      420 → 2224 |
| sphere-row        |    1 |  16.7 → 33.3 |   33.4 → 50.0 |    83.4 → 66.6 |   25 → 43 | 20.5 → 28.9 |       456 → 841 |
| sphere-row        |    4 |  16.8 → 33.3 |  216.6 → 66.7 |  333.3 → 116.7 |   73 → 59 | 35.9 → 31.3 |     1126 → 1706 |
| sphere-row        |    6 | 16.7 → 100.0 | 366.6 → 700.0 | 1100.0 → 916.6 |   81 → 92 | 36.5 → 89.6 |     2595 → 3081 |
| rotational-sleeve |    1 |  16.7 → 33.3 |   50.0 → 50.0 |  100.1 → 100.0 |   33 → 41 | 23.4 → 26.6 |       135 → 606 |
| rotational-sleeve |    4 |  33.3 → 33.3 |  66.8 → 166.6 |  166.6 → 333.4 |   50 → 65 | 23.7 → 31.4 |      368 → 1035 |
| rotational-sleeve |    6 |  33.4 → 33.4 |  150.0 → 75.1 |  266.7 → 166.6 |   67 → 57 | 37.2 → 31.5 |     1039 → 1068 |

Triangles drawn per frame, pre → main: rounded block 9k → 61k, gear 140k →
371k, filleted block 33k → 288k, torus 87k → 606k, sphere row 125k → 874k,
rotational sleeve 69k → 423k. Each outline candidate is an instanced fat-line
quad drawn every frame, whether or not it is on the outline that frame.

What it shows:

- **The studio material and environment are free.** With the display mode
  set to Shaded (no edges, no outlines; `OZ_PERF_DISPLAY=Shaded`), pre-U10
  and main measured the same on every scene (GPU p95 within ±2 ms, dropped
  frames within ±5 points). `MeshStandardMaterial`, the PMREM environment,
  the camera key light and dithering did not register.
- **The per-frame cost is the curved-surface outlines.** In the default
  Shaded + edges mode, GPU p95 at ×1 rose 1–8 ms per scene (most on the
  sphere row near the 150k cap, 20.5 → 28.9 ms) and the triangle count
  rose 3–9×. On this integrated GPU the pre-U10 baseline already missed
  60 Hz (about 15–20 ms of GPU per frame at 2732 × 2048), so U10 deepened
  an existing miss: dropped frames at ×1 rose on five of six scenes
  (sphere row 25 → 43%, gear 31 → 39%); the torus's pre-U10 runs were too
  noisy to compare (23–58%).
- **The touch render budget absorbs most of it.** After a first gesture
  (`OZ_PERF_WARMUP=1`), a device that dropped frames navigates at pixel
  ratio 1.25, and pre and main then measured alike: frame p95 17–42 ms,
  dropped frames mostly under 20% on both.
- **The outline-candidate build hitches every body build.** It runs on the
  main thread on import, on each edit and on each exact frame of a drag: at
  ×1, 22–320 ms per body (sphere row 317 ms); at ×4–×6, 0.2–1.5 s
  (torus ×4 923 ms; sphere row ×6 1448 ms). That is most of the body-install
  growth above (torus ×4: 560 → 1943 ms).

Verdict for iPads: U10's look costs nothing in shading, but its curved
outlines add GPU work every frame in proportion to curved tessellation and
a main-thread hitch to every curved body build. On a recent iPad (M-series
or A14+ GPU, ~2× this laptop's per-core speed) the frame cost likely fits
in 16.7 ms; on a base or older iPad it will cost frames on big curved parts
until the touch budget lowers resolution. The candidate build is the
likelier visible regression: a 100–300 ms stall on opening or editing a
heavy curved part.

Follow-ups (outline code is being reworked in a separate PR, so none are
made here, and these numbers are its "before"):

- Filter outline candidates on the CPU per camera so only the segments on
  the outline are drawn (done; see "Follow-up (9 November): outline cost"
  below).
- Build candidates without per-vertex string keys or per-edge objects. A
  drop-in rewrite with bit-identical output measured 2–7× faster in the
  browser (sphere row ×1 317 → 42 ms, torus ×4 923 → 248 ms, sphere row ×6
  1448 → 406 ms) and was handed to that PR rather than landed here.
- Not measured: rebuild cost during a face drag on a curved part, where
  every exact frame rebuilds the body.

On a real iPad: Settings → Advanced → Frame rate overlay shows the live
frame interval while orbiting zcad.app. For a timeline, enable Web
Inspector (Settings → Apps → Safari → Advanced), connect the iPad to a Mac
and record Safari's Timelines; `oz:viewer.bodies` appears under User Timing.

## Follow-up (9 November): outline cost

The per-frame shader test in slice 4 drew one fat-line quad per candidate,
visible or not. Fillets are tessellated finely: the 13-face rotational
sleeve of `rotational-direct-edits.spec.ts` has five torus faces of
10k–14k triangles, which gave 58,957 candidates against about 1,050
instances for every other line in the scene. On CI's software rasterizer
that took most of each frame. The spec went from 40–83 s to 128–187 s
against its 180 s budget, and it failed locally within its first 5 s poll.
On a tablet GPU it was a needless share of each frame.

`updateSilhouette` now does the straddle test on the CPU, in the batch's own
space, and only when the camera or the body has moved. It uploads just the
segments on the outline, about 560 for the sleeve. A scene installs it with
`installSilhouetteUpdates`, which runs in `scene.onBeforeRender`: three runs
that after the scene's matrices update and before it uploads any buffer, so
every camera that renders the scene, captures included, draws its own
outline. The outline uses the stock fat-line program, and the shader patch
is gone.

- Picking costs about 1 ms per view change for the sleeve's 59k
  candidates (p95 2 ms, desktop), and nothing while the view rests.
- The lookdev captures (15 views, 5 scenes) are pixel-identical to the
  shader version.
- With this change, `rotational-direct-edits` passed 3 of 3 runs locally
  (59–72 s); before it, it failed 4 of 4.

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
