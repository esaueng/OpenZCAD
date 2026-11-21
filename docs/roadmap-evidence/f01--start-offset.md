---
row: F01
---

Start-offset slice: schema v121 adds `startOffset` (a signed length or
expression along the sketch normal) to a blind or to-face extrude. The
extrusion is built on its start plane, the sketch plane moved by the offset,
so a blind distance, a back distance and a symmetric span run from it and a
draft hinges on it; a to-face extrude runs from it to the face, less any
offset from the face. Absent or zero starts on the sketch plane, and every
older extrude loads byte for byte. The offset is resolved on every rebuild,
so a changed parameter moves the start and nothing derived is stored. A
start at or past where a to-face extrusion ends refuses by name ("Start
offset … reaches where the extrusion ends at the face"), distinct from the
unresolved-face state; through all refuses a start offset at entry, edit and
rebuild. The Extrude bar offers "Start offset" on its keypad except through
all, its back arrow and draft rig stand on the start plane, the editor
refuses a start past the face before Done, and the History row reads
"10 mm · starts 5 mm off". Regression evidence: `test/extrude-start-offset.test.ts`
(16 × 10 from z = 5, a negative distance, a start below the sketch, symmetric
and back-distance spans about the start plane, a parameter start, to-face
16 × 20 and 16 × 25 with an offset from the face, start-past-face refusals,
a cut pocket that starts inside the block, a drafted prismatoid hinged on the
start plane, entry refusals, rename, edit round trip and undo, the editor
rules and the History row) and the `@ci-smoke` case in
`test/e2e/extrude-to-face-draft.spec.ts` (400 → 320 → refused → undo to 400).
Remaining: multi-target and add through-all, to-next, to-face on a slanted
or curved face and per-side draft.
