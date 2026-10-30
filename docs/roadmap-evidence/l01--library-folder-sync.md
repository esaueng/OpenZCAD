---
row: L01
---
Library shelf cross-device sync: the Projects shelf re-lists the account on
focus, visibility and every 60 s (#1036, `libraryRefresh.test.ts`), and
library folders, pins and order sync through the account (#1037, #1040,
#1041, #1043): a per-field mergeable folder set (`libraryFolderSync.test.ts`,
including a seeded three-device convergence run), D1 migration 0045 with
compare-and-set `/api/library-folders` (`library-folder-sets.test.ts`), the
client sync loop (`libraryFolderCloudSync.test.ts`) and, for encrypting
accounts, records sealed under the account key per the ADR-024 amendment of
2026-10-30 (`library-folders.test.ts` fixed vector,
`sealedLibraryFolders.test.ts`). Enabled for beta by
`LIBRARY_FOLDER_SYNC_ENABLED` once migration 0045 is applied.
