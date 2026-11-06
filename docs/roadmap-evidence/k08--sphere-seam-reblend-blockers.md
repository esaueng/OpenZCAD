---
row: K08
---

2026-11-05 WS6 ladder on the owner's original case, a direct resize of the
boss on the sphere with an R2 seam fillet: measured blocked on Remus
`669d1e2`, so it refuses with the typed cause and keeps the body. The edit
refuses `direct-edit/unsupported/unsupported_move_face`
(`unsupported_neighbor`, `nurbs`) in about 1.1 s for r 6→7 and 6→5. The seam
fillet rebuilds in 4.7 s, not minutes. No ladder step exists on this pin:
the off-axis cylinder/sphere band has no exact form (`filletDetailed`
exact-only gives `exact_only_unattainable`; the default build is one
approximate walking NURBS face). `getBlendRegion`, `resizeBlend(…, 0)` and
`removeBlendsJournaled` refuse a NURBS band, and `defeature` caps only planar
wound neighbours. Even the coaxial boss's exact torus band refuses removal
(`unsupported analytic support pair: cylinder x sphere`). Tripwires pin each
step, so a pin that adds one fails and names it
(`test/sphere-boss-seam-fillet-resize.test.ts`). The K10 matrix excludes
sphere×cylinder `fillet-seam`, so no ledger cell changes.
