---
row: L10
---

2026-11-13 unified storage slice: one storage allowance per account (Free
1 GiB, Premium 25 GiB in total) for projects, save states, source assets,
imports, exports and encrypted files. Migration
`0049_unified_account_storage.sql` redefines every quota trigger to compare
combined usage with a single limit; Settings shows one Storage meter with a
projects/files breakdown, and the project count excludes the recycle bin
(reported apart). Regression coverage: `test/unified-account-storage.test.ts`
(real-migration trigger tests), `test/account-tiers.test.ts`,
`test/account-storage-usage.test.ts`, `test/persistence.test.ts`,
`SettingsPage.test.tsx` and the membership case in `test/e2e/settings.spec.ts`.
Migration 0049 applies with the deploy; live verification remains pending.
