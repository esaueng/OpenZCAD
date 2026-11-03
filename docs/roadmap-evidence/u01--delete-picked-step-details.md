---
row: U01
---

Delete/Backspace on an imported STEP face appends an exact, replayable removal
instead of deleting its import. Through-holes close, planar chamfers heal, and
analytic fillet bands use zero-radius removal. Native history deletion retains
its existing behavior. Current topology, recorded geometry and exact rebuild
validation guard the edit; unsupported shapes leave the model and history
intact. STEP round-trip tests cover all three detail classes, valid solid and
volume checks, stale/ambiguous picks and command replay. Browser coverage imports
real STEP files, removes picked details, measures exported geometry and exercises
Undo/Redo, reload and refusal (`picked-step-feature-deletion.test.ts`,
`picked-step-feature-delete.spec.ts`). This does not qualify arbitrary freeform
or compound-hole defeaturing.
