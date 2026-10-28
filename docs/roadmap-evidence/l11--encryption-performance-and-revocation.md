---
row: L11
---

Performance follow-up: bulk account downloads reuse their complete retained-revision catalog and overlap independent metadata reads; encrypted head/log verification reuses current verified membership inputs within one read, with a cold shared-project request budget and a next-read withdrawal regression (`test/e2ee-member-lists.test.ts`, `apps/web/src/lib/dataExport.test.ts`, `apps/web/src/lib/projectBackupDeviceCheckpoints.test.ts`).

Post-revocation repair: Settings encryption-state changes invalidate the page clients that captured the previous account view, so sharing, invitations and project reads reopen against rotated keys without a reload; late superseded openings cannot overwrite fresh verification state (`apps/web/src/lib/e2ee/encryptedProjects.test.ts`).

Review hardening for PR #983: authorship cutoffs use the same verified device lists as signature decisions. Retired page views refuse captured and in-flight file/document access; unlocked rechecks lazily reopen direct file readers and reconnect encrypted rooms while preserving unsent edits. Regressions cover lock races, superseded openings, historical signatures, current cutoffs, and fresh reads without a page reload.
