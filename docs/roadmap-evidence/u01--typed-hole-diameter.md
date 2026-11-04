---
row: U01
---
Typed hole diameters are covered before Enter and after commit: shrink and
enlargement preserve the rebuilt 45-degree chamfer, the bore selection overlay,
and zero whole-body selection emissive. Entry beyond the old outer rim consumes
the chamfer cleanly while retaining the bore highlight; undo, redo and reload
retain the requested geometry (`through-hole-chamfer-resize.spec.ts`). Typed
entry uses the same radius preview and commit handlers as dragging.
