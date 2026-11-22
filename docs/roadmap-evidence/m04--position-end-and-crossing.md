---
row: M04
---

Profile position, on the exact route, now covers a path that ends on the profile's plane and also crosses it. Remus #1936 offers every point where the path meets the plane, its ends and the crossings inside an arc alike, and stands the profile at the one nearest it. OpenZCAD drops its `sweep-position:ambiguous-crossing` refusal: Auto and Path intersection build such a path, swept both ways from the profile.

Evidence:

- Remus `exact_sweep::position_tests`:
  - an arc ending on the plane anchors at its crossing by the profile, with the exact Pappus volume;
  - an end within tolerance of the plane does not hide that crossing;
  - two close crossings of a near-tangent arc both stay candidates.
- `test/exact-sweep-profile-position.test.ts`: a 210° arc that crosses the plane under a radius-1 disc and ends on the plane, exactly or a hair off it within the kernel tolerance. Auto and Path intersection each sweep the whole arc both ways from the disc, at volume π · 10 · angle.
- `test/e2e/exact-sweeps.spec.ts` "a picked arc that ends on the profile plane stands the profile at its crossing": the arc is picked on the canvas and Profile at → Crossing is chosen. It rebuilds with no warning at the 210° Pappus volume, passing under the disc and over the top.
