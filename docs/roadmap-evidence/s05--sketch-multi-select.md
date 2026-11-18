---
row: S05
---

Sketch entities select several at a time, as bodies do: under Select a drag
sweeps a box (left to right takes what lies wholly inside, right to left also
what it touches) and Shift or Cmd/Ctrl-click adds or drops one; Cmd/Ctrl+A
selects every entity. Mirror armed over a selection asks only for the axis
and mirrors each entity about it in one undoable transaction, leaving out and
counting any it cannot mirror. Delete removes the whole selection in one step.
Cmd/Ctrl+C and V copy and paste entities as new, unrelated geometry stepped
clear of the originals; relations are not copied, and a linked projection
pastes unlinked (`machine.test.ts`, `modify.test.ts`, `boxSelect.test.ts`,
`clipboard.test.ts`, `test/e2e/sketch-modify-tools.spec.ts` "a box selects
several entities"). Moving a multi-selection by drag is not part of this slice.
