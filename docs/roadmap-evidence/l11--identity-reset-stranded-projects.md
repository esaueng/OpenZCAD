---
row: L11
---

Issue #1704, encrypted projects stranded by an identity discontinuity: a profile deletion keeps owned encrypted projects but erases the account's identity, wraps, leaves and authority records, and stable per-email user ids bring a later sign-in back to the same account, where a fresh setup is an unrelated generation 1. The deletion preview now counts owned encrypted projects, the dialog says their cloud copies stay unreadable to the account, and the Worker refuses a profile deletion (409 `ACCOUNT_DELETION_ENCRYPTED_PROJECTS`, before any fence) that owns more than the request acknowledges. A browser that still pins the erased owner identity keeps refusing, with every pin kept, but names the cause and the way forward (export, import, save the copy) instead of a retry; a rotated identity or an unchanged one keeps the generic withdrawal refusal. Regression evidence: `test/e2ee-identity-reset.test.ts`, `CloudDataDeletionDialog.test.tsx`, `TopBar.test.tsx`.
