---
row: U03
---

Short-stage Tools drawer follow-up to PR #1378: on a stage 540 px tall or
less the close button, drawn beside the search and filters, now follows them
in the keyboard's order too (it preceded them, WCAG 2.4.3), and keeps the
title-then-search order on taller stages (`CommandCard.test.tsx`,
`test/e2e/design-review-followups.spec.ts` at 844 × 390 touch and
1280 × 520); the same spec now covers the drawer while a search is typed:
results scroll inside the sheet, the last one is in reach, the foot stays in
view and the sheet stays inside its frame.
