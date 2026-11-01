---
row: U01
---
Fillet/chamfer drag frames rebuild geometry only and the complete rebuild runs
once the handle rests, which the release commits from: imported seam fillet
155 → 45–58 ms and native arc fillet 71 → 26 ms per frame (Node, Remus
2026.1.98). Covered by `blend-preview-geometry.test.ts` and
`blend-preview-commit-reuse.spec.ts` (PR #1144).
