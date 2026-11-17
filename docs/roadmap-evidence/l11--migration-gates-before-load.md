---
row: L11
---

Automatic migration again checks all four rollout gates before it loads
any optional chunk, so closed gates and older servers leave Settings
closed after the controller moved off the entry chunk
(`automaticMigrationLoader.test.ts`; `encryption-settings.spec.ts` closed
gates).
