---
row: H01
---

Resuming one History row from its own Resume action now takes the same
preflight: the candidate is rebuilt first and, when the row or a later
feature that was building would fail, asks Keep suppressed / Resume anyway
with each failure and its reason; a clean resume commits the same single
command with the checked rebuild (ADR-017 November 2026 "preflight resume"
amendment; `apps/web/src/lib/historyResume.test.ts`,
`ResumeHistoryDialog.test.tsx`, `test/e2e/feature-history.spec.ts`).
