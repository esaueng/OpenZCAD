---
row: M07
---

Multi-face Offset, chained workspace (slice 3): the workspace no longer
refuses parallel faces at different heights (a slot floor with the top
beside it). Offset arms the one shared handle on the last-picked face, each
face moves along its own normal by the one distance, and a small direction
tick on every face of the set shows which way it moves. While dragging, the
chain's leading plane is previewed display-only every frame from the
kernel's prepared move, and the whole chain at a coarse rate (250 ms).
Release, a typed value and a reopened History row all replay the whole set
with full checks, and kernel refusals are named on the card as on the
single-face path. A set whose faces face different ways, several bodies, a
curved face and more than 64 faces are still refused before any handle
appears. `apps/web/src/lib/faceSetOffset.test.ts`,
`packages/viewport/src/gizmo/faceSetTicks.test.ts`,
`apps/web/src/lib/livePreview.test.ts`, `test/offset-faces-workspace.test.ts`,
`test/e2e/offset-face-set.spec.ts`.
