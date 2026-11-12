---
row: H01
---

Resuming a rolled-back History (Resume full history, or moving the marker
later) rebuilds the candidate first and, when resumed features would fail,
asks Keep rolled back / Resume anyway with each failure and its reason,
instead of committing the breakage silently (ADR-017 November 2026
"preflight resume" amendment; `apps/web/src/lib/historyResume.test.ts`,
`ResumeHistoryDialog.test.tsx`, `test/e2e/feature-history.spec.ts`).
