---
row: L11
---

Retained-save backup repair: encrypted named saves stamp their captured checkpoint at the version actually sealed, preserving older checkpoints and caller-owned documents. Existing authenticated saves with the older one-step envelope version skew export their captured logical snapshot without changing the source or current head. Project, checkpoint and revision identity checks remain enforced; unrelated or larger mismatches still fail. Coverage includes real Worker/MLS saves and historical reads, malformed-identity controls, and a complete bulk ZIP containing the legacy retained snapshot (`test/e2ee-project-documents.test.ts`, `apps/web/src/lib/projectBackupDeviceCheckpoints.test.ts`, `apps/web/src/lib/dataExport.test.ts`).
