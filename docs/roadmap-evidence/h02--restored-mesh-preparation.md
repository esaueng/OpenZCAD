---
row: H02
---

Undo after a typed −6 mm face offset on the public 125,042-triangle Hammer Holder
took 236.2 ms on the original build, 209.9 ms on the current control and
80.2 ms with dense mesh preparation reuse (2.95× against the original and
2.62× against the control). These are medians from six fresh Chromium runs
per build on an RTX 3090 using the same input-to-rendered-frame probe
(`test/e2e/perf-face-drag.spec.ts`). Restored shading, silhouettes and tangent
edge IDs matched fresh preparation. Per viewport, two recent entries each have
a 12 MiB admission budget for backing buffers and estimated metadata.
