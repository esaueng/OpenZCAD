---
row: M03
---

Remus 2026.1.117 covers straight ridges between rational spline
extrusion walls and monotone curved spline rims with normal planar ends.
`test/e2e/chamfer-freeform.spec.ts` selects both kinds on a genuine imported
cubic spline prism and checks preview/commit, Undo/Redo and saved replay with
the full renderer. The paired kernel retains source carriers and adds
whole-interval contact and parameter certificates; it also preserves distant
bores and refuses exhausted or intersecting requests transactionally.
The paired kernel and translator packages are pinned to immutable source
`6ec69d97fe052e407a1ce0ac99fe913508540ba3` from
[Remus #1519](https://github.com/esaueng/remus/pull/1519). Before the update,
both browser cases retained six faces after the chamfer preview; the new
package produces seven faces. The regressions also export STEP through the
File menu, reimport the download, and require one valid seven-face solid with
its spline surfaces retained.

Native kernel coverage includes quadratic and multispan profiles, concave
supports, rational weights, transformed and scaled models, asymmetric
setbacks, both rims, all longitudinal edges, and distant/intersecting bores.
An independent solid comparison found no material difference for seven
synthetic cases. Normal-offset checks and a converged section integral also
qualify the curved rim independently of spline mass-property quadrature.

Arbitrary doubly curved supports, closed spline rims, non-normal ends,
unequal endpoint weight gauges and general interacting freeform corners
remain unqualified. M03 remains Partial; this evidence qualifies only the
two support families described above.
