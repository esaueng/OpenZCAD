---
row: M04
---

Sweep orientation and splines in the path, on the exact route (schema v134). An in-place sweep stores `orientation: 'parallel'`. The profile is then translated along the path, never turned, through the kernel's `sweepExactWithOptions` (Remus #1915). Every face is the exact translational surface of a profile edge along a path edge, with control points summed and weights multiplied.

- **Path curves:** a path may hold sketch splines, which join the exact path as one exact NURBS edge each, as well as lines and arcs.
- **Corners:** corners, including one next to an arc, crease the body instead of being mitred.
- **Self-clearance:** the path must run steadily away from the profile's plane, certified on its Bézier spans. A path that turns back, runs along the plane or closes is refused by name. So is a spline on a sweep that turns with its path, whose sentence points to Orientation: Parallel.
- **Card:** the Sweep card offers Orientation (Normal to path / Parallel) on Exact.

Evidence:

- `test/exact-sweep-orientation.test.ts`: a square kept parallel through a corner, at the area times its rise; a disc along a cubic spline, at π·4·20; the refusals.
- `apps/web/src/lib/inPlace/edit.test.ts`.
- `test/e2e/exact-sweeps.spec.ts`: a picked spline path swept parallel, rebuilt exactly.
