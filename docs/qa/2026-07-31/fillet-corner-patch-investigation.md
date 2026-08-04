# Fillet corner patches look pinched/bulged — investigation and resolution plan

**Date:** 2026-07-31
**Symptom:** "Add fillet to all edges" on a box (reported on a 30 × 18 × 24 mm box,
`fillet_r = 2`) renders every corner as a lumpy blob with a visible pinch/lip
instead of a smooth spherical corner. Screenshot from the workspace shows the
defect at all visible corners; `warnings 0`, body reports valid.

**Verdict:** kernel geometry defect, not a viewport/rendering bug. The vertex
blend (corner) patch that BrepKit's rolling-ball fillet engine emits is an
approximate NURBS patch that sags up to **5 % of the fillet radius below the
true corner sphere**, breaks tangency with the adjacent fillet cylinders
(measured fold of **up to 105.8°** across the shared boundary), and locally
**folds over** (7 inverted triangles per corner in the display mesh). The
viewport renders that geometry faithfully — which is exactly why it looks
wrong.

Reproduction artifacts in this directory:

- `probe-fillet-corner.mjs` — standalone Node probe against the pinned
  `brepkit-wasm` package (no app needed): builds the box, fillets all 12
  edges, tessellates at display quality, and prints the per-face stats and
  fold measurements quoted below.
- `fillet-corner-artifact-repro.png` — offline software render of the kernel's
  actual display mesh using the viewport's own smoothing rule (smooth within a
  B-rep face only). It reproduces the screenshot's corner blob exactly, from
  geometry alone — no Three.js involved.

## How the defective geometry is produced

OpenZCAD's fillet feature calls `kernel.fillet(target, edges, radius)`
(`packages/kernel-adapter/src/exact.ts`), which lands in BrepKit's
`try_fillet` (`crates/wasm/src/helpers.rs`). That helper tries three engines
in order and accepts the first whose result is a closed 2-manifold shell:

1. `blend_ops::fillet_v2` — the walking-blend engine (`crates/blend`),
2. `fillet::fillet_rolling_ball` — the v1 rolling-ball engine
   (`crates/operations/src/fillet/rolling_ball.rs`),
3. `fillet::fillet` — the legacy engine.

For the all-edges box case the accepted result comes from
**`fillet_rolling_ball`** (evidence below). Its output is topologically sound:
26 faces (6 trimmed planes + 12 cylinder stripes + 8 corner patches),
watertight (`meshQuality`: 0 boundary edges, Euler characteristic 2), exact
bounding box, and correct stripe setback at every corner. The defect is
confined to the **corner patch surface** built in "Phase 5b"
(`rolling_ball.rs` ≈ lines 1782–1958):

- The three boundary arcs of each corner patch are correct — they are the
  quarter-circle end sections of the three fillet cylinders, which for a box
  corner are great circles of the true corner sphere (radius R, center offset
  R along each face normal). The seams are therefore watertight.
- The **interior surface is not a sphere**. It is a degree-(2,2) rational
  NURBS patch with one collapsed control column (a degenerate corner) whose
  interior "apex" control point is placed heuristically at
  `center + R·Σdirᵢ` (overshoot √3) with weight `w₀₁·w₁₂·w₂₀`. The source
  comment says the blend "tracks the sphere within a few percent of R" — and
  it does, but a few percent is far outside display tolerance and, worse, the
  patch violates G1 at its boundary.

## Measured defect (pinned `brepkit-wasm` 2.129.0, commit `c5dc0dc`)

Probe: box 30 × 18 × 24, fillet R = 2 on all 12 edges, tessellated with the
app's display parameters (`linearDeflection = 0.006`, `angular = 0.06` from
`displayTessellationForExtents`). Corner patch examined at the origin corner
(true sphere: center (2,2,2), radius 2):

| Measurement | Value | Expected |
| --- | --- | --- |
| Radial distance of patch vertices from (2,2,2) | 1.9008 … 2.0000 | 2.0000 |
| Mid-patch sag | −5.0 % of R (−0.10 mm) | 0 |
| Worst dihedral across patch↔cylinder boundary | **105.8°** (also 95.9°, 63.3°) | ~0° (G1) |
| Inverted (folded-over) triangles in the patch | 7 of 249 | 0 |
| Solid volume | 12 706.10 mm³ | 12 723.49 mm³ (closed form) |
| Protrusion outside the box planes | 0 (exact) | 0 |

The sag ratio 0.9504·R matches the analytic value of the heuristic patch
construction evaluated at (u,v) = (½,½) (0.9511·R), which pins the accepted
engine to the rolling-ball Phase 5b code path.

Why nothing upstream catches it:

- `try_fillet` validates **topology only** (`validate_shell_closed`); surface
  deviation inside a face is never measured.
- OpenZCAD's post-fillet guard ("Fillet expanded beyond the target body
  bounds", `exact.ts`) passes because the patch only sags inward.
- BrepKit's own unit tests codify the approximation instead of catching it:
  `crates/blend/src/spherical_triangle.rs` asserts surface points within
  **15 % of R**, and the rolling-ball comment budgets "a few percent".

Why it looks like a bulging blob rather than a subtle dent: the patch meets
the mathematically exact cylinders at a crease (the viewport correctly does
not smooth normals across B-rep faces), and the fold near the patch's
degenerate corner flips shading locally — grazing light turns the sagging
patch + crease ring + fold lip into a highlighted lump at every corner.
`fillet-corner-artifact-repro.png` shows the reproduction.

## Secondary finding: the v2 walking engine's corner solver is worse

`crates/blend/src/corner.rs` + `spherical_triangle.rs` (used by `fillet_v2`,
which runs **first**) build the vertex blend without setting the stripes back
from the vertex. The stripe end sections then sit on the vertex plane, so
`compute_sphere_center` derives a corner sphere of radius **√2·R** (for an
orthogonal corner) that protrudes 0.41·R outside the body, bounded by arcs
that match nothing. Additionally its corner faces mint fresh vertices/edges
that are not shared with the stripe faces, so the shell always fails
`validate_shell_closed` — which is the only reason users see the rolling-ball
result instead of this one. The v2 corner path burns a full attempt +
rollback on every fillet and can never currently succeed at a multi-edge
vertex.

## Resolution plan

The fix belongs in BrepKit (`esaueng/brepkit`); OpenZCAD then just bumps its
pinned `brepkit-wasm`. No OpenZCAD viewport changes are needed — the renderer
is behaving correctly.

### Phase 1 — exact corner sphere in the rolling-ball engine (the shipped path)

`crates/operations/src/fillet/rolling_ball.rs`, Phase 5b:

1. Replace the heuristic degree-(2,2) apex patch for 3-edge corners with
   **exact geometry on the corner ball**. Preferred: emit the corner face on
   `FaceSurface::Sphere(SphericalSurface { center, radius })` — the surface
   type already exists with full evaluate/normal/tessellation support
   (`crates/operations/src/tessellate/nonplanar.rs`) — keeping the existing
   three boundary arcs (they are already exact and shared with the cylinder
   ends, so watertightness is preserved by construction). If the assembly
   path requires a NURBS surface, the orthogonal-corner alternative is the
   classical exact rational biquadratic octant (a 90° arc revolved 90°:
   control net from the arc's control polygon, weights `wᵢ·wⱼ` with
   `w = [1, √2⁄2, 1]`, pole column collapsed) — but the sphere surface also
   covers non-orthogonal planar corners, where the tangent ball is still an
   exact sphere of radius R.
2. Apply the same treatment to the 2-edge corner patch
   (`build_two_edge_corner_patch`) — its gap also lies on the vertex ball.
3. Acceptance criteria (add as unit tests in the same crate):
   - every sampled corner-patch point within `1e-9·R` of the ball,
   - dihedral across every patch↔stripe boundary below the angular
     tessellation tolerance (no visible crease),
   - zero inverted triangles in the tessellated corner region,
   - filleted-box volume equal to the closed-form value within 1e-6 relative.
4. Delete the tolerances that codified the bug (the 15 %-of-R assertion in
   `spherical_triangle.rs` tests; the "few percent" budget comment).

### Phase 2 — repair or fence the v2 walking-engine corner solver

`crates/blend/src/{corner,spherical_triangle,fillet_builder}.rs`:

1. Implement stripe setback at vertices where 2+ stripes meet (pull each
   stripe's spine/section back so end sections lie on the corner ball), then
   compute the ball from tangency (offset each contact-face plane by R)
   rather than from unset-back contact points — eliminating the √2·R bulge.
2. Share boundary vertices/edges between the corner faces and the stripe end
   sections so the assembled shell can actually pass
   `validate_shell_closed`.
3. Reuse the exact sphere-surface corner from Phase 1.
4. Until this lands, optionally short-circuit `fillet_v2` for edge sets whose
   chains meet at shared vertices, saving the guaranteed attempt + rollback.

### Phase 3 — ship to OpenZCAD

1. Rebuild `crates/wasm/pkg`, bump the `brepkit-wasm` pin in
   `packages/kernel-adapter/package.json` (`github:esaueng/brepkit#main`),
   refresh the lockfile.
2. Add an OpenZCAD kernel regression test (`test/exact-kernel-adapter.test.ts`
   or a parity scenario): fillet all edges of a 30 × 18 × 24 box at R = 2 and
   assert (a) display-mesh volume matches the closed form within 1e-6,
   (b) no cross-face dihedral above ~8° anywhere on the mesh (planes↔cylinders
   and cylinders↔corners are all G1 in this model), (c) no inverted triangles
   relative to the outward-facing orientation. These assertions fail against
   the current kernel and lock in the fix.
3. Visual check of the three demo documents (bracket / flange / heat sink),
   which all contain fillets.

### Explicitly not part of the fix

- Viewport normal smoothing (`packages/viewport/src/render/scene.ts`) — its
  per-B-rep-face smoothing is correct CAD behavior and would mask nothing
  once the surface is exact.
- OpenZCAD-side geometry workarounds (e.g. widening
  `tryExactAnalyticCylinderRimFillet`-style special cases to boxes) — the
  corner ball is core kernel geometry and every consumer (measurement, STEP
  export, direct-edit drags on fillets) benefits from the kernel fix.

## Repro commands

```bash
# From the OpenZCAD repo root (deps installed):
node docs/qa/2026-07-31/probe-fillet-corner.mjs
```

Key output against the original pin (`c5dc0dc`, bug present):

```text
corner face 24: tris=249 … radial dist min=1.9008 max=2.0000 (R=2)
worst cross-face dihedral near origin corner: 105.80 deg
```

## Resolution (2026-07-31)

Phase 1 landed in BrepKit as
[esaueng/brepkit#33](https://github.com/esaueng/brepkit/pull/33) (merged,
`6071fd6`): corner caps are now analytic `FaceSurface::Sphere` faces with
shared great-circle arc rim edges and a structured watertight cap
tessellation. The scope grew beyond the original plan — the cap boundary
edges had been straight Line chords in the topology, and two latent
tessellation defects (a CDT degenerate-triangle failure on near-collinear
UV boundary chains, and UV-rectangle over-coverage of trimmed sphere faces
in the single-face path) are fixed alongside.

This repo's `brepkit-wasm` pin moved `c5dc0dc → fcb5657` (the refreshed
package built from the merge). Probe output against the new pin:

```text
corner face 4: tris=2835 degenerateTris=0 radial dist min=2.0000 max=2.0000 (R=2),
  tris with normal pointing away-from-center=2835/2835
worst cross-face dihedral near origin corner: 3.72 deg
```

The corner surface is exactly on the ball, every triangle faces outward,
and the worst seam crease is within display tolerance.
`fillet-corner-fixed.png` is the same offline render as the repro image,
regenerated against the new kernel — the corner is smooth.

Still open from the plan: Phase 2 (the v2 walking engine's corner solver
still lacks stripe setback and is fenced only by the closed-shell check)
and the Phase 3 regression test in this repo once CI is unblocked.
