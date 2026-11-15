---
row: L11
---

Library rule: an account that owns or is a member of an encrypted project
seals its library folders and adopts device projects encrypted even without
the "Encrypt new projects" opt-in, so a "Keep both" or recovery copy of an
encrypted project never reaches the account as plaintext. The Worker refuses
plaintext folder records and plaintext adoptions for such accounts and
reports `libraryEncrypted` on the preference route; the browser decides
before sending (`encryptsAccountLibrary`). Regression evidence:
`test/e2ee-project-format.test.ts`, `test/library-folder-sets.test.ts`,
`projectFormatLoads.test.ts`, `libraryFolderAccountSync.test.ts`
([ADR-024 amendment 2026-11-14](docs/adrs/ADR-024-end-to-end-encrypted-projects.md)).
