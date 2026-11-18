---
row: U11
---

Extrude can take a left-to-right window of fully enclosed sketch regions or a
right-to-left crossing of regions touched by the box. The viewport tests the
same filled triangles it draws and uses Extrude's whole-sketch rules to keep
openings out of the bulk pick. One selection drives the shared profile handles.
A box spanning different sketches leaves the
current selection in place and explains the single-sketch scope. The browser
test cuts a pair of pockets with one Extrude after sweeping the same box in
both directions (`test/e2e/multi-region-extrude.spec.ts`), and the region
overlay test checks a sweep wholly inside a hole.
