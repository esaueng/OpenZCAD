---
row: W01
---

One-off builds for documents with at least 256 bodies can send exact topology
as UTF-8 JSON within the existing 8 MiB transport budget. On the 500-body
isolated width edit, median Apply to the rendered frame fell from 235.7 to
213.4 ms and request to worker reply from 120.2 to 96.9 ms. The original
baseline measured 253.4 ms to frame (1.19× overall). Three fresh desktop
Chromium sessions per build performed seven checked edits each with the same
released kernel. Reproduce with the [CAD edit probe](test/e2e/perf-cad-edit.spec.ts)
using `OZ_PERF=1 OZ_PERF_ANGLE=gl CAD_PERF_BROWSER_HISTORY=500 CAD_PERF_BROWSER_ISOLATE=1 CAD_PERF_BROWSER_SAMPLES=7`.
