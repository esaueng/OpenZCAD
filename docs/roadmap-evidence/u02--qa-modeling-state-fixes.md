---
row: U02
---

Production QA fixes for modeling state. F002: Symmetric Extrude was always refused as "both symmetric and two-sided" because the form sent a zero back distance. The form now sends none, and the document validator (entry, edit, build) and the kernel guard apply one rule, `extrudeSidesConflict`, under which a zero back distance is the one-sided default. An edit switching to Symmetric zeroes a stored back distance. F009: a standard view request belongs to its project, so the next project opens with its own fit. F011: the Edit Sketch offer is withdrawn when the project changes. F018: a local duplicate stores the inherited save states this device holds, so the saves it counts can be restored. Tests: `test/two-sided-extrude.test.ts`, `ExtrudeCommand.test.tsx`, `extrudeDraft.test.ts`, `extrudeEditing.test.ts`, `duplicateSaveStates.test.ts`, `extrude-in-place.spec.ts`, `fit-view.spec.ts`, `modeling.spec.ts`.
