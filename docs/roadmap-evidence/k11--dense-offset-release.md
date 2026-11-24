---
row: K11
---

Dense face-offset previews prepare pickable geometry in the geometry worker.
Releasing the handle can display a matching in-flight result while the full
history check runs. The sparse history cache can restore the last checked
offset when a user appends another one. The supplied-project mode in
[test/e2e/perf-face-drag-trace.spec.ts](test/e2e/perf-face-drag-trace.spec.ts)
can release on the final pointer sample and read back a frame at the expected
solid height. A local Chromium comparison on a threaded part with 40 history
features and the same frozen kernel reduced median input-to-draw time from
25.09 s to 2.64 s across three runs per build. The 100 ms target remains open.
