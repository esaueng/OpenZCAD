---
row: M03
---

2026-11-22 per-vertex radius controls (schema v142).

A variable-radius fillet can store `vertexRadii`: the radius at each end of each selected edge. Each entry names its end by the edge's lineage witness endpoint, so the end is the one where the edge was picked, whatever direction the kernel builds the edge in. The adapter compares the resolved edge's direction with its witness. An edge that now runs across the direction it was picked in is refused by name (`fillet_vertex_radius_unmatched`). A pattern refuses to repeat a per-vertex fillet. The kernel builds the result exactly, within the qualified straight-edge, planar-support family; anything else stays a typed refusal.

The in-place Fillet tool offers Radius at: Each corner under Linear or Eased. Each distinct corner of the picked edges gets its own arrow and value (R1…R8); two picked edges that share a corner share its radius. Reopening a fillet from History restores the corners.

Tests:

- `test/variable-fillet-vertex-radii.test.ts`, through the document path on a 60 × 40 × 20 box:
  - corners 1/3 and 3/1 build;
  - each end cap loses exactly (1 − π/4)·r² at the radius set at that end;
  - the volume matches the closed form;
  - malformed lists are refused;
  - the v142 guard;
  - an edit back to a constant radius drops the corners.
- Tool, edit and summary tests in `apps/web/src/lib/inPlace/tools.test.ts`, `edit.test.ts` and `edgeModifierEdit.test.ts`.
- Pick-and-drag browser spec `test/e2e/variable-fillet-vertex-radii.spec.ts`. An edge is picked on the canvas and Linear and Each corner are chosen. One corner's arrow is dragged, and the other corner keeps its radius. The exported fillet stores the dragged radius at that end, and an exact rebuild matches (1 − π/4)·L·(r0² + r0·r1 + r1²)/3.
