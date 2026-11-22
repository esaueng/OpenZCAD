---
row: M03
---

2026-11-22 further radius laws: interior radius stations (schema v152).

A variable-radius fillet can store `radiusStations`: interior radii at fractions along every selected edge, measured from where the edge was picked (its witness end 0). The fillet's law, Linear or Eased, runs between neighbouring stations. The kernel builds this exactly with its station law (esaueng/remus#1939): each piece is a cubic Hermite row, so the band is one exact Bézier piece per segment. Like per-vertex radii, stations record the way each edge ran when they were set (`edgeRuns`). An edge that runs the other way after an upstream change is refused by code (`fillet_vertex_radius_unmatched`), not built with its stations reversed. The pin before 2026.1.158 ignored the stations, so the field is exposed only on a pin that builds them.

The in-place Fillet tool offers Radius at: Along the edge. A Mid R arrow stands partway along the first picked edge, its position set by Mid at (%). A stored list of more stations reopens with a notice rather than being cut silently.

Tests:

- `test/variable-fillet-radius-stations.test.ts`: a 1 → 3 at 25 % → 2 round under both laws matches (1 − π/4)·L·∫r² by Gauss–Legendre; it also covers the refused lists and the v152 guard.
- Tool and edit tests in `apps/web/src/lib/inPlace/tools.test.ts` and `apps/web/src/lib/edgeModifierEdit.test.ts`.
- Pick-and-drag browser spec `test/e2e/variable-fillet-radius-stations.spec.ts`: the middle arrow is dragged on a picked edge, the saved station has the dragged radius, and an exact rebuild matches the closed form.
