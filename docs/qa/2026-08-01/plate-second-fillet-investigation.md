# Fillet fails on a plate with holes — "Try a smaller radius" is wrong

**Date:** 2026-08-01
**Symptom:** On the workspace plate `test5` (80 × 60 × 6 mm, four ⌀4.5 holes
inset 10 mm, one R2 fillet already applied), adding a second Fillet feature on
Edge 11 with radius 2 fails with:

> Fillet could not be created on 1 selected edge with radius 2. Try a smaller
> radius. Edges that end on an existing fillet or chamfer usually cannot be
> rounded afterwards — edit that earlier feature and add this edge to it
> instead.

**Verdict:** kernel limitation in BrepKit, misreported by the app. The radius
is irrelevant — the same failure occurs at R1 and R0.5 — and **both remedies
the error message offers are wrong for this body**:

- "Try a smaller radius" cannot help: the failing fillet classes fail at every
  radius.
- "Edit that earlier feature and add this edge to it" also fails: a single
  fillet feature selecting the same two edges on the pre-fillet body fails
  with the identical message ("…on 2 selected edges…").

The failure has nothing to do with the existing fillet either. The trigger is
that the body is a **boolean-subtract result** (it has holes). On such a body
the pinned BrepKit kernel can only fillet **one isolated straight edge per
feature**; corner chains (edges sharing a vertex), the top perimeter, and hole
rims all fail at any radius. The model in the screenshot was reproduced
exactly — the first fillet's volume matches the measurement panel to the
micro-mm³ (28 349.748 mm³).

Reproduction artifact in this directory:

- `probe-plate-fillet.mjs` — standalone Node probe against the pinned
  `brepkit-wasm` package (no app needed). Output on `e21f167`:

```
=== plate without holes (12 edges) ===
  single 80mm top edge    r=2: OK -> new solid 1
  corner 80mm+60mm pair   r=2: OK -> new solid 2
  corner 80mm+60mm pair   r=0.5: OK -> new solid 3
  top perimeter (4 edges) r=2: OK -> new solid 4

=== plate WITH one hole (15 edges) ===
  single 80mm top edge    r=2: OK -> new solid 10
  corner 80mm+60mm pair   r=2: NO-OP (all engines failed, input returned)
  corner 80mm+60mm pair   r=0.5: NO-OP (all engines failed, input returned)
  hole rim (circle)       r=2: NO-OP (all engines failed, input returned)
  hole rim (circle)       r=1: NO-OP (all engines failed, input returned)
  hole rim (circle)       r=0.5: NO-OP (all engines failed, input returned)
  top perimeter (4 edges) r=2: NO-OP (all engines failed, input returned)

=== second fillet on the already-filleted plate (first fillet OK) ===
  single-edge R2 attempts on all 18 edges: 1 OK, 17 NO-OP
```

## How the failure is produced

The feature path is `packages/kernel-adapter/src/exact.ts` (fillet case,
≈ line 2961): resolve the selected edge hashes, call
`kernel.fillet(target, edges, radius)`, and treat "returned the input handle"
as failure, producing the quoted message (≈ line 2999).

`kernel.fillet` lands in BrepKit's `try_fillet`
(`crates/wasm/src/helpers.rs`), which tries three engines in order and
accepts the first result whose outer shell is a closed 2-manifold:

1. `blend_ops::fillet_v2` — planar fast path, then the walking builder,
2. `fillet::fillet_rolling_ball` — v1 rolling-ball,
3. `fillet::fillet` — legacy planar.

If all three fail, **the input handle is returned with no error** — the typed
engine errors are discarded. Running the engines natively against the plate
(box − cylinder via `boolean(Cut)`) shows exactly why each one fails:

| Case on holed plate | fillet_v2 | rolling_ball | v1 |
| --- | --- | --- | --- |
| single 80 mm edge | ✅ walking builder succeeds | open shell (free edges) → rejected | open shell → rejected |
| corner 80+60 pair (any R) | `unsupported vertex blend at Id(16): 2 stripes meet` | open shell → rejected | open shell → rejected |
| hole rim R1 | `trimming failure on face Id(14)` (the holed top plane) | "closed circular edges are not supported by the rolling-ball engine" | "failed to compute fillet data" |

On the plain 80 × 60 × 6 box every case succeeds because `fillet_v2`'s
**planar fast path** (the rolling-ball rebuild with the corner patches from
esaueng/brepkit#34) handles simple prisms. That fast path is documented to
emit an open shell on "richer topology (L-shaped side faces, coplanar
slivers, **holed caps**)" (`crates/operations/src/blend_ops.rs` ≈ line 339)
and falls through to the **walking builder**, which:

- handles a single stripe on the holed plate (why the user's first fillet
  worked, and why exactly one more 80 mm edge still works afterwards),
- fails fast on any vertex where ≥ 2 stripes meet
  (`BlendError::UnsupportedVertexBlend`, `crates/blend/src/lib.rs` ≈ line 82:
  stripes are not set back and corner faces share no boundary edges with
  them, so the shell can never close),
- cannot trim a face with an inner loop for a closed-rim blend
  (`TrimmingFailure` on the holed top plane).

The adapter's own analytic fallback `tryExactAnalyticCylinderRimFillet`
(`packages/kernel-adapter/src/exact.ts` ≈ line 385) is deliberately narrow —
it only rebuilds the two cap rims of a free-standing three-face cylinder — so
it never engages for a hole rim embedded in a plate.

## Why the message is misleading

The message text assumes the two failure modes the sequential-fillet test
pins (`test/exact-kernel-adapter.test.ts`, "fillets an edge of an
already-filleted body"): oversized radius, or blend-on-blend. Neither applies
here. Because `try_fillet` returns the input handle instead of an error, the
adapter cannot distinguish:

- radius genuinely too large (message correct),
- unsupported vertex blend on a boolean body (message wrong on both counts),
- unsupported hole-rim blend (message wrong on both counts).

## User impact

On any body produced by a boolean (i.e. every plate with holes — a bread-and-
butter CAD part), fillets are limited to one straight edge per feature, and
after one fillet nearly every other edge stops being filletable
(17 of 18 in the probe). Hole rims can never be filleted or chamfered. The
error message then steers the user into two dead ends.

## Recommended fixes

**Status:** recommendation 3 (cause-aware failure message) is implemented in
this PR — see `edgeModifierFailureMessage` in
`packages/kernel-adapter/src/exact.ts`. Recommendations 1, 2, and 4 are
planned in detail in `kernel-fillet-plan.md` alongside this report.

1. **Upstream (BrepKit), the real fix:** teach the walking builder's
   watertight assembly to set stripes back and share corner boundary edges so
   multi-stripe vertices build on non-prism topology; support closed concave
   rims by trimming faces with inner loops (the hole-rim case is analytically
   a quarter-torus band, same spirit as the existing analytic rim assembler
   for convex cylinder rims).
2. **Kernel bridge:** stop collapsing all-engine failure into the silent
   input-handle return. `try_chamfer` already returns the v2 error for
   exactly this reason (see its doc comment: "the no-op trap"); `try_fillet`
   should do the same, or expose the last typed error so the adapter can
   report the actual cause.
3. **Adapter/UX (short-term):** with a typed cause available, split the
   failure message: only suggest a smaller radius for `RadiusTooLarge`; for
   `UnsupportedVertexBlend` say corner blends on this body aren't supported
   yet and suggest filleting edges in separate features where possible; for
   hole rims say rim blends aren't supported yet. Until then, at minimum drop
   the "edit that earlier feature and add this edge to it" hint when the
   target body is a boolean result, because that path fails identically.
4. **Optional adapter fallback:** extend the exact analytic special-case to
   hole rims (plane + cylinder → torus band with a re-holed cap), mirroring
   `tryExactAnalyticCylinderRimFillet`, which would immediately unblock the
   most common request on this part class.
