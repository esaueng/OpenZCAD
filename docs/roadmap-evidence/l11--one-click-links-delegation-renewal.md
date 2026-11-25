---
row: L11
---

Sharing simplification slice 7 (plan PR #2052, owner decision D4; ADR-024 amendment 2026-11-25): Create link makes a view-only link without history in one click, with name, access, history and comments behind Options… (`ShareLinkComposer`, shared with plaintext links; `ShareLinkCard.test.tsx`, `EncryptedShareLinks.test.tsx`, `ProjectSharingDialog.test.tsx`, `encrypted-share-links-owner.spec.ts`). The 30-day share delegation is renewed in passing by any identity-authorized action once it has less than 14 days left (`afterIdentityKey` in `accountKeys.ts`, `renewShareDelegationInPassing`; `e2ee-account-keys.test.ts`, `e2ee-share-links.test.ts`), best effort, after the action and with the device list it left; Create link asks only once the delegation is missing or expired, and the Links tab shows a quiet "Confirm by" chip until then. `maintainEncryptedShareLinks` (`backgroundShareLinkUpkeep.ts`) exposes link upkeep for the app-level background runner.
