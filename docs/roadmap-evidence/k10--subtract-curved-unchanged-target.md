---
row: K10
---

#1242 closed on the `2026.1.171` pin (2026-11-27): revolve/sweep and
sweep/sweep cut to OCCT's volumes and exclude the witness; revolve/trimmed
NURBS and sweep/loft refuse `exact_only_unattainable` before consuming
either input. `test/subtract-unchanged-target.test.ts` pins the defect
itself independently of the pin: with the kernel's cut made to return the
target unchanged, all four recipes refuse on commit and reload, with the
overlap measured (removed-volume gate) and unmeasured
(`cut_kept_tool_material`), keep the tool visible, export both sources and
Undo cleanly; `test/subtract-classifier-blind.test.ts` now blinds the point
classifier for all four. `test/subtract-curved-operands.test.ts` also pins
`classifyPoint` and `classifyPointRobust` on the OCCT witness. The STEP
exports were checked by OCCT 8.0.1 (`check_exports.py` beside the fixtures,
run by hand, not in CI): both cuts are valid solids matching OCCT's own cut
in volume, centre of mass, inertia and point classification, and both
refusals export the two sources unchanged.
