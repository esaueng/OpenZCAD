---
row: L10
---

The library footer shows account storage against its shared allowance and opens
a breakdown of project storage, files and pending uploads, plus browser storage
details (PR #1514). Settings retains its existing totals and wording. Regression
coverage exercises sync suspension, manual retry, account changes, stale responses,
sign-out, Trash navigation focus and panel positioning on phone and desktop
layouts (`StartScreen.test.tsx`, `test/e2e/start-screen-responsive.spec.ts`).
