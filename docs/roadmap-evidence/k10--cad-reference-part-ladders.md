---
row: K10
---

CAD part QA P1 on Remus 2026.1.159 runs 195 signed edits in the root Vitest
corpus. Part A, a synthetic truncated Cone primitive united with a box, has
an exact junction fillet and a second fillet on the 12 box edges and cone
rim. Its census is 30 faces (7 planes, 12 cylinders, 1 cone, 2 tori and 8
spheres). Comparison with the recorded part's census is pending. Readout
(exact local builds / typed refusals): A 11 / 50, B 25 / 6, C 50 / 25,
D 11 / 17. There are no unexplained monotonic violations. The conical
fillets on A limit direct edits even at 0.1 mm. On B, zero removes the
connected rounds, and the larger positive steps re-blend only the selected
corner. On C, zero removes the boss root fillet. The local resize refuses
at an outward root radius of 9.9 mm and an inward wall radius of 0.1 mm.
Both −11.9 mm shoulder moves build locally, while the source fillet
rebuild refuses with a 0.1 mm plate. On D, local radius edits cannot carry
both chamfers, and the independent source rebuild succeeds wherever the
radius leaves both chamfers intact. The cap translates with its chamfer,
with the volume delta measured against the full cylindrical section. These
findings and each literal refusal are pinned in `test/direct-edit-corpus/`.
The suite checks strict solid and mesh validity, shape oracles, cold replay,
refusal preservation and undo/redo. P0 awaits captures.
