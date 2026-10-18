# Face-offset drag latency, 2026-10-18

H02 evidence for dragging a planar face along its normal with a live exact
preview. The reference recording for this work shows ZCAD dragging faces of
the Hammer Holder v4 part. All numbers below are local measurements. They
come from production builds served by `vite preview`, not from zcad.app.

## Setup

- **Host.** Windows 11 Pro, Intel Core i7-10750H (6 cores, 12 threads),
  40 GB RAM.
- **Browsers.** Headed Playwright Chromium at a 1440×1000 viewport, DPR 1.
  - iGPU: ANGLE Intel UHD Graphics, the Chromium default on this hybrid
    laptop.
  - dGPU: ANGLE NVIDIA GeForce RTX 2070 with Max-Q Design, using
    `--force_high_performance_gpu`.
  - Each JSON line records the WebGL renderer it ran on.
- **Background load.** Shapr3D and other desktop apps were running, at about
  30% CPU. Treat single-digit differences as noise.
- **Kernel.** The pinned Remus package, unchanged by this work.
- **Builds compared.**
  - Before: `af92faf5`, which has the stage trace only.
  - After: the optimisation commit with the same trace, merged with `main`
    at `bea45287` (which includes #731).
- **Runs.** Both builds ran on both GPUs, twice each, interleaved. Tables
  show the median across runs.
- **Models.**
  - Chamfered cylinder (2 features). The top cap is dragged.
  - Rounded box (2 features). Its top keeps the client-side primitive proxy,
    so this case measures frame rate only.
  - Reconstructed native hammer holder: plate, cut and two arm extrusions,
    which are dependent features. The highest +Z face is dragged.
  - `openzcad_e_analytic_fillet_plate.step`, an analytic fillet plate. Its
    top face is dragged.
  - `shapr3d_hammer_holder.step`: 160 faces, 42 of them NURBS fillets, and
    125k display triangles. The largest +X face is dragged.

## Method

`test/e2e/perf-face-drag-trace.spec.ts` streams 120 real-time pointer moves,
one every 16 ms, out along the offset handle and back. It then waits for the
last value to reach the screen and releases. `apps/web/src/lib/faceDragTrace.ts`
timestamps every stage on the main thread:

1. Applied pointer value.
2. Candidate build.
3. Worker post.
4. Worker queue and kernel time, measured inside the worker.
5. Transport.
6. Publish.
7. Viewer installation.
8. The first WebGL frame after that installation.

**Lag** is the time from each pointer event until a frame shows geometry
built from that event or a later one. That is presented geometry, not worker
completion. It excludes the first 300 ms of the drag.

`test/support/faceDragTraceSummary.ts` defines every metric. Optional switches:

- `OZ_FACE_DRAG_PROFILE`: CPU profiles.
- `OZ_FACE_DRAG_TIMELINE`: Chrome timelines.
- `OZ_FACE_DRAG_VIDEO`: recordings.

```sh
VITE_E2E=1 OZ_PERF=1 pnpm --filter @openzcad/web build
pnpm --filter @openzcad/web exec vite preview --host 127.0.0.1 --port 27391
PLAYWRIGHT_PORT=27391 OZ_PERF=1 \
  OZ_FACE_DRAG_STEP=<remus>/crates/io/tests/data/shapr3d_hammer_holder.step \
  OZ_FACE_DRAG_FILLET_STEP=<remus>/crates/io/tests/data/openzcad_e_analytic_fillet_plate.step \
  pnpm exec playwright test perf-face-drag-trace --workers=1 --headed
```

Add `OZ_FACE_DRAG_HIGH_PERF_GPU=1` to run on the discrete GPU.

## Baseline findings

1. **Viewer installation dominated complex bodies.**
   - Every preview update rebuilt the whole body on the main thread:
     - one `THREE.Vector3` per corner;
     - a string-keyed edge `Map`;
     - union-find smoothing;
     - a second `EdgesGeometry` outline pass.
   - Deferred-topology previews carry no edge topology. Without edges,
     in-place buffer reuse never applied.
   - On the hammer holder installation took 1.1–1.3 s per update. Smoothing
     was about 550 ms of that and the outline about 870 ms. Lag reached
     2.6–3.2 s and frames stalled for over a second.
2. **Frames forced layout repeatedly.** CPU profiles and timelines showed
   synchronous layouts of the whole document each frame. They came from:
   - canvas `clientWidth` and `clientHeight` reads, about 40 call sites;
   - the offset chip measuring itself after writing its text;
   - the scale bar reading computed style after the frame's writes;
   - unchanged sketch overlays being re-hidden every frame.

   Frame callbacks cost 6–7 ms before the fix.

3. **The GPU limits frame rate on the iGPU.** During a drag the GPU process
   was busy 86% of the time on Intel UHD. Chromium does not use the RTX 2070
   unless forced, so iGPU frame intervals stay around 25–30 ms even when the
   main thread is idle.
4. **Kernel work** (worker, warm):
   - Simple bodies: 12–43 ms per preview.
   - Hammer holder: about 290 ms per preview.
   - Hammer breakdown in Node: tessellation 60–95 ms, face-area integration
     about 60 ms, `moveFacesJournaled` 20–40 ms, the remainder JS.
   - Cooperative worker yields are negligible: at most two per preview.
   - Message transport costs 1–10 ms.
   - Each frame starts from the original document plus one direct-edit
     feature, which is source-relative. History restores from the cached
     checkpoint. Mass properties and recognition are deferred to release.
5. **Scheduling is not the bottleneck.**
   - One preview is in flight at a time. Only the newest pending value is
     kept, and stale results are rejected by token.
   - There is a 32 ms start floor and an 8–32 ms presentation yield.
   - At current kernel and GPU costs this floor accounts for at most one
     preview interval. It was left unchanged.
6. **Some faces refuse every offset.** The kernel refuses every offset of the
   native holder arms' ±X faces and of the filleted plate's ±X faces, with
   "The exact kernel could not build this result." Those faces cannot show
   a live preview at all; the last valid shape is kept.

## Changes

- **`packages/viewport/src/render/scene.ts`.**
  - Smoothing runs on typed arrays with per-vertex edge buckets.
    `smoothingParity.test.ts` proves it bit-identical to the previous
    algorithm, including index width.
  - Bodies with complete face ranges but deferred edges outline their B-rep
    face boundaries from the same pass. This matches the committed body's
    edges, tangent fillet boundaries included.
- **`ModelViewer.tsx`.**
  - Canvas size comes from the last `renderer.setSize`.
  - The offset chip reads its layout before writing.
  - Unchanged sketch overlays are not rewritten each frame.
- **`ViewportScaleIndicator.tsx`.** Rule colours are cached per theme.
- **`preview-face-geometry-cache.ts`.**
  - Drag previews reuse face measurements whose exact shape inputs are
    unchanged: witness, edge count, vertex positions and analytic
    parameters.
  - On the hammer holder, measured faces drop from 120 to 29 per frame. The
    median preview falls 7% in an in-process A/B.

## Results

Lag, first geometry, installation and kernel are in milliseconds.

### Intel UHD (default)

| Model                                    | Lag p50    | Lag p95     | First geometry | Updates/s   | Frame interval p50/p95 | Install p50 | Kernel p50 |
| ---------------------------------------- | ---------- | ----------- | -------------- | ----------- | ---------------------- | ----------- | ---------- |
| Chamfered cylinder, top cap              | 78 → 67    | 125 → 99    | 186 → 146      | 17.3 → 19.4 | 30/57 → 27/53          | 10 → 2      | 14 → 14    |
| Native holder (4 features), arm top      | 103 → 107  | 162 → 168   | 180 → 196      | 14 → 13.5   | 30/55 → 34/66          | 9 → 3       | 32 → 36    |
| Filleted plate (STEP), top               | 114 → 99   | 162 → 133   | 239 → 209      | 10.6 → 14.3 | 31/53 → 26/58          | 10 → 2      | 43 → 42    |
| Hammer holder (STEP, 160 faces), +X face | 2592 → 703 | 2867 → 1041 | 1835 → 625     | 0.6 → 1.7   | 24/1059 → 21/110       | 1080 → 93   | 286 → 287  |
| Rounded box, top (client proxy)          | –          | –           | –              | –           | 23/49 → 17/42          | –           | –          |

### RTX 2070 Max-Q (forced)

| Model                                    | Lag p50    | Lag p95     | First geometry | Updates/s   | Frame interval p50/p95 | Install p50 | Kernel p50 |
| ---------------------------------------- | ---------- | ----------- | -------------- | ----------- | ---------------------- | ----------- | ---------- |
| Chamfered cylinder, top cap              | 81 → 69    | 119 → 105   | 158 → 164      | 18.9 → 21.8 | 27/44 → 25/41          | 8 → 2       | 12 → 14    |
| Native holder (4 features), arm top      | 103 → 91   | 152 → 142   | 174 → 174      | 15 → 17.9   | 28/44 → 28/44          | 7 → 2       | 32 → 32    |
| Filleted plate (STEP), top               | 115 → 102  | 160 → 138   | 156 → 154      | 13.1 → 14.8 | 25/44 → 23/40          | 8 → 2       | 43 → 43    |
| Hammer holder (STEP, 160 faces), +X face | 3222 → 677 | 3559 → 1046 | 1198 → 589     | 0.6 → 1.8   | 23/1171 → 19/108       | 1303 → 102  | 292 → 286  |
| Rounded box, top (client proxy)          | –          | –           | –              | –           | 21/36 → 12/30          | –           | –          |

Release to the validated commit's first frame on the hammer holder improves
from 420–467 ms to 187–214 ms.

### Proposed targets

These targets are proposals, not measurements from the recording.

- **60 fps.** Met only for the client-proxy drag on the dGPU (12 ms p50).
  Exact previews reach 19–27 ms frame intervals. The iGPU and the per-update
  GPU work (new buffers and a shadow refresh) bound them.
- **First changed geometry within 100 ms.** Not met: 146–209 ms on simple
  bodies and about 600 ms on the hammer holder.
- **Steady p95 below 50 ms.** Not met: 99–168 ms on simple bodies.

Simple-body lag is now mostly accounted for by:

- worker kernel time, 12–43 ms;
- one preview interval, at least 32 ms;
- the presentation frame, 16–25 ms.

On the hammer holder, about 290 ms of kernel time per preview remains.

## Remaining work

- **Remus.** Tessellate and measure only the faces a move changes. Add
  prepared boundary plans and incremental assembly, as named in #729.
  Tessellation and changed-face area integration are about 60% of the
  hammer holder's preview kernel time.
- **Preview display density.** The hammer holder previews at 125k
  triangles. A coarser drag deflection would cut tessellation, transfer,
  installation and GPU cost, at the price of a visible refinement on release.
- **Presentation path.** Previews install through React's passive effect, one
  frame after commit. Installing preview meshes imperatively, as the
  proxies do, and updating buffers in place when the face connectivity
  matches, would save a frame and the per-update allocations.
- **Kernel capability.** Investigate the refused ±X face moves above.
- **Typed refusals.** Remus #1175 is still open. It adds typed face-move
  refusals; ZCAD can adopt them once a paired package publishes it.

## Correctness

These behaviours are unchanged:

- Each preview is built from the source document, not the previous preview.
- The last accepted preview survives in-drag refusals and release-time
  refusals (#731, merged and deployed as `bea45287`).
- Stale results are rejected by token and generation.
- Release runs a full validated sync before committing.
- Undo and redo restore canonical documents.

The browser regressions in `visual-selection-live-preview.spec.ts`,
`compound-face-offset.spec.ts`, `face-edit-view.spec.ts` and
`rounded-box-resize.spec.ts` cover these behaviours on this branch.
