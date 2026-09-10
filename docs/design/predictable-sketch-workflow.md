# Predictable sketch workflow

This milestone makes existing sketch capabilities visible and gives editing a consistent path from feature history back to the viewport.

- The sketch overview shows the active plane and tool, geometry/grid snapping switches, live closed-profile counts, and actionable profile diagnostics. Valid closed regions remain extrudable even when unrelated geometry is open.
- The geometry selector opens the existing dimension editor without requiring a precise canvas pick. Driving radius constraints can also be edited from the selected entity's constraint list.
- Entity edits solve existing constraints before committing. If the solver would replace a value the user entered, the edit is refused with an explanation. The user can edit the driving constraint instead.
- Entity edits, driving dimensions, and manual solves check affected downstream exact geometry before committing. A failed rebuild leaves the committed document unchanged. Results from an outdated document or a closed sketch session cannot commit.
- Editor values refresh after undo and redo. Solve status belongs to the document version it describes, and diagnostic markers clear when the document changes.
- Ordinary and attached sketches expose the viewport editing action in the feature inspector. Finish Sketch clears the editing tool and temporary diagnostic state while preserving completed geometry.

## Acceptance evidence

Browser coverage draws and dimensions a rectangle, edits its width, undoes/redoes the change, extrudes it, re-enters through history, edits the source geometry, and finishes the sketch. Existing snapping, radius-expression, and transient-overlay tests cover the adjacent interactions. Exact-kernel tests verify changed solid volume, undo, refusal of an invalid downstream rebuild, and edits controlled by a radius constraint.

## Scope

This builds on the unified Extrude workflow. It retains the existing kernel, sketch solver, snapping algorithms, units, and geometric tolerances. It does not introduce new modeling operations or a new sketch solver. Other edit paths, such as legacy feature forms and general parameter changes, retain their existing validation behavior; this is not a claim that every document mutation has exact preflight.
