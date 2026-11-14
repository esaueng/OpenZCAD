---
row: L10
---

Storage allowances lowered to Free 100 MiB and Premium 1 GiB (from 1 GiB and
25 GiB) through `MAX_ACCOUNT_STORAGE_BYTES` and `PREMIUM_STORAGE_BYTES`; the
Worker's stored-limit sync applies them without a migration
(`test/account-tiers.test.ts`, `test/unified-account-storage.test.ts`,
`test/multipart-upload-accounting.test.ts`).
