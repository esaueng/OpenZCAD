---
row: U09
---

Phase 6 (P, R): Plane, Axis and Image run in place. A Plane's sources are
picked in the model — one plane (a ghost principal plane, a datum or a flat
face) is an offset plane with an offset handle, two a midplane, a plane and
an edge end a parallel plane through it, three edge ends a plane through
them — each kept as the associative source the card stored; Flip normal is
in Options. An Axis is inferred the same way from a straight edge, a
cylinder, two edge ends or two planes, with Reverse in Options. The datum is
previewed from the exact build before Done, which commits through the same
resolved-datum check the card ran. An Image asks for its picture, then a
plane or face; a click places it on the sketch snap, a corner handle scales
it, a ring turns it, an offset chip slides it along a principal plane's
normal, two clicks on it and a distance chip scale it to size, and opacity
is in Options; Done adds it as one step and Cancel releases its bytes
(`datums.test.ts`, `image.test.ts`, `useInPlaceCommand.test.tsx`,
`test/e2e/datum-planes.spec.ts`, `test/e2e/datum-point-planes.spec.ts`,
`test/e2e/datum-axes.spec.ts`, `test/e2e/reference-images.spec.ts`,
`test/e2e/datum-plane-viewport.spec.ts`). Typed point positions and 5%
opacity steps stay on the History and image cards.
