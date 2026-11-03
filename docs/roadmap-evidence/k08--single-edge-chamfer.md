---
row: K08
---

Paired Remus 2026.1.111 enables an exact isolated chamfer through earlier
convex cylindrical endpoint rounds, with orthogonal whole-body planar supports
and fail-closed neighborhood checks (Remus PR #1517). The 2.1 mm regression
checks independent section volume, undo/redo, cold replay, and STEP export;
the full-render browser regression selects the edge through the viewport,
applies the chamfer, reloads, and validates the downloaded solid. A separate
FreeCAD check confirms the exported volume and both cylindrical faces. This
qualifies the reproduced geometric pattern, not arbitrary blended bodies.
A single refused fillet or chamfer also no longer advises selecting fewer
edges. When smaller probes fail and topology cannot name a cause, the message
identifies the neighboring faces without claiming every size was ruled out
(`edge-modifier-fallback.test.ts`).
