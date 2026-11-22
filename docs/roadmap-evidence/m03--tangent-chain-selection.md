---
row: M03
---

2026-11-22 tangent-edge chain selection.

The in-place Fillet and Chamfer bars offer "Add the tangent chain (N more edges)" once an edge is picked. It adds the smooth run through the last picked edge, in run order (`tangentChainAdditions` in `apps/web/src/lib/interaction/chamferChain.ts`). Edges already picked, seams and, for a chamfer, already-smooth boundaries are left out. The chain is offered, never applied for the user.

Each build stays on the exact route:

- A constant fillet along the top outline of a box with R5 corners (four lines and four arcs) builds exactly. It measures the closed form, (1 − π/4)·r² along the lines plus Pappus around each corner arc at the section centroid's inset (10 − 3π)/(3(4 − π))·r (`test/fillet-tangent-chain.test.ts`, to 1e-6).
- A variable radius along that chain is refused by type, because the arcs are curved spines.

Pick-and-drag browser spec `test/e2e/fillet-tangent-chain.spec.ts`. One top line is picked on the canvas, the chain is added (8 edges), and the radius arrow is dragged. The committed round has no warning, and its rebuild matches the closed form for the dragged radius.
