---
row: L01
---
Explicit conflict choices (PR #982): compact clickable rows show each version's
latest canonical edit date, local time and timezone, with a Newer label.
Replacing either side keeps the original project and creates no recovery project.
Only Keep both saves an ordinary local copy owned by the current user before
remote adoption, with retries reusing only a copy still present outside Trash.
Imported STEP/mesh sources and
reference pictures, including retained undo/redo, are integrity-checked and cached
before their original artifact identities are detached. Existing recovery projects remain readable.
Evidence: `ProjectConflictDialog.test.tsx`, `conflictRecovery.test.ts`,
`accountConflictRecovery.test.ts`, `conflictLocalCopy.test.ts`, and
`test/e2e/cloud-sync.spec.ts` cover timestamps, ownership, preserved undo/redo,
permissions, failures/retries and all three choices across two browsers, including
390px and keyboard selection. Live deployment acceptance remains separate.
