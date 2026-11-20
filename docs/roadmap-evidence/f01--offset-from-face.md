---
row: F01
---

Offset-from-face slice: schema v113 adds `toFaceOffset` (a length or
expression) to a to-face extrude. Positive stops the extrusion that far short
of the face, negative carries it past; absent or zero ends on the face, and a
v29 to-face extrude loads byte for byte. The offset is applied on every rebuild
to the distance the face resolves to at the feature's history position, so a
moved face or a changed parameter moves the end and nothing derived is stored.
An offset that reaches or crosses the sketch plane refuses by name ("Offset
from face … reaches the sketch plane"), distinct from the unresolved-face state
a re-pick repairs; a deleted face is still unresolved. An offset beside any
other extent is refused at entry, and switching to Distance clears it with the
face. The Extrude bar offers "Offset from face" on its keypad with To face, the
editor refuses an offset past the sketch plane before Done, and the history row
reads "To face · 5 mm short" (or "past"). Regression evidence:
`test/extrude-offset-from-face.test.ts` (16 × 20 short, 16 × 28 past, a face
below the sketch, a parameter offset and a moved face, a pocket stopping 1.5
short of its floor, a drafted offset prismatoid, refusals, edit round trip and
undo), `ExtrudeCommand.test.tsx` and the `@ci-smoke` case in
`test/e2e/extrude-to-face-draft.spec.ts` (400 → 320 → refused → undo to 400).
Remaining: multi-target and add through-all, to-next, to-face on a slanted or
curved face, start offsets and per-side draft.
