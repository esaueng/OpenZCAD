---
row: F04
---

STL files up to 500,000 triangles and 128 MiB parse in a cancellable worker.
Above 200,000 triangles, the imported mesh replays directly as a stored
mesh reference and keeps its source facets for binary STL export. The
viewport draws large references from their facet buffers, with facet
wireframe available on demand. The 3MF, OBJ, GLB and PLY limits remain
at 200,000 triangles. Parser and replay
boundary checks live in `test/io.test.ts` and `test/mesh-reference.test.ts`.
The web payload suite covers refusal when browser storage fails and backup
restore with 500,000 triangles. `stl-mesh-compat.spec.ts` covers the large
file picker, undo, redo, reload and binary export flow.
