---
row: L11
---

Device approval retains account-scoped browser observations across retries and Settings navigation, and uses an owned request snapshot through completion. Regression coverage in `test/e2ee-account-keys.test.ts` exercises record changes, equivalent encodings, concurrent starts, lost responses, session teardown, certification retries and both approval forms. No migration, rollout flag or deployment configuration changes.
