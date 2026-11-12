# Multi-body edit overhead in the geometry worker

Editing one body of a document with many bodies cost the geometry worker
time in proportion to the whole document. The exact kernel itself was not the
cost: the late edit in a 30-body document replays one feature in a few
milliseconds. The rest was spent re-proving, copying and comparing the
unchanged bodies on every sync.

## Root causes

CPU profiles of the worker's broadcast path, replayed in Node (see
Reproduction), located the cost per sync. Profiles are of 15 warm edits to
the last body of 30 independent curved primitives (599,124 triangles), at
`f7a1a1ca`.

1. **Display-mesh closure re-checked on every unchanged body (~180 ms).**
   The open-tessellation advisory runs `inspectDisplayMeshClosure` on each
   published body. A reused measurement has the same immutable buffers as
   last time, but the check ran again, and it built two `Map`s keyed per
   edge with a fresh three-element array per triangle.
2. **Projection diffing compared every buffer twice (~57 ms).** The worker's
   `ProjectionSender` compares each body against the last publication,
   once for the geometry-ready packet and once for the final one. Every
   unchanged body arrived as a fresh copy, so every float and index was
   compared, in a loop indexing a `Float32Array | Uint32Array` union at
   about 16 ns per element.
3. **Unchanged bodies were copied four times (~40 ms).** The adapter copied
   each reused measurement, copied the geometry-ready publication again, and
   the worker's result cache copied the result once to keep and once to hand
   back.

## Changes

- `inspectDisplayMeshClosure` decides the shared-index case with two sorted
  `Float64Array`s of edge keys, one per direction. Every undirected edge is
  used exactly once each way exactly when the forward keys have no repeat and
  equal the backward keys. The result is the same as the map-based check
  (`test/display-mesh-closure.test.ts` compares the two on closed, missing,
  flipped, duplicated, degenerate and out-of-range meshes). The verdict for a
  retained measurement is remembered on its cache entry.
- `sameMeshBuffer` (`@openzcad/shared`) compares mesh buffers through
  `Uint32Array` views. Bitwise equality only differs from `===` for `-0`
  against `+0`, which now republishes, and for identical NaN bytes, which are
  identical. The worker's projection diff and the viewport's
  `reuseRenderBodies` use it.
- The exact adapter gains `shareRetainedMeasurements`. When it is set, an
  unchanged body is published from its retained measurement by identity, in
  the geometry-ready publication and the final state, instead of as a copy.
  The geometry worker sets it, and its result cache copies everything except
  body `mesh` and `topology` (`cloneDerivedSharingBodyGeometry`). An unchanged
  body is therefore the same object from sync to sync, and the projection diff
  skips it by identity. The worker's request-scoped sync reply, the one path
  that transfers derived buffers, now transfers a copy made in the worker.
  Results stay caller-owned by default for every other adapter user.

## Measurements

`test/perf/multi-body-sync.bench.ts` replays the broadcast path (content key,
result cache, exact sync with its geometry-ready publication, both projection
encodes and the main-thread receiver). It runs owned and shared modes on the
same document, 15 warm edits each with a new size, and requires every
publication the receiver holds to be identical between the two. The host is a
4-vCPU Linux container on Node 22. Times are medians in milliseconds; "ready"
is edit to the geometry-ready packet, the first frame the viewer can show.

| Document                         | `f7a1a1ca` ready | `f7a1a1ca` total | This change ready | This change total |
| -------------------------------- | ---------------: | ---------------: | ----------------: | ----------------: |
| 30 curved bodies, 599k triangles |              272 |              319 |               5.5 |               8.7 |
| 100 boxes, 1,200 triangles       |               57 |              100 |                17 |                24 |

A single-body edit re-measures the one body it changes, so it gains only
from the faster closure check. Runs of the harness vary by about ±15 % on this host;
the owned column of each run is the in-run control.

### Browser

In headless Chromium, the click-to-reply time of an Inspector width edit on
the same kinds of document did not change: 100 boxes 152 → 154 ms and 24
curved bodies 615 → 644 ms (median of 16 and 12 edits). That number is not
bounded by the worker here. This container renders WebGL through SwiftShader,
where each frame blocks the page's main thread for 90–370 ms, and the
worker's reply waits for the frame task in progress before it is delivered.
The worker change does not alter main-thread work. Its effect in the browser
therefore depends on frames that are cheaper than this host's, and remains to
be measured on hardware with a GPU.

## Reproduction

```bash
MULTI_BODY_PERF_RUN=1 pnpm exec vitest run --config test/perf/multi-body-sync.config.ts
```

Results append to `artifacts/multi-body-sync/summary.jsonl` (git-ignored).
`MULTI_BODY_PERF_SCENARIOS` and `MULTI_BODY_PERF_SAMPLES` narrow a run. The
baseline column above is the owned mode run against `f7a1a1ca`, whose result
cache had no sharing clone.

## Not changed

- Every geometry-ready packet still lists every body as changed: the
  geometry-ready state has no `volume` and the final one does, so each
  body's metadata revision alternates. The packets carry only metadata for
  those bodies, but the main thread still sees every body's metadata change
  on each edit.
- On the main thread, selecting a history row runs `HistoryTimeline`'s
  `scrollIntoView` inside React's commit. It forces about 20 ms of style and
  layout on this host.
