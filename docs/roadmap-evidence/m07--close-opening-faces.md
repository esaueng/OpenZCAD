---
row: M07
---

Openings close two ways. Pushing a planar single-loop face into the wall
opposite it now adds the prism the face sweeps through, when every face
beside it is a plane parallel to the push and the push stays in the body:
a window's floor pushed to its top or past it into wall closes the window
exactly, and a push that would leave the body still refuses. A new replayable
`remove-faces` direct edit deletes several faces of one body together, with
every face pinned by its hash, surface type, area and centre. Selecting the
four walls of a window closes it. Selecting three of them refuses, and the
refusal says to select every face around the opening. In the workspace,
Shift-click on faces of one body builds a face set, and Delete removes the set
as one undoable edit (`test/close-opening-direct-edit.test.ts`,
`apps/web/src/lib/faceSetSelection.test.ts`).
