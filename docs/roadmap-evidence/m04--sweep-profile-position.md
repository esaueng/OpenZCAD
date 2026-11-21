---
row: M04
---

Profile position on the exact route (schema v136). An in-place sweep stores `profilePosition`: `auto`, `intersection`, `closest-point` or `closest-endpoint`. It picks the anchor on the path where the profile stands, measured from the profile's area centroid, through the kernel's `sweepExactWithOptions` (Remus #1917). The profile never moves.

From inside the path, the sweep runs both ways. The profile is carried rigidly back to the path's start and swept forward, so the result is one exact body with no boolean. Absent keeps the previous rule: start from the path end nearer the profile's plane.

Refused by name:

- a crossing the path never makes;
- a profile standing on a mitred corner;
- a closed path;
- a position with a twist, scale, rail or parallel orientation.

The Sweep card offers "Profile at" (Path end, Auto, Crossing, Closest point, Closest end) on Exact.

Evidence:

- `test/exact-sweep-profile-position.test.ts`: both ways from the crossing over the whole path, with bounds on both sides; the closest end; the refusals.
- `test/e2e/exact-sweeps.spec.ts`: a path picked through the profile and swept both ways from the crossing.
