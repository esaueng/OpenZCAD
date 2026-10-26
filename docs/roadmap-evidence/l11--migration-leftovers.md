---
row: L11
---
Phase 8 leftovers (slice 8-C4, from #914, #918 and #925): the sweep keyset-pages lapsed stagings, at most ten pages of fifty per run, so stagings whose owners may still migrate no longer hide a withdrawn one behind them; the moves of a multipart upload to `completed` (after R2's own completion, and the reconciliation of a lost response) carry the lease the session was opened under, staging or decrypt, so a takeover during R2's completion answers the stale holder 409 `E2EE_MIGRATION_LEASE_LOST` and releases its session at once for the new holder; and a decrypt staging's part reservation carries its decrypt lease, so a stale request after a takeover reserves nothing (`test/e2ee-project-migrations.test.ts`, `test/e2ee-project-migration-reverse.test.ts`).
