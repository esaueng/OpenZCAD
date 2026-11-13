---
row: K01
---

Offset-circle loft (#1253) on the Remus 2026.1.135 pin: two parallel circles with laterally offset centres loft as two planes and one exact ruled B-spline wall between two exact circle rims in Ruled and Smooth, matching the closed-form volume (61,261.0567 mm³) and centroid to 1e-9 through preview, commit, reload and a STEP round trip; the coaxial control stays one cone (`test/loft-offset-circles.test.ts`). Lofts the pin still rebuilds from 32 chords — Smooth through three or more sections, coaxial circles included, and curved-to-straight or elliptical sections — are measured from body topology and disclosed in Diagnostics on the preview and the committed body, as faceted sweeps are (`apps/web/src/lib/loftFaceting.ts`, `test/e2e/loft-faceting.spec.ts`).
