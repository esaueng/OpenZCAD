---
row: U03
---

13 November design review I74: each conflict row names its own copy when the
names differ, adds a relative time ("2 minutes ago") to the exact one, says
"Newer · under 1 s" when both copies show the same second, and pluralises
"1 edit · 1 save point"; "Decide later" keeps an account conflict, and the
Conflict chip reopens either kind (`ProjectConflictDialog.test.tsx`,
`TopBar.test.tsx`, the two-device cases in `cloud-sync.spec.ts`).
