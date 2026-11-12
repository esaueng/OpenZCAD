---
row: H02
---

Face-offset and cylinder-diameter releases: the commit adopts its own
validation sync as the live result instead of a duplicate broadcast rebuild
(`useGeometryWorker.test.tsx`, `test/e2e/filleted-union-face-offset.spec.ts`),
and a release still validating can be taken again — set aside, never committed
unvalidated, reused when the hand lands on the same value
(`useDirectEditCommit.test.tsx`, `machine.test.ts`, retake e2e). Local release
→ live result on a private 32-feature filleted-union reproduction: top 488 →
293 ms, side −32 mm 602 → 381 ms; cylinder remains bound by the exact resize
([edit sessions](docs/interactive-edit-sessions.md), PR #1356).
