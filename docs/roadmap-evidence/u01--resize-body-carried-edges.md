---
row: U01
---

Resize Body through later blends with unnamed picks: dragging the right face
of a Box → Cylinder → Union → Fillet ×3 → Chamfer part from 30 to 22.5 mm
previewed correctly and was refused on release as "Selection changed",
because a later Chamfer/Fillet stored its edges as geometry hashes (the
blended body publishes no name for them) and the width edit moved them.
An edit's own preview and validation may now propose carrying such a
hash-only selection (`proposeCarry`), and the commit writes the new hashes
in the edit's revision (refused if it cannot). A plain build never carries,
so a document builds the same on every adapter. A carry needs a pure
dimension edit (`exact-carry-edit-gate.ts`, an explicit allow-list:
primitive dimensions, extrude distance, blend size, direct-edit offset or
distance, sketch sizes and centres, length constraints), the same structure
with unique labels, a fixed frame (an uncarried edge still resolving by its
own hash, every hash-resolved edge keeping its label), planes moving along
one line, and a uniquely hashed target (`exact-edge-selection-transport.ts`).
A turn, mirror, pattern or other non-dimension edit, a symmetric twin, a
structural change, a body with no fixed edge or a step after a manual
suppression refuses, typed `reference_missing`, as do the other
lost-reference sources; a refusal thrown inside the worker keeps that code.
"Selection changed" means only the command's own pick; a later feature
stranded by the edit is named with "Try a smaller change, or edit it". A
refused edit of an existing step shows on that step's history row while its
plan edits it in place.
Coverage: `test/upstream-resize-carried-edges.test.ts` (each carry matched
to a fresh pick at the new size, plain builds equal to cold ones, cold
reloads, turn/mirror/off-centre-boss/equal-sides refusals, unrelated broken
feature, suppression, Heat Sink), `exact-carry-edit-gate.test.ts`,
`exact-edge-selection-transport.test.ts`, `workerRefusal.test.ts`,
`topologyReferenceRepairs.test.ts`, `machine.test.ts`, K10 ledgers
re-recorded with app-equivalent edit validation and cold reopen.
