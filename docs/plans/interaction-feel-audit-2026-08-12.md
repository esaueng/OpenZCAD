# Interaction-feel audit — 2026-08-12

Why the 3D modeling interaction still feels janky, decomposed into verified,
file-anchored defects and ranked by feel-impact. Sources: full code audit of
the interaction stack, fresh `OZ_PERF=1` interaction-probe runs, and a
bisected rendering regression. Line numbers are as of `ef77d45`.

## Measured state

Probe (`OZ_PERF=1 pnpm exec playwright test interaction-probe`, headless
SwiftShader, same machine, same day):

| Commit | frame p50 | frame p95 | mean draw calls | mean triangles |
| --- | ---: | ---: | ---: | ---: |
| `d8561c7` (pre-vsel) | 16.7 ms | 25.0 ms | 11.58 | 2,801 |
| `ef77d45` (current) | 24.9 ms | 25.7 ms | 13.9 | 6,530 |

Input-to-frame latency on the cylinder-radius drag is excellent (p50 1.0 ms,
p95 1.2 ms) — the coalescing design works where it is applied.

## Confirmed regression: phantom hover edge batches (bisected)

- First bad: PR #293 (vsel phase 1) +1,968 triangles; PR #295 (phase 2)
  +1,969 more. Bisect log in session scratchpad.
- Mechanism: `BodyEdgeOverlay.createOverlay` builds each batch with a
  full-capacity zeroed buffer (`packages/viewport/src/render/edgeOverlay.ts:292`)
  and never zeroes `instanceCount`; `refreshVisibility` gates `hoverEdges` /
  `hoverHiddenEdges` on `geometry.instanceCount > 0` (`edgeOverlay.ts:463-468`),
  which is true from construction. `setDisplayMode` (called at install for
  every body) runs `refreshVisibility`, so every body renders two
  full-capacity degenerate fat-line batches until the first edge hover — and
  every scene rebuild resurrects them.
- Fix: `replacePositions(this.hoverEdges, [])` +
  `replacePositions(this.hoverHiddenEdges, [])` at the end of the
  constructor (or gate on `hoveredKeys.size`), plus a regression test
  asserting the batches start with `instanceCount === 0` / `visible === false`.

## Ranked feel-defect inventory

### Tier 1 — the jank users actually feel

1. **Full scene teardown/rebuild per preview publish, mid-drag.** Every
   ~150 ms during an offset/fillet/extrude drag, `setPreviewDoc` produces a
   new `viewerBodies` identity (`App.tsx:2690-2696`), so the body-rebuild
   effect (`ModelViewer.tsx:6127-6572`) runs `clearGroup(bodyGroup)`, drops
   hover state (`SelectionManager.resetForRebuild`), rebuilds every mesh and
   edge batch, and refreshes the shadow map. This is the "pop" during direct
   manipulation. Fix direction: update geometry in place for the dragged
   body (swap buffer attributes on the existing mesh) instead of document-
   level rebuild; keep identity for unchanged bodies.
2. **App-level setState per raw pointermove during move/extrude drags**
   (`App.tsx:10376-10381` setMoveSnap+setMovePreview; `App.tsx:3799-3807`
   extrude) with **zero `React.memo` in the app** — every mouse event
   re-renders the whole 11k-line App tree, Sidebar, Inspector, TopBar
   included. Cylinder radius routes into Inspector per move
   (`Inspector.tsx:621`).
3. **Unstable array props re-arm heavy viewport effects on every App
   render:** `sketches={... ? [] : sketchOverlays}` (`App.tsx:10341`),
   `selectedProfileIds={selectedProfiles.map(...)}` (`App.tsx:10422`),
   `editableBodyIds={viewMode ? [] : ...}` (`App.tsx:10361`). Combined with
   (2), a drag = full App render + sketch-group clear + region-state walk +
   157-line extrude-preview effect, per pointer event.
4. **Synchronous localStorage round-trip on orbit pointerdown.**
   `pivotOrbitOnCursor` → `pivotOn` → `emitViewChange` →
   `saveProjectView` does getItem+parse+validate+stringify+setItem
   (`CameraController.ts:555`, `lib/workspaceSession.ts:213-229`) before the
   orbit starts. Direct drag-start latency.
5. **Drag pointermove paths are not rAF-coalesced** (hover is; drags are
   not). Full snap-scan + HUD positioning per raw event; no
   `getCoalescedEvents` anywhere (`ModelViewer.tsx:4366-4651`). On a
   high-rate mouse this is 8–16× the needed work. Move drags additionally do
   O(all edges + all face centers) snap scans with per-candidate `Vector3`
   allocation per event (`ModelViewer.tsx:4446-4498`, `SnapEngine.ts:98-115`).
6. **Edge hover/selection highlights pop hard:** width 1.4→4/4.5 px and
   near-black→near-white in one frame, no easing
   (`edgeOverlay.ts:344-364`, `pick/edges.ts:7-15`). The face hover film
   fades nicely (`SelectionManager.ts:428-448`) but does not cross-fade
   between faces (`:225-269` teleports the shape), selection never fades
   *out* (`ModelViewer.tsx:6180-6185`), and the x-ray half pops in at full
   opacity (`:6265-6274`).

### Tier 2 — polish gaps vs Shapr3D-class

7. **Gizmo rigs pop in/out with zero transition and have no hover
   affordance** — offset/edge/cylinder rigs expose only
   setValue/setWarning/dispose (`packages/viewport/src/gizmo/rigs.ts:175-220`);
   armed/disarmed is scene.add/dispose (`ModelViewer.tsx:6701-6845`). Move
   gizmo focus dims other axes 100%→20% in one frame (`gizmo/move.ts:170-172`).
8. **No feedback that geometry lags the handle.** Handle tracks input;
   geometry lands ~150 ms + kernel latency later with no computing state;
   the 400 ms degrade silently stops live preview for the rest of the
   gesture for offset/edge consumers (`lib/livePreview.ts:113-118`,
   `continueAfterSlow` only for cylinder radius `App.tsx:1329`). Only
   cylinder radius has a smooth visual proxy; offset and fillet teleport.
9. **Chips, keypad, HUD have literally no transitions** — no `transition`
   or `animation` on `.handle-value-chip`, `.numeric-keypad`
   (`direct-manipulation.css:171-277`); HUD show/hide is a `hidden` toggle
   (`HudLayer.ts:31,69,111`); warning state is an instant color flip
   (`rigs.ts:198-208`). Extrude value pill still rebuilds per drag frame
   (FB-04, `motion.css:139-153`).
10. **No trackpad support model:** every wheel gesture dollies; no
    two-finger pan, no ctrl-wheel pinch distinction
    (`ModelViewer.tsx:5651`, `input/bindings.ts:36`). Substantive daily-feel
    gap for trackpad users.
11. **Motion vocabulary is fragmented.** Three CSS tokens
    (`--dur-fast` 100 ms / `--dur-base` 200 ms / `--ease-out`,
    `tokens.css:88-90`) bypassed in 20+ places (140 ms, 120 ms, 240 ms, bare
    `ease`, four spinner periods); the TS layer (camera 170–520 ms
    easeInOutCubic, overlay fade τ≈62 ms duplicated in two files) shares no
    constants with CSS. Hover/selection fades also ignore reduced-motion,
    which the camera respects (`SelectionManager` has no `reducedMotion`).

### Tier 3 — cost/robustness items

12. Per-frame layout thrash: `clampNameCallouts` read-write-read loop every
    frame with callouts visible (`ModelViewer.tsx:623-658`);
    `updateOffsetChip` does querySelector+getBoundingClientRect per frame of
    an offset drag (`:3628-3632`); HUD positions via left/top with a rect
    read per call (`HudLayer.ts:45,67-68`).
13. Hover frame does up to 3 separate raycasts (gizmo, pick, measure
    `pickAll`) each re-reading the canvas rect (`ModelViewer.tsx:3434-3445`,
    `PickService.ts:104`); no BVH; Line2 picking at 8 px threshold makes
    every edge batch a wide test; `pickAll` JSON.stringifies per candidate
    (`PickService.ts:47-56`).
14. Sketch drawing allocates/disposes a `LineGeometry` per pointermove, ×2
    for inference (`sketchModeController.ts:398-454`).
15. `LivePreview.build()` clones the whole document synchronously on the
    main thread per preview, then structured-clones it to the worker
    (`livePreview.ts:88`, `App.tsx:8085`).
16. Window resize: unthrottled `setWindowWidth` per event (`App.tsx:922-927`)
    on top of per-frame `renderer.setSize` + full-scene
    `syncFatLineResolution` walk (`ModelViewer.tsx:5681-5692`).
17. DPR read once at construction (`ModelViewer.tsx:1057`); moving the
    window to a different-DPR display leaves the canvas blurry/oversampled.
18. Cursor set unconditionally every hover frame, flickers across
    boundaries; no hover dwell/hysteresis anywhere (`SelectionManager.ts:399-406`).
19. Probe coverage gap: the interaction probe measures only orbit/pan and
    one proxy drag — none of items 1–5 are instrumented. Extend it with a
    hover-sweep, a move-gizmo drag, and a preview-heavy fillet drag, and
    record React commit counts during gestures.

## What is already good (don't re-litigate)

Camera feel is genuinely designed: dual damping regimes with bounded glide
(`CameraController.ts:49-52`), velocity-adaptive wheel zoom
(`zoomDynamics.ts`), zoom-to-cursor preference, orbit pivot re-target on
picked point, quaternion-slerp view tweens with distance-scaled duration
(`views.ts:257-293`). Hover picking is rAF-coalesced with measured ~1 ms
input-to-frame. On-demand render loop with no missed invalidations. Pointer
capture and 5 px click thresholds centralized in `GestureRouter`. Frozen
shadow maps with explicit, bounded thaws.

## Proposed fix batches

Each batch = one PR series with before/after probe numbers; user-felt
acceptance by short screen recording.

- **Batch 0 — regression + probe coverage:** phantom hover batches fix +
  regression test; extend probe to hover sweep / move drag / preview drag;
  add React-commit-count instrumentation under OZ_PERF.
- **Batch 1 — drag pipeline (items 1,2,3,5):** in-place preview geometry
  swap for the dragged body; route drag-time state through refs/imperative
  setters instead of App setState (the chip/HUD layer already works this
  way); memoize the unstable props; rAF-coalesce drag handlers.
- **Batch 2 — gesture-start latency (items 4, part of 5):** defer the
  workspace-session write off the pointerdown path (idle callback);
  pre-build snap candidates async on selection, not on pointerdown.
- **Batch 3 — feedback continuity (items 6,7,8,9):** small shared motion
  helper for the 3D layer (one ease, 2–3 durations, reduced-motion aware);
  edge-highlight ease; selection fade-out; gizmo fade/scale-in + hover
  state; "computing" affordance when preview lags; visible state when the
  400 ms degrade kicks in.
- **Batch 4 — trackpad + input tuning (item 10):** two-finger pan,
  ctrl-wheel pinch zoom, per-device tuning.
- **Batch 5 — cost cleanup (tier 3):** BVH or prefilter for picking, layout
  thrash removal, sketch geometry reuse, DPR listener, resize throttle.
