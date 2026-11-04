# Union face drag latency

M07: the right end of the supplied filleted union now follows a drag through
the existing disposable display preview. The exact history command and its
validation still run on release. This is a local result, not deployment
verification or a speedup of exact history replay.

## Cause and change

The source has 61 features, including 56 face offsets. Resizing the end edits
the original box, so an exact preview replays all those offsets. Local adapter
samples took 2.0–2.6 seconds per preview. The existing immediate display path
was incorrectly declined: a Float32 sliver on a trimmed cylindrical round
gave a misleading triangle normal. Recognition treated that straight wall as
a moving round, reached the separate junction blend, and refused the profile.

`stepPreviewProfile` now uses a plane's analytic normal or a cylinder's
analytic axis to recognize a carrier ruled along the drag. Other carriers
retain the triangle check. Region membership, compound exclusion, triangle
fold limits, cancellation, final commands and exact validation are unchanged.
There is no Remus, tolerance or display-deflection change.

## Matched browser measurements

Both locally built production bundles use application baseline `a539f45a1`
and the paired Remus pin `6b44ca58f16971b32a45c0721e17e4970fd8b0d7`.
The control overrides only the recognition module with its unchanged baseline
source; the candidate includes this patch. Headed Chromium 156.0.8078.4,
Playwright 1.64.1, macOS 27.0.1, Apple M5 Pro / ANGLE Metal, 1440 × 1000 CSS
pixels and DPR 1 were used. Other host activity was not controlled. No CPU
profiler was enabled. Order: baseline/candidate, candidate/baseline,
baseline/candidate.

Each run sends 120 pointer moves at nominal 16 ms intervals, extending the
end by 9 mm and returning to +3 mm, then validates the released edit. The
maintained `perf-face-drag-trace.spec.ts` probe records frames after WebGL
submission; physical display scanout is not measured.

| Measurement                                    | Baseline, three runs        | Candidate, three runs       |
| ---------------------------------------------- | --------------------------- | --------------------------- |
| Median input to changed geometry/display frame | 3751.8 / 3282.1 / 3245.3 ms | 1.9 / 6.0 / 4.4 ms          |
| Per-run p95                                    | 4658.4 / 4175.1 / 4167.6 ms | 6.5 / 6.7 / 6.5 ms          |
| Exact preview requests during motion           | 2 / 3 / 2                   | 0 / 0 / 0                   |
| Immediate display frames during motion         | 0 / 0 / 0                   | 120 / 120 / 120             |
| Release to authoritative ready frame           | 1441.8 / 1101.6 / 1118.2 ms | 2730.8 / 2594.5 / 2677.2 ms |

All six runs passed. The candidate's slowest immediate response was 10.9 ms;
per-run p95 render intervals were 9.7–10.6 ms. The visual response exceeds the
requested 10× improvement. The baseline waits for an exact rebuild, whereas
the candidate presents a disposable mesh projection, so these numbers must
not be described as a kernel speedup. Release is slower because no exact
preview was computed during the drag.

## Geometry and regression evidence

- On the supplied model, offsets +0.2, +5, +15, −2 and −5 mm agree with the
  canonical primitive-dimension rebuild in volume change to within 0.027 mm³,
  at the existing display tessellation's precision. The original approximate
  corner advisories remain present. No private model or raw recording is
  checked into the repository.
- The public filleted-union regression fails before the patch because no
  immediate profile is recognized. It verifies inward/outward extents and
  volume change against exact rebuilds and leaves every junction NURBS vertex
  stationary. This suite is included in the CI smoke manifest.
- The browser regression moves out, back and inward, verifies changed whole
  geometry with zero exact-preview requests, cancels without adding history,
  and then checks Total entry, Apply, undo, redo and reload. Generic imported
  and compound-offset browser regressions also pass.
- Lint (existing warnings), typecheck, the complete build and bundle-size
  gate, and all 92 parity-corpus assertions pass. The complete local root/web
  suites also expose unrelated baseline failures; see the implementation PR
  for their unchanged-source reproductions and platform limitations.

This qualifies the selected ruled end-face path. The top face's intersecting
rim still needs exact reconstruction and is not made real time by this patch.

Reproduce against either bundle with its own `PLAYWRIGHT_PORT`:

```bash
PLAYWRIGHT_PORT=5179 OZ_PERF=1 \
OZ_FACE_DRAG_PROJECT=/path/to/model.openzcad \
OZ_FACE_DRAG_NORMAL=1,0,0 OZ_FACE_DRAG_DISTANCE=9 \
OZ_FACE_DRAG_MOVES=120 OZ_PERF_OUT=/tmp/face-drag.jsonl \
pnpm exec playwright test test/e2e/perf-face-drag-trace.spec.ts \
  --grep 'supplied project' --headed --workers=1 --output=/tmp/face-drag
```
