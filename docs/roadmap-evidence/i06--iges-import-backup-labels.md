---
row: I06
---

An IGES import is reported as IGES and says it keeps only its exact STEP
translation; its cloud archive is named `<file>.igs.step`; a native backup
labels that source `model/step` with `translatedFrom: iges`, the export status
says the original IGES file is not stored, and the File menu lists IGES from
the same format table as its picker (`stepImportRun.test.ts`,
`projectBackupTransfer.test.ts`, `TopBar.test.tsx`, `iges-exchange.spec.ts`,
#2380, #2381, #2103).
