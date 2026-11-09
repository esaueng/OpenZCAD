---
row: U10
---

Face-offset preview: the ghost of the part as it was reads as a frosted,
outlined shape on the graphite stage (depth pre-pass hides its far side;
stencil-masked, once-per-pixel edges never leak across the live solid). A
pull outlines the old end on the extended part, and while the face is held
the added material draws as ghost, solid again on release. Drag-time preview
edges take the resting ink, so arcs no longer bead or dash before the commit
(`bodyGhost.test.ts`, `bodyUpdate.test.ts`).
