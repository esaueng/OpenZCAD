---
row: L11
---

Device approval retains account-scoped browser observations across retries and Settings navigation, and uses an owned request snapshot through completion. Regression coverage in `test/e2ee-account-keys.test.ts` exercises record changes, equivalent encodings, concurrent starts, lost responses, session teardown, certification retries and both approval forms. No migration, rollout flag or deployment configuration changes.

An accepted comparison response can be resumed after its reply is lost, including from the refreshed approval list. A Chromium regression completes approval without repeating the response request; changed response fields and comparisons from an earlier unlocked session remain refused.

After sign-out or session lock interrupts a response before delivery, a still-requested approval can restart under the current unlocked session. The retry retains the original request binding, responder key and nonce, including when a stale requested read hides an accepted response. Account-key regressions cover both teardown paths, changed bindings and earlier-session responded/revealed refusals; a Chromium journey locks, rechecks the session and completes the unchanged comparison through Settings.

The requesting device retains its comparison through confirmation and browser reload. Confirmation names the displayed request, so a stale tab cannot confirm a replacement request; interrupted operations preserve their original lifetime guard. Older unbound comparison requests must restart while their device keys remain stored. Coverage includes persisted metadata and atomic updates in browser and native-adapter stores, response retries, equivalent encodings, and requesting-device reload.
