---
row: M07
---

Multi-face Offset diagnostics: a face set's attempt is now recorded in the
direct-edit replay log as an `offset-faces` fixture (fixture format 3; formats
1 and 2 still load) with every face and the distance, and replays as the whole
set rather than its first face. "Save reproduction" of a refused
`offset-faces` build records each face snapshot, `additionalFaces` included,
and the distance beside the document that replays it.
`apps/web/src/lib/refusalReproduction.test.ts`,
`apps/web/src/lib/interactionDiagnostics.test.ts`, and the
`*-offset-faces*` scenarios in `test/direct-edit-corpus/authored.ts`.
