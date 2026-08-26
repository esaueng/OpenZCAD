# Sketch flow & camera choreography — plan of record (2026-08-26)

Target: close the gap between the current sketch/body creation flow and the
reference interaction spec ("Sketch & Body Interaction Spec" artifact,
2026-08-26 — Part I structure, Part II measured feel). Decisions already made:
sketch flow + camera first; the top-bar toolbar identity stays (tool
visibility becomes selection-driven later); extrude add/cut is decided by
direction/inference, not a picker; constraint rail grows from the minimal set.

Ground truth about the current code that shaped this plan:

- Sketch entry already glides head-on and switches to orthographic
  (`ModelViewer.tsx` sketch lifecycle effect), but with the generic travel-
  scaled tween, and it only reorients — it never frames the plane or face.
- The region drag-arrow extrude is fully imperative; the in-sketch
  `startExtrude` path is not — it exits the sketch, jumps to iso, and drives
  its ghost through React state per pointer move (the plan item "1.2 extrude
  drag", deferred pending an imperative preview).
- Add/cut is already inferred exactly (`extrudeInference.ts`,
  kernel-classified); the overlay's operation dropdown is disabled.
- Body recede in sketch mode is an instant 0.35-opacity flip; consumed
  sketches never hide and have no visibility control.
- The plane prompt is three canonical-plane buttons; offset is hardcoded 0.

## Increments

| # | Item | Status |
| --- | --- | --- |
| 1.1 | Camera easing vocabulary: `viewJumpEase` (ease-out) for standard views / fit / normal-to-face / cube arrows, `sketchGlideEase` (velocity trapezoid, fixed 800 ms) for sketch entry/exit; `startTween` accepts a per-move glide style; eases unit-tested; `docs/interaction-design.md` amended | **done** (this branch) |
| 1.2 | Sketch entry frames its subject: face-attached sketches frame the face (reuse the normal-to-face framing math), re-entered sketches frame the sketch bounds; a fresh canonical-plane sketch keeps current distance. Gotcha found live: the face attachment's `sourceCenter` is the surface's reference point, which can sit on the rim — frame on the display triangles' area-weighted centroid instead | **done** |
| 1.3 | Body recede eases over the camera flight (rides `fadeIns`, snaps under reduced motion; materials faded back to opaque leave the transparent pass on settle) | **done** |
| 2.1 | In-sketch Extrude stays in place: `E`/rail Extrude arms the imperative region rig on the active sketch's regions instead of exiting to iso + panel; camera pulls back with `sketchGlideEase`; distance chip + numeric entry ride the rig as they do for region extrude | planned |
| 2.2 | Retire the create-path `ExtrudeOverlay` panel once 2.1 covers it (edit path and stored-operation override stay) | planned |
| 3.1 | Ghost-plane picker: entering Sketch with no face under the cursor shows three pickable plane quads at the origin in the viewport (hover highlight, click to pick) replacing the XY/XZ/YZ button overlay | planned |
| 3.2 | Plane offset: the prompt's face-click path already covers on-face sketches; add an offset field/drag to the ghost-plane picker (data model already stores `offset`) | planned |
| 4.1 | Consumed-sketch auto-hide: a sketch whose profile fed a feature renders hidden by default, with an eye toggle in the feature tree (view state, not document content) | planned |
| 4.2 | Sketch-entry toolbar crossfade in the top bar (chrome half of the mode switch, `--dur-base`) | planned |

Deliberately not in this slice: selection-driven top-bar filtering (next
slice), face-sketch lineage gating (`UNSTABLE_FACE_SKETCH_REASON` — kernel/
schema work), constraint additions, hint strip.

## Measured targets (Part II of the spec)

- State changes land next frame; no easing on geometry state.
- Sketch glide 800 ms: ~100 ms attack, cruise, soft landing. View jumps
  ≤ ~520 ms, full speed at frame one.
- Drag previews produce a frame per pointer batch with no gaps — 2.1 must
  keep the region rig's imperative path and must not reintroduce per-move
  React state.

## Risks / watchpoints

- `viewport.spec.ts` reads the stored camera pose right after moves; longer
  sketch glides can shift settle timing (`VIEW_SETTLE_MS`) under test.
- The apple-silicon `cad-smoke.mjs` asserts wheel behaviour in WKWebView;
  camera-adjacent changes have tripped it before.
- Reduced motion must keep snapping (`CameraController.startTween` early
  path) — every new glide style flows through the same gate.
