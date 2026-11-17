---
row: L01
---

Account library sync now unlocks an already trusted device after reload even
when no encrypted project has loaded, so folders and sealed project pins can
upload and appear on another device. Unlock and device-approval notifications
retry the library immediately. Synthetic regression coverage uses the real
sealed-folder codec for a cold upload/download and checks locked devices and
account cancellation (`libraryFolderUnlock.test.ts`,
`useLibraryFolderCloudSync.test.ts`); live cross-device acceptance remains L01.
