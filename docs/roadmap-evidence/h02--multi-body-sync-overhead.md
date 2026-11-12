---
row: H02
---

Multi-body edits no longer pay for unchanged bodies: the display-mesh closure
verdict is remembered with the retained measurement, mesh buffers compare
through `Uint32Array` views, and the worker publishes unchanged bodies by
identity (`shareRetainedMeasurements`). Node replay of the worker path, edit
to first geometry: 30 curved bodies 272 → 5.5 ms, 100 boxes 57 → 17 ms; the
headless-SwiftShader browser edit was unchanged, bounded by main-thread frames
(`test/exact-shared-measurements.test.ts`, `test/display-mesh-closure.test.ts`,
[QA note](docs/qa/2026-11-12/multi-body-sync-overhead.md), PR #1366).
