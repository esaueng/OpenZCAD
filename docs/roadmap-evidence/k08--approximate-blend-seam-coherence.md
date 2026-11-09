---
row: K08
---

An approximate fillet whose NURBS patches disagree with the seams between
them is refused instead of shipped. The pinned kernel returns the rim of an r6
cylinder unioned onto a box corner, filleted at r >= 3, as an `ok`, valid,
in-envelope four-patch blend whose seams and top face are straight chords
(1.11 off both patches at r3.8). Fillet acceptance now projects every seam
shared only by the blend's approximate faces onto those faces' surfaces and
refuses one more than 1% of the radius off. The refusal runs the existing size
ladder ("radius 2.5 builds here"); exact results and display-only drag frames
skip the measurement. Coverage: `blend-edge-coherence.test.ts` and
`test/corner-cylinder-rim-fillet.test.ts` (r2.9 builds the exact torus; r3.8 is
refused, or once the kernel builds the rim correctly has no straight edge in the
blend and a round top). Patch-to-exact-face chord boundaries on the accepted
mixed-seam and union-junction corner fillets are left to the kernel fix.
