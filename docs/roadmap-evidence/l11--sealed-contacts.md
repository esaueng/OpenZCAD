---
row: L11
---

Contacts lists are sealed under the account key (ADR-024 amendment
2026-11-14): each identity-signed entry travels in an AES-256-GCM record of
fixed size that the Worker can order, link and signature-check but not
read; account-key rotation reads older records through the account-key
history; a plaintext list is resealed with the same entries, keeping every
pin and approval head (`packages/crypto/src/sealed-contacts.test.ts` with a
fixed vector checked against Python `cryptography`, `test/e2ee-contacts.test.ts`,
`apps/web/src/components/EncryptionContacts.test.tsx`).
