---
row: K08
---

2026-11-08 the owner's original case resizes directly on Remus `d370889`
(2026.1.126): the R2-filleted boss on the sphere goes from r 6 to 7, 5, 6.3 and
12 as a local direct edit. The adapter now grants `resizeCylindricalFaceDetailed`
its `allowApproximate` permission. The kernel removes the seam band, resizes
the sharp wall and rolls the measured ball back on in one call. An exact
(torus) band still comes back exact or refuses; only the freeform band, which
was already a NURBS fit, is rebuilt approximately. The edit carries an advisory
that says so (owner decision 2026-11-06). Each result has one wall at the new
radius and one band, is closed and STEP-exportable, and matches the volume of
the source route (the Cylinder primitive resized, then filleted) to within
0.05 mm³ (`test/sphere-boss-seam-fillet-resize.test.ts`). A radius the ball no
longer rolls on (r 1) refuses and keeps the body.
