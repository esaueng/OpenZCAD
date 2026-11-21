---
row: F01
---

Start-offset slice: schema v121 adds `startOffset` (a signed length or
expression along the sketch normal) to a blind or to-face extrude. The
extrusion is built on its start plane, the sketch plane moved by the offset,
so a blind distance, a back distance and a symmetric span run from it and a
draft hinges on it; a to-face extrude runs from it to the face, less any
offset from the face, whichever side of the start the face lies on (a start
beyond the face runs back to it, and a face on the sketch plane is reached
from a start off it). Absent or zero starts on the sketch plane, and every
older extrude loads byte for byte. The offset is resolved on every rebuild,
so a changed parameter moves the start and nothing derived is stored. One
shared rule (`toFaceExtent`) decides the build and the editor: a start on
the face, or an offset from the face that reaches the start, refuses by
name, distinct from the unresolved-face state; through all refuses a start offset at entry, edit and
rebuild, and a feature pattern refuses a through-all copy its source refuses. The pierce retry tests the start cap where it actually lies. The Extrude bar offers "Start offset" on its keypad except through
all, its region arrow, ghost, back arrow and draft rig stand on the start plane, the editor
refuses a start on the face before Done, and the History row reads
"10 mm · starts 5 mm off". Regression evidence: `test/extrude-start-offset.test.ts`
(16 × 10 from z = 5, a negative distance, a start below the sketch, symmetric
and back-distance spans about the start plane, a parameter start, to-face
16 × 20, 16 × 25 with an offset from the face, a start beyond the face running back to it, a face on the sketch plane reached from a start offset, named refusals, a boss whose offset start cap lies on the target face, a pattern refusing a through-all copy,
a cut pocket that starts inside the block, a drafted prismatoid hinged on the
start plane, entry refusals, rename, edit round trip and undo, the editor
rules and the History row) and the `@ci-smoke` case in
`test/e2e/extrude-to-face-draft.spec.ts` (400 → 320 → refused → undo to 400).
Remaining: multi-target and add through-all, to-next, to-face on a slanted
or curved face and per-side draft.
