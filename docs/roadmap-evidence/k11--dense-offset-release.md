---
row: K11
---

Dense face-offset previews prepare pickable geometry in the geometry worker.
Releasing the handle can display a matching in-flight result while the full
history check runs. The sparse history cache can restore the last checked
offset when a user appends another one. The supplied-project mode in
[test/e2e/perf-face-drag-trace.spec.ts](test/e2e/perf-face-drag-trace.spec.ts)
can release on the final pointer sample and read back a frame at the expected
solid height. Three alternating Chromium runs per build on an RTX 3090 used
a 40-feature threaded part, a +14 mm offset and four mouse samples spaced
80 ms apart. With the paired Remus change, median input-to-framebuffer time
fell from 13.925 s to 1.365 s (10.2×). Median input-to-checked-history time
fell from 12.603 s to 5.621 s. The exact solid matched byte for byte, and undo
and redo restored the saved feature definitions. The 100 ms target remains open.
