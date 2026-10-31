---
row: H02
---

A resting hole drag computes a complete exact validation that release can
reuse, finished or still running. This includes the exact-display fallback
when a viewport projection is unavailable. Reuse requires the same value,
project/version and face-operation selection; expressions and stale results
follow the ordinary validation path. Geometry-only snapshots remain
non-authoritative. `bore-rest-validation.spec.ts` counts one full validation
for each accepted finished/running release, checks the stored diameter and
exercises refusal after an oversized drag. `useDirectEditCommit.test.tsx`,
`livePreview.test.ts` and `previewRebuilds.test.ts` cover freshness and refusal
boundaries. This bounded generated fixture does not close the holder-session
qualification or establish a universal latency target.
