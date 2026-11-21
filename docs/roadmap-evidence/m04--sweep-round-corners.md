---
row: M04
---

Round corners, and corners next to an arc, on the exact route (schema v135). An in-place sweep stores `cornerRadius`. Each corner of the path is replaced by the arc of that radius tangent to both sides, through the kernel's `sweepExactWithOptions` (Remus #1916). That covers a corner between straight runs, and one beside an arc in the corner's plane. The arc's centre is where the two sides, offset by the radius, meet: lines, a line and a circle, or two circles. The profile then turns about the fillet's axis as exact tori and cylinders. A mitre next to an arc stays refused, because its two bodies do not meet on a plane; a round corner takes it instead.

Refused by name:

- a radius that does not fit, or lies inside the profile;
- a corner out of the arc's plane;
- round corners with a twist, scale, rail or parallel orientation.

The Sweep card offers Corners (Mitre / Round) with a corner radius on Exact.

Evidence:

- `test/exact-sweep-round-corners.test.ts`: a tube rounded through one torus band, at Pappus; a line meeting an arc square, rounded at its closed-form centre line; the refusals.
- `test/e2e/exact-sweeps.spec.ts`: a picked L path given a typed radius-5 corner, rebuilt as two cylinders and a torus at π·(30 + 5π/2).
