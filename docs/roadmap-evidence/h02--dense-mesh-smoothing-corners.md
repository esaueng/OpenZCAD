---
row: H02
---

Dense display-mesh smoothing retains each edge's incident triangle corners.
On the public 125,042-triangle STEP hammer holder, smoothing took 75.4 → 62.3 ms
and full CPU viewport preparation took 104.2 → 90.5 ms (27 samples per revision).
All prepared buffers, tangent edge IDs and silhouette data matched. In three
interleaved Chromium runs per build on an RTX 3090, the median typed −6 mm face
preview took 265 → 259 ms, Apply 613 → 622 ms and Undo 263 → 227 ms.
The 2× end-to-end target remains open. The opt-in
`test/e2e/perf-face-drag.spec.ts` accepts `OZ_PERF_ANGLE=gl` for hardware rendering.
