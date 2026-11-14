---
row: U03
---

13 November design review I22 and I9: after Ctrl+Z the status says "Undid
Add box." (Redo: "Redid …"); a create's outcome ("Added box.") offers Undo
beside it; an explicit save says "Made a save point" rather than autosave's
"Saved on this device."; the assistant prompt keeps focus after a question is
sent; removing a key in the keymap editor moves focus to the next key or Add
key; the status toast is named "Open activity log" with no trailing period
(`toast-outcomes.spec.ts`, `WorkspaceReadout.test.tsx`, `CommandBar.test.tsx`,
`KeymapEditor.test.tsx`, `commandOutcome.test.ts`).
