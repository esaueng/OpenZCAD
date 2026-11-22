---
row: K10
---

The CAD part QA P1 ladder runs 238 authored, signed edit cells in
[test/direct-edit-corpus/ladder.test.ts](test/direct-edit-corpus/ladder.test.ts).
Part A is a native cone primitive with two positive radii, unioned to a box.
It has a plane–cone junction fillet and a second fillet over all 13 remaining
sharp edges. Its synthetic census is 1 cone, 12 cylinders, 7 planes, 8 spheres
and 2 tori. Comparison with the recorded part's census awaits capture data.
P0 also awaits captures.

The pinned baseline is A 47 exact builds and 57 typed refusals, B 30 and 16,
C 41 and 19, D 22 and 6. No larger magnitude builds after a smaller refusal
in the same direction. Part A's local top offset and both plane–cone blend
resizes refuse even below the geometric limits. Three inward side and set
moves build at the calculated junction clearance, then refuse beyond it.
Part B refuses near the larger edge and corner radius limits. Its local edge
blend removal at radius zero builds and restores the sharp edge. In C the
boss radius can shrink to 4 mm in the sampled ladder, then refuses at 0.1 mm
because the root blend would be left behind. Both D caps build to within
0.1 mm of consuming the wall and refuse at the limit.

The suite checks kept geometry and history on refusal, literal user
sentences and typed classifications, exact undo/redo and command replay,
closed meshes, independent volume and source-route checks. The analytic
volume deltas cover the rounded box and tapered union's plate faces, the
boss cap and shoulder, and both chamfered caps. The four ladder tests took
25.53 seconds locally. Typed
coverage exposed gaps at a consumed chamfered-cylinder wall, non-positive
cylinder height and failed blend-cluster reconstruction. These now carry
classifications at the adapter boundary. The tapered cap still refuses
before reaching the apex check and now identifies the fillet that could
not be rebuilt.
