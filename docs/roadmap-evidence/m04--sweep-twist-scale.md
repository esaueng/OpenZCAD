---
row: M04
---

Sweep twist and scale along the path, on the exact route (schema v132).

**Schema.** An in-place sweep stores `twistDeg`, the profile's total turn about the path in degrees, and `endScale`, its scale at the far end about the point where the path crosses it. Both are literals or expressions, linear in the distance travelled. A zero twist and a unit scale are never written, so every older sweep replays unchanged. The sampled sweep refuses both at entry, at edit and at rebuild.

**Kernel.** The kernel's `sweepExactWithOptions` builds them (Remus #1913, `exact_sweep::sweep_exact_with_options`) along a straight path with the profile square to it. A twist alone is the screw-fitted twisted extrusion. A scale is the new similar extrusion, where every control point rides the conical screw motion with its own offset from the path's line, so each section is the profile exactly scaled and turned. Without a twist the walls are exact planes, cones and ruled NURBS. With one they are certified fits, whose proven bound is recorded as the edge tolerance. Nothing is faceted.

**Refusals.** Each is by name, builds nothing, and is never sampled in its place: an arc or a corner in the path, a closed path, a profile tilted from square, a full circle off the path, and a trimmed spline, ellipse or conic in the profile.

**Sweep card.** On Exact, the card offers Twist and End scale, each on a chip beside the profile. An edit reopens them as stored, expressions and all, and setting them back to none clears them.

**Evidence.**

- `test/exact-sweep-twist-scale.test.ts`:
  - a scaled square as six planes at the Cavalieri volume A·L·(1 + σ + σ²)/3, which survives a STEP round trip;
  - a twisted, scaled circle as one cone;
  - a bar twisted by a typed expression;
  - the twist and scale cleared in an edit;
  - entry refusals;
  - the arc, corner and tilt refusals, in their plain sentences.
- `apps/web/src/lib/inPlace/edit.test.ts`: the reopen, clear and card cases.
- `test/e2e/exact-sweeps.spec.ts`: a picked straight sweep given a typed twist of 90° and an end scale of 0.5, rebuilt exactly at 16 × 20 × 1.75 / 3.

**Remaining.** Profile position, orientation (normal to path or parallel to profile), a round corner, splines in the path, a corner next to an arc and guide rails on the exact route; loft guide curves and connections.
