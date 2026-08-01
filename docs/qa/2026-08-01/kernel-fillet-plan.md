# Plan: lift BrepKit's fillet limitations on boolean-result bodies

Companion to `plate-second-fillet-investigation.md`. The investigation showed
that on any boolean-result solid (a plate with holes being the canonical
case) the pinned kernel can only fillet one isolated straight edge per
feature: corner chains fail (`UnsupportedVertexBlend`), closed hole rims fail
(`TrimmingFailure` / unsupported), and `try_fillet` hides every typed error
behind a silent input-handle return. The OpenZCAD adapter now diagnoses the
failure class heuristically (this PR); the real fixes live in
`esaueng/brepkit`. Phases are ordered by leverage; each is independently
shippable and pinnable.

## Phase 0 — surface typed errors across the wasm bridge (small)

**Where:** `crates/wasm/src/helpers.rs` (`try_fillet`),
`crates/wasm/src/bindings/operations.rs` (`fillet_solid`).

`try_chamfer` already returns the engine error instead of the no-op input
handle — its doc comment calls the alternative "the no-op trap". Do the same
for `try_fillet`:

1. Keep the three-engine cascade and the closed-shell gate, but remember the
   **first typed error from `fillet_v2`** (the engine with meaningful
   diagnostics) and return it when all engines fail, instead of `Ok(solid_id)`.
2. In `fillet_solid`, drop the planar-edge filter retry's silent
   `solid_id` fallback the same way; map `BlendError` variants to a stable,
   machine-readable prefix in the `JsError` message (e.g.
   `unsupported-vertex-blend:`, `trimming-failure:`, `radius-too-large:max=…`)
   so the adapter can switch on the cause instead of string-matching prose.
3. OpenZCAD adapter follow-up: `packages/kernel-adapter/src/exact.ts` already
   treats "returned the input handle" and "threw" identically, so this is
   compatible; replace the topology heuristics in
   `edgeModifierFailureMessage` with the typed cause once the pin is bumped.

Effort: ~1 day incl. tests. No geometry work.

## Phase 1 — corner chains on holed/boolean bodies (the screenshot case)

Two routes; do (a) first, keep (b) as the durable end-state.

### (a) Teach the planar fast path about holed caps (quick win)

**Where:** `crates/operations/src/blend_ops.rs` (`planar_fillet_result` and
the rolling-ball rebuild it drives), `crates/blend/src/fillet_builder.rs`
(≈ line 971 — "The cap's holes survive the rebuild unchanged, which is only
correct if …").

The fast path already closes multi-edge corner patches on plain prisms (that
is why the plain 80 × 60 × 6 box passes every case). On a holed cap it emits
an open shell because the rebuilt cap wires drop or mishandle inner loops.
Fix: when rebuilding a trimmed cap, carry every inner loop that does not
intersect the blend setback region verbatim, and split/retrim the ones that
do; then let the existing closed-shell gate accept the result. This
immediately gives plates-with-holes the full prism feature set (corner
pairs, whole top perimeter) as long as the fillet does not run into a hole.

Validation: native tests plate = box − cylinder with (i) corner pair,
(ii) full perimeter, (iii) fillet radius that tangentially grazes a hole
(must fail with `RadiusTooLarge`-class error, not an open shell).

Effort: ~2–4 days.

### (b) Vertex blends in the walking builder's watertight assembly

**Where:** `crates/blend/src/walker.rs`, `corner.rs`, `trimmer.rs`,
`fillet_builder.rs`; the fail-fast is `BlendError::UnsupportedVertexBlend`
(`crates/blend/src/lib.rs` ≈ line 82).

The exact corner geometry already exists (esaueng/brepkit#34 derives the
vertex-blend ball from face-plane tangency). What is missing, per the error's
own doc comment, is assembly: stripes are not set back at the shared vertex
and corner faces share no boundary edges with them, so the shell cannot
close. Plan:

1. At each multi-stripe vertex, trim every incident stripe back to its
   tangency circle on the corner ball (the set-back curves are the stripe
   section at the ball-contact parameter — already computable from the
   spine).
2. Emit the corner patch (`spherical_triangle.rs` for 3+, two-edge fill for
   2) **reusing the set-back boundary edges** instead of minting disconnected
   ones, so stripe ↔ corner adjacency is topological, not coincidental.
3. Extend the trimmer so the base faces around the vertex consume the corner
   patch's third boundary (the arc lying in each base face) when their wires
   are rewritten.
4. Delete the fail-fast once the assembly closes, and let the closed-shell
   gate arbitrate.

This removes the prism-only restriction entirely (works after imports,
booleans, prior fillets). Effort: ~1–2 weeks; highest-value kernel work.

## Phase 2 — closed rims (hole edges)

**Where:** `crates/blend/src/analytic.rs` / `analytic/` (the exact rim
assembler that already passes `fillet_cylinder_closed_rim_is_valid`),
`trimmer.rs` for faces with inner loops.

The convex standalone-cylinder rim works; the hole rim differs in two ways:
the plane's rim is an **inner** loop, and the blend is concave (torus band
curving into the material). Plan:

1. Generalize the analytic rim assembler to accept a rim whose plane-side
   loop is an inner wire: the setback replaces that inner circle with a
   larger one (radius `r_hole + r_fillet` for a concave blend) instead of
   shrinking an outer boundary.
2. Flip the torus band's curvature sign/orientation for the concave case and
   keep the cylinder-side setback (`z = r_fillet` up the bore wall) as in the
   convex path.
3. Reject with `RadiusTooLarge` when the grown setback circle would cross the
   face's outer wire or another inner loop (measure with the existing 2D
   loop-distance utilities).
4. Same assembly for chamfer (`chamfer_builder.rs` already has the annular
   rim port for convex rims).

Validation: hole rim R0.5/R1/R2 on the plate (volume = analytic torus-segment
subtraction), chamfered counterbore, rim tangent to a nearby hole must fail
typed. Effort: ~3–5 days.

## Phase 3 — rollout into OpenZCAD

1. Land native regression tests in `crates/operations/tests/` mirroring the
   probe (`docs/qa/2026-08-01/probe-plate-fillet.mjs` documents the exact
   failing matrix).
2. Rebuild `crates/wasm/pkg`, bump the `brepkit-wasm` pin in `package.json`,
   refresh `pnpm-lock.yaml`.
3. Flip the OpenZCAD-side expectations: the sequential-fillet test's
   failure-count bounds tighten, and the new
   "names the real blocker" regression gains success branches for corner and
   rim cases (volume-checked against OCCT via the existing parity adapters).
4. Replace the adapter's heuristic diagnosis with the Phase 0 typed causes
   and drop the interim wording.

## Interim option (adapter-only, no kernel change)

If hole-rim fillets are needed before Phase 2: extend
`tryExactAnalyticCylinderRimFillet` (`packages/kernel-adapter/src/exact.ts`)
with a hole-rim variant — detect a selected closed circular edge whose faces
are one plane (rim as inner loop) and one cylinder bore, then rebuild by
subtracting a revolved quarter-torus profile from the body, mirroring how the
coaxial-cylinder cut is special-cased today. Narrow, exact, and disposable
once the kernel path lands.
