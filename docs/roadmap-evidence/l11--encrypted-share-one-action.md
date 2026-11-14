---
row: L11
---

13 November design review I79: the encrypted Share dialog makes no plaintext
sharing call (only the metadata `GET /sharing` the format gate lets through;
the red banner came from a review fixture that refused that route), and Create
link now asks for the sharing confirmation itself and then makes the link,
with no separate "Confirm sharing…" step unless existing links need it
(`EncryptedShareLinks.test.tsx`, request log in `encrypted-sharing.spec.ts`,
`encrypted-share-links-fixtures.ts`).
