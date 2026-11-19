---
row: M07
---

Multi-face Offset, different directions in the workspace (slice 4): the
workspace no longer refuses planar faces that face different directions (a
pocket's floor with its walls, a boss's side walls, two walls at a corner).
Offset arms the one shared handle on the last-picked face's normal, each
face moves along its own normal by the one distance, and each face's
direction tick points along its own normal. The drag preview's leading
plane follows the kernel's geometry-only chain order (direction classes by
normal z, then y, then x, descending; the leading plane first within one),
from a lazily loaded `faceSetOffsetChain` module, and a later step's
refusal is named on the card ("Offsetting face 2 after the others…").
Faces that face opposite ways are still refused before any handle appears,
in the kernel's `OFFSET_FACES_OPPOSITE_NORMALS` words, as are several
bodies, a curved face and more than 64 faces; the unused
`OFFSET_FACES_MIXED_DIRECTIONS` is removed. `apps/web/src/lib/faceSetOffset.test.ts`,
`apps/web/src/lib/refusalLanguage.test.ts`,
`packages/viewport/src/gizmo/faceSetTicks.test.ts`,
`test/offset-faces-workspace.test.ts`, `test/e2e/offset-face-set.spec.ts`.
