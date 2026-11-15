---
row: L11
---

Sealed account settings: an account whose library is encrypted stores only
the sharing switch and the assistant's route readable; every other setting,
custom assistant instructions included, is sealed under the account key
(`user_settings.sealed_settings`, migration 0055) and opened in the browser.
Custom instructions travel with each assistant request, and the consent copy
moves to version 3 to list them. The sealed-record layout is shared with
library folders, whose fixed vector is unchanged. Regression evidence:
`packages/crypto/src/sealed-records.test.ts` (independent fixed vector),
`test/sealed-account-settings.test.ts`, `accountSettingsSealing.test.ts`,
`consentCopy.test.ts`
([ADR-024 amendment 2026-11-14](docs/adrs/ADR-024-end-to-end-encrypted-projects.md)).
