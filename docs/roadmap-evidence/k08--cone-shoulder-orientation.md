---
row: K08
---

The #1258 cone-to-cone shoulder fillet is qualified on paired Remus 2026.1.129
through the production adapter. The regression constructs the reported circle,
23 mm extrusion with -33 degree draft, 6.1 mm upper-rim chamfer and 1 mm
shoulder fillet. Its five-face result keeps a closed, consistently wound display
mesh through preview, commit, Undo/Redo, fresh JSON history replay and STEP
export/reimport. The fit-within-modeling-tolerance advisory remains explicit;
the missing-strip mesh advisory must not appear. The case is in the root CI
smoke selection (`test/cone-shoulder-fillet.test.ts`). This is headless adapter
qualification, not browser or production visual verification.
