---
row: L11
---

Device approval retains account-scoped browser observations across retries and Settings navigation, and uses an owned request snapshot through completion. Regression coverage in `test/e2ee-account-keys.test.ts` exercises record changes, equivalent encodings, concurrent starts, lost responses, session teardown, certification retries and both approval forms. No migration, rollout flag or deployment configuration changes.

An accepted comparison response can be resumed after its reply is lost, including from the refreshed approval list. A Chromium regression completes approval without repeating the response request; changed response fields and comparisons from an earlier unlocked session remain refused.
