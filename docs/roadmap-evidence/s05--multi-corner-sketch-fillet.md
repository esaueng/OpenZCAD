---
row: S05
---

Sketch Fillet previews multiple line junctions at one radius. Corners can be
picked and toggled directly or identified by picking their two lines. One
validated transaction trims each shared line once and adds the tangent arcs and
their driving radii. Trims that would consume or overlap on a shared edge leave
the picks in place for a smaller radius. One Undo restores the original sketch.
The slotted-plate browser journey covers the four-corner edit before Slot,
Extrude, and solid Fillet. A touch case covers radius refusal and retry
(`apps/web/src/lib/sketch/filletBatch.test.ts`,
`test/e2e/u11-slotted-plate.spec.ts`).
