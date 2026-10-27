---
row: M05
---

Chamfer-preserving end offsets now support a proved local cap/cone/cylinder
band on a stepped imported solid. The pinned native arena retains the shoulder,
other end, rational control nets, circular trims, tolerances and boundary graph;
only the selected end translates and its adjacent cylindrical span changes.
Complete circular coverage accepts split rims. Conservative analytic and positive
rational-control-net bounds refuse unproved clearance, wall collapse, holes,
ambiguous correspondence and unsupported wall UV traces. No kernel pin, public
schema, tolerance or approximate fallback changes. Independently authored
regressions cover both ends, rotation/mirroring, shortening, native record
preservation, exact STEP export/reimport, repeated edits and fresh JSON replay
(`test/stepped-chamfered-cap-offset.test.ts`). Browser coverage exercises Total
77 to 182, preview/apply, fixed opposite end, undo/redo and save/reload alongside
the original simple-cylinder case (`test/e2e/chamfered-cylinder-offset.spec.ts`).
