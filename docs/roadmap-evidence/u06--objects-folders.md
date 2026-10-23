---
row: U06
---

Schema v34 adds canonical nested Objects folders, body placements and body rename through undoable, replayable commands. Drawing annotations (v31), reference images (v32), and projections (v33) remain intact in current documents and retained history. Folder-only edits retain ready geometry; image and folder sections remain absent from private geometry diagnostics. Server and collaboration validation reject malformed current and historical folder/image data before storing it. Share snapshots preserve folder organization while omitting command/undo history. Evidence: `test/object-folders.test.ts`, `test/object-folders-collaboration.test.ts`, `test/body-rename.test.ts`, and `test/schema-v33-integration.test.ts`; web controls are covered by `ObjectsPanel.folders.test.tsx` and `test/e2e/objects-folders.spec.ts`. No production migration command is needed for these additive document fields.

Additional v35 integration retains explicit positive carrier-version floors across current content, readable undo history and nested saved replay. Combined exact source-resize, drawing/image/PNG/folder retention and malformed-carrier refusals are covered by `test/schema-folders-retention.test.ts`, `test/schema-folders-compatibility.test.ts` and `test/schema-distance-folders-retention.test.ts`.
