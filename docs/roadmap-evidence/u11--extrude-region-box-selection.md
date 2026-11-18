---
row: U11
---

Extrude can take a left-to-right window of fully enclosed sketch regions or a
right-to-left crossing of regions touched by the box. The viewport tests the
same filled triangles it draws and uses Extrude's whole-sketch rules to keep
openings out of the bulk pick. Launching Extrude enables profile sweeps, and
one selection drives the shared handles. A box spanning multiple sketches
takes hits from the armed sketch when present, and asks for one sketch when
the sweep is ambiguous. The browser
test cuts a pair of pockets with one Extrude after sweeping the same box in
both directions (`test/e2e/multi-region-extrude.spec.ts`), and the region
overlay test checks a sweep wholly inside a hole.
