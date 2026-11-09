---
row: K06
---
Spline self-seams use `RemusKernel.getSolidSmoothEdges` as their sole G1
authority: a `bspline`/`nurbs` edge owned at least twice by one face becomes a
display seam only with an affirmative verdict. Body topology, drawing
tessellation and section picking share the rule; analytic/sphere rules and
topology hashes, witnesses and fingerprints are unchanged. Regression evidence:
`test/spline-self-seam.test.ts` is in the CI smoke selection and covers smooth,
non-smooth and unreported stub verdicts, an actual single-wall spline extrusion
under the current pin, and a simulated future kernel verdict through body/drawing
publication. The current
pin's `getSolidSmoothEdges` deliberately omits self-owned edges, so the real
regression pins that edge as a feature and must flip on adoption. This is the
OpenZCAD half of the in-place coil part-line fix: Remus #1623 must both create
one spline side face and report G1 self-seams through that API, then arrive via
the automated paired Remus pin bump. Coil-line removal is not yet verified.
