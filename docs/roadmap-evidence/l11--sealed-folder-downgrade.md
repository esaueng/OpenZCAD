---
row: L11
---

Library folder migration remains one-way after a device authenticates sealed
state: plaintext load and conflict responses cannot alter its folders, including
after codec recreation or account-key rotation. Synthetic regression coverage
retains first-time legacy migration and multi-device sync
(`sealedLibraryFolders.test.ts`).
