---
row: U03
---

13 November design review I2: every library, demo, settings, assistant,
measurement, credential and account-restore confirm is one in-page
`ConfirmDialog` (`useConfirm`) with focus on Cancel instead of a native
`window.confirm()`; Move to trash and Archive answer with an Undo toast;
Activity log Clear asks while "Confirm destructive actions" is on; the
feature Delete dialog focuses Cancel (`ConfirmDialog.test.tsx`,
`ActivityLogSettings.test.tsx`, `AssistantPanel.test.tsx`,
`start-tile-reorder.spec.ts`, `feature-delete.spec.ts`, `cloud-sync.spec.ts`).
