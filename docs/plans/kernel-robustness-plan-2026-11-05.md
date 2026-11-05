# Kernel robustness plan: every edit succeeds or refuses usefully (2026-11-05)

> **Supporting record.** [The master roadmap](../../ROADMAP.md) owns priorities,
> dependencies and delivery status. This plan specifies the combination
> qualification program owned by [K10](../../ROADMAP.md#k10) and the consumer
> slices it feeds into K01, K03, K05, K07, K08, W04 and A01. Measurements below
> were taken on OpenZCAD `main` at `792a1312` with the paired Remus packages
> `2026.1.122` (immutable commit `a16ca673`).

## Goal

Simple models edit reliably; combinations do not. A boss on a sphere, a fillet
on a boolean seam, then a resize — each step can individually be "supported" and
the sequence still fails. The bar a full CAD program sets, and the bar this plan
adopts, is that **every edit on every combination ends in exactly one of two
states**:

1. **Exact success.** A valid closed solid, a watertight display mesh, volume
   agreement with an independent oracle, replay determinism, and every
   downstream reference still resolving.
2. **A specific, typed refusal with a working alternative.** The user is told
   what blocks the edit ("this wall meets a filleted sphere") and offered a route
   that works (edit the source dimension, remove the fillet first).

The generic sentence "The exact kernel could not build this result", an untyped
kernel error, and a wrong-but-valid result are all defects under this plan.

## The reproduction that started it

History: Sphere r 73.5 → place → Cylinder r 6, h 64.1 → Move → Move → Union →
Offset face (planar cap) → Fillet r 2 on the cylinder/sphere seam. Dragging the
diameter of the boss wall refuses with the generic sentence. The geometry is
the existing `test/support/sphere-cylinder-union.ts` history.

Reproduced headlessly through the same `directEditBody` operation the UI
builds. Every variant refuses deterministically on the first resize call:

| Variant                            | Ø12→Ø14 | Ø12→Ø10 | Kernel text (untyped)                                               |
| ---------------------------------- | ------- | ------- | ------------------------------------------------------------------- |
| Axis-aligned, Union only           | refused | refused | `move-face does not support face … (sphere): face is adjacent to …` |
| Axis-aligned, + planar cap offset  | refused | —       | same, `(sphere)`                                                    |
| Axis-aligned, + seam fillet        | refused | refused | same, `(nurbs)` — the fillet band becomes the blocking neighbour    |
| Union + offset + fillet (reported) | refused | refused | same, `(nurbs)`                                                     |
| Tilted 20°/10°, Union only         | refused | refused | same, `(sphere)`                                                    |
| Tilted, + offset + fillet          | refused | refused | same, `(nurbs)`                                                     |

Tilt and the cap offset are irrelevant. Refusals take 8–166 ms; nothing is
attempted geometrically.

### Root cause, layer by layer

1. **Routing (app).** `buildCylinderRadiusCommand` (`apps/web/src/App.tsx`)
   first asks `primitiveCylinderRadiusAncestor`
   (`apps/web/src/lib/interaction/cylinderPrimitiveAncestry.ts`) whether the
   wall traces to a Cylinder parameter. `primitiveChain` walks only fillet and
   chamfer results; any boolean stops a radius edit (box caps alone may cross
   one union). The wall still carries the lineage
   `boolean.face.operand.1.primitive.cylinder.face.wall`, but the edit falls
   through to a local `resize-cylindrical-face` direct edit.
2. **Kernel domain (Remus).** `resize_cylindrical_face` treats a wall as full
   turn only when two coaxial circles (or axial lines) bound it. A wall ending
   on a sphere intersection curve or a blend tangent curve is "partial" and goes
   to `replace_surface`, whose `validate_source_edges` accepts boundary
   neighbours that are planes, cylinders or axial cones only, otherwise raising
   `UnsupportedMoveFace` (`crates/offset/src/move_faces.rs` at the pin). The
   upstream capability matrix lists outward cylindrical walls, non-coaxial
   cylinders and non-analytic supports as Unqualified for direct edits.
3. **Refusal shape.** The kernel throws a bare `Error`. `exact-build-loop.ts`
   records it with no `kernelRefusal`; `refusalLanguage.ts` has no entry, and
   because the sentence starts lowercase `looksLikeKernelText` selects the
   generic sentence. The detail text is the only clue.
4. **Wasted retries.** `resizeCylindricalFaceExactly`
   (`packages/kernel-adapter/src/exact-direct-edit-ops.ts`) re-attempts through
   intermediate radii inside its 15 % sleeve band, although this refusal is
   independent of size.
5. **The parametric route is not a ready fallback.** Editing the upstream
   Cylinder radius to 7 or 5 and replaying failed in the same scratch harness
   at the fillet: `A selected edge no longer exists`. The harness used its own
   captured edge references, so this is a strong hint, not proof, that boolean
   seam edges lose identity across an upstream dimension change. The axis-aligned
   fillet also warns that its display mesh has gaps.
6. **The seam fillet is slow.** The r 2 fillet on the four sphere/cylinder
   seam edges took 3.5–14 minutes per rebuild in the reproduction, on a heavily
   loaded workstation. That is a budget and cancellation problem (K02, W01) as
   well as a capability one, and it is why the modifier cells stay out of the
   CI slice until they are fast.

### First matrix slice (M0, PR #1249)

The sphere × cylinder, no-modifier slice of WS1 runs in about 25 s. Of 16
cells, 8 qualify: every union and subtract build, off-axis and tilted, and
every source Cylinder radius edit after either boolean. The other 8, every
direct wall resize, refuse untyped. A blind bore cut into the sphere refuses
for a second reason: the kernel resizes a partial cylinder only on the
outside of a boss with radial planar sides. So, without a modifier, editing the
source shape and replaying works today. This is the route WS4 makes the
default, and the refusal sentences now point to it.

### Matrix results (widened campaign)

The generator now treats families and axes as data. It covers seven operand
pairs: sphere×cylinder, box×cylinder, cylinder×cylinder, box×cone, box×torus,
box×sphere and box×box. Placements are aligned, off-centre, tilted, tangent,
coincident or stacked face, sliver overlap, equal radius and raised, plus scales
1e-3 and 1e3. Booleans are union, subtract and intersect in both operand orders.
Modifiers are a seam or unrelated-edge fillet or chamfer, or a cap offset.
Follow-ups are a source grow or shrink, a direct resize, a direct offset, blend
removal, undo/redo, reopen and a STEP round trip. The volume oracles are
independent: closed forms, inclusion–exclusion with chord-integrated overlap,
and Pappus or prism sections for blends. Route equivalence compares direct and
source resizes, and blend removal with deleting the fillet. 1,392 cells run on
the `2026.1.122` pin: 42 in the CI slice (`test/combination-matrix.test.ts`)
and 1,350 in the full campaign (`test/combination-matrix.full.test.ts`, full
suite only).

| State           | Cells |
| --------------- | ----- |
| Qualified       | 725   |
| Typed refusal   | 399   |
| Untyped refusal | 216   |
| Wrong           | 94    |
| Timeout         | 0     |

Wrong cells, each a silent defect with a minimal history in the ledger:

1. **Box − half-embedded torus returns the box unchanged** (70 cells: every
   box×torus subtract, any placement, modifier or follow-up). The minimal
   history is a box 60×60×20 and a torus R 15 r 4 moved to (30, 30, 20),
   then subtract. The result is exactly 72000 mm³ against an oracle of
   69631.29 mm³, with no warning.
2. **Direct wall resize under a seam blend loses the blend volume** (8 cells:
   box×cylinder aligned and off-centre, seam fillet or chamfer, then a
   direct resize to r 7). After a union and an r 2 seam fillet, the body
   holds 75031.85 mm³. That is less than the unfilleted r 7 boss
   (75078.76 mm³); the oracle is 75118.93 mm³.
3. **Internally tangent cross drill** (3 cells: cylinder×cylinder
   off-centre subtract, then a source grow to r 7 so the drill touches the
   bar wall). The volume is 2.2 mm³ high against an exact 1D integral.
4. **Steinmetz (equal-radius) cross drill** (13 cells). The volume is off by
   0.071 mm³ (1.3e-5) against the exact 16r³/3, beyond the tolerance.

The largest untyped families are the cylinder×cylinder union (83 cells,
"open, non-manifold, or inconsistently oriented"). The next is the union
connectivity check (50 cells). It is right for tangent and stacked operands,
but it is also wrong for box×sphere raised and sliver unions, which overlap
yet are refused as "2 disconnected groups". Then come a seam fillet or chamfer
that loses its edges after a source edit (20 cells, WS5), a chamfer on a
concave boss seam (14 cells), the direct resize refusals of the first slice,
and a STEP reimport at the 1e3 scale that our own reader refuses (3 cells).
Every box×sphere boolean with the sphere centred on the face, and every
box×torus union and intersect, refuses typed (`exact_only_unattainable`).
Seam blends on a sphere stay excluded, because one rebuild took 3.5–14
minutes (root cause 6).

## Why combinations fail when primitives work

- **Narrow kernel qualification.** Remus fixes are deliberately bounded to the
  witness family (the 2026.1.122 sphere/cylinder fuse repair is explicitly "a
  bounded qualification, not a general spherical arrangement algorithm"). Each
  new pairing of surface types, rim shape and neighbour type is a new
  unqualified cell.
- **App routing and workarounds know boxes, cylinders and planes.**
  `faceOffsetPlan.ts` returns no parametric plan for non-planar faces;
  `cylinderPrimitiveAncestry.ts` recognizes box and cylinder face names only.
  At least eight adapter modules (`exact-cylinder-ops.ts`,
  `exact-chamfered-cylinder.ts`, `exact-local-chamfer-cap.ts`,
  `exact-chamfered-hole.ts`, `exact-pierce-tool.ts`, `exact-axial-extent.ts`,
  `exact-face-distance.ts`, `planar-emboss.ts`) handle planes, cylinders or
  cones and cannot generalize to spheres, tori or NURBS.
- **Edge identity through replay.** Boolean-generated edges have no stable
  name tied to the operand faces that produce them, so modifiers that reference
  them break when an upstream dimension moves.
- **No combinatorial coverage, no harvest.** Consumer tests are hand-authored:
  227 test files mention a box, 63 a cylinder, 15 a sphere, 5 a cone and one a
  torus. CI runs a smoke selection (146 root and 102 web files of roughly 650);
  `test/parity/parity.test.ts` and `test/direct-edit-corpus/` are not in it, and
  the direct-edit corpus holds no captured fixtures. Upstream, the Remus
  differential harness (P-Class 8.1) chains primitives and booleans, and the
  per-operation parity matrix (O1.5) applies one modifier to one primitive
  pair; neither runs boolean → blend → edit sequences. Opt-in analytics
  record a bare `error_feature` count, so production refusals never become
  regression cases.

## Workstreams

Each workstream names the roadmap row that owns its delivery status.

### WS1 — Combination qualification matrix (K10)

An app-level generator that executes real document histories against the
installed WASM packages through the production adapter.

**Axes.**

| Axis             | Values                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Operand families | box, cylinder, sphere, cone, torus, extrude, revolve; later imported STEP bodies                               |
| Placement        | disjoint, crossing, off-centre, tilted, tangent, coincident face, sliver overlap; scale 1e-3 / 1 / 1e3         |
| Boolean          | union, cut, intersect, both operand orders                                                                     |
| Modifier         | none, fillet, chamfer, shell, offset face, on seam edges and on unrelated edges                                |
| Follow-up edit   | upstream dimension change, direct resize, move face, remove blend, undo/redo, reopen, STEP export and reimport |

**Oracles per case.**

1. The outcome is exact success or a typed refusal (`kernelRefusal` present);
   an untyped error or the generic sentence fails the case.
2. Solid validation passes and the display mesh is closed and manifold.
3. Volume agrees with an independent oracle (closed form or
   inclusion–exclusion where available, otherwise exact-versus-mesh integral).
4. Replay from the command log reproduces the same volume and face census.
5. Every face and edge reference held by downstream features resolves, or the
   feature reports a typed re-pick refusal.
6. Route equivalence: a successful direct edit matches the body produced by
   editing the source dimension and replaying, within the documented tolerance.

**Output.** A committed cell ledger with one state per cell — Qualified,
Typed refusal, Untyped refusal, Wrong — using the vocabulary of the Remus
[capability matrix](https://github.com/esaueng/remus/blob/main/docs/kernel-maturity/capability-matrix.md).
Failing cases shrink (drop steps, round dimensions, collapse placements) to a
minimal history, which becomes a consumer pin in this repository and a Remus
reproduction bundle.

**Cadence.** A fixed-seed slice short enough for CI (target under five minutes)
joins the required unit job; the full campaign runs on a schedule on the
trusted runner and uploads the ledger as an artifact. A cell may move from
Qualified to anything else only with an explicit pin change in the same PR
(ratchet).

**First slice.** Sphere × cylinder, union and cut, none/seam-fillet/cap-offset,
followed by direct resize and upstream radius edit. Today's ledger for that
slice is expected to be mostly Untyped refusal; that is the baseline.

### WS2 — Honest failures (W04)

- Remus: return the replace-surface neighbour refusal as a typed `unsupported`
  failure carrying the capability cell and the offending neighbour surface type.
- Adapter: map it to a `kernelRefusal`; stop the intermediate-radius ladder for
  refusals that are not size dependent.
- Language: a plain-language entry for the neighbour refusal in
  `refusalLanguage.ts` that names the blocking neighbour and points at the
  alternative route when one exists.
- Guard: a regression that fails when a known kernel refusal reaches the
  generic sentence.

### WS3 — Harvest production refusals (A01, K03)

- An opt-in aggregate `kernel_refused` analytics event carrying operation family,
  refusal category, code, and the surface types of the target and its
  neighbours. No geometry, dimensions, names or project identifiers.
- "View details" gains an explicit, user-initiated export of a sanitized
  history-only reproduction bundle. Extend the existing
  `openzcad-direct-edit-fixture` format beyond its six operations to every
  feature build, booleans included.
- Triage the most frequent cells into WS1 seeds on a regular cadence.

### WS4 — Parametric-first edit routing (U02, K05)

When a picked face traces to a feature parameter (cylinder, sphere, cone or
torus radius, extrude distance, revolve angle), edit that parameter and replay,
across booleans and modifiers. Direct face edits become the fallback, not the
default. Generalize `primitiveChain` and `faceOffsetPlan.ts` from name regexes
to lineage records. Depends on WS5 for replay to keep downstream references.

### WS5 — Stable edge identity through replay (K05)

Name boolean-generated edges by the ordered pair of operand face lineages that
produce them plus an occurrence index, verified against kernel edge evolution
where that evolution matches the shipped body. Acceptance: in every WS1 case
with an upstream dimension change, each fillet and chamfer either resolves its
edges or reports a typed re-pick refusal. The reported history is the first
regression. No nearest-edge or traversal-order rebinding.

### WS6 — A generic edit strategy ladder (K01, K08)

When a direct edit is refused as unsupported, try in order and accept a step
only when it passes the WS1 oracles:

1. the parametric route (WS4);
2. suppress the modifiers incident to the target, apply the edit, replay the
   modifiers (remove-blend, edit, re-blend);
3. for radius changes, a sleeve tool body added or subtracted exactly.

Each accepted step is recorded as ordinary history. This ladder is meant to
replace, not add to, the cylinder-specific workaround ring; each workaround is
retired only when the ladder passes its original oracles.

### WS7 — Kernel capability, ordered by the WS1 ledger (K07, K08)

Upstream Remus work, prioritized by the cells WS1 and WS3 show users reach:

1. Replace-surface and move-face re-limitation against any neighbour surface by
   surface–surface re-intersection: sphere, torus and NURBS neighbours,
   outward cylindrical walls, non-circular rims (Remus 6.1/6.2). This is the
   root of the reported case.
2. Open and non-coaxial curved-support blends, starting with cylinder/sphere
   (Remus C4/M5).
3. General quadric × quadric booleans with NURBS seams (Remus C3, P-Class 2.4).

A kernel change counts toward a cell only when the whole WS1 family for that
cell passes on the installed packages, not a single witness.

## Reference behaviour: direct edits on an imported blended body

On 2026-11-05 the owner recorded a mainstream direct-modeling CAD editing the
kind of body this plan is about. The recording is a two-minute screen capture
and stays outside the repository, as do its model and file name. The body is
an imported STEP solid: a tilted round post rising out of a rectangular
block, joined by a variable fillet band where the two meet, with rounded block
edges. Every edit below is a local face or edge operation on the imported
body. Each one becomes an ordinary, replayable history row (Offset Face 01–15,
Fillet 01–03, Chamfer 01–02), and a "related to selection" filter narrows the
history to the selected face.

This is the target behaviour. Each scenario becomes a K10 acceptance cell on a
synthetic, redistributable twin of the body (WS1): a tilted cylinder fused
into a box, the seam blended, the box edges rounded, exported to STEP and
reimported.

| #   | What the reference does                                                                                                                                                                                                   | Owner         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| R1  | Offset the post's planar top cap up and down along its axis. The rim fillet follows the cap and the post grows or shortens.                                                                                               | WS6, WS7.1    |
| R2  | Offset the post's cylindrical wall radially, thicker and thinner, on the tilted axis. The fillet band where the post meets the block is rebuilt against the new radius, so the post-to-block blend survives.              | WS6, WS7.1–2  |
| R3  | Offset block faces that the post-to-block blend band bounds. The band re-limits and keeps its tangency instead of refusing.                                                                                               | WS7.1 (6.2)   |
| R4  | Offset a blend face itself, which changes the blend's size in place.                                                                                                                                                      | WS7.2 (C4)    |
| R5  | Fillet single block edges with a live radius drag, then fillet edges that run into earlier fillets. The corners close as vertex blends.                                                                                   | WS7.2 (C4)    |
| R6  | Fillet a tangent edge chain that runs from straight block edges around the curved blend profile, and chamfer edges next to fillets.                                                                                       | WS7.2 (C4)    |
| R7  | Refuse an edit that would make an invalid body with one plain sentence ("the resulting body wouldn't be valid") and keep the last valid body. Refuse an out-of-range value ("radius should be positive") before building. | WS2           |
| R8  | Show a live preview of every face and edge drag, including a preview that degenerates before the refusal on release.                                                                                                      | WS2, K02, W05 |
| R9  | Keep every edit as a separately listed, replayable history row on the imported body. A later edit re-resolves earlier ones without re-picking.                                                                            | WS5, C5       |

**Where OpenZCAD stands.** R2 is the same capability as the reported
boss-on-sphere resize: a cylindrical wall whose neighbour is a blend band or a
curved face. On the `2026.1.122` pin the kernel refuses it, because
replace-surface re-limits only against planes, cylinders and axial cones. For a
native history the source-dimension route (WS4, #1252) avoids the local edit.
An imported body has no source dimension, so R2 needs the local route: either
WS6's remove-blend, edit, re-blend ladder, or WS7.1 replace-surface against
blend and freeform neighbours. That makes R2 the acceptance test for M2. R3 is
covered for constant-radius analytic bands on holed planar supports (Remus
6.2), not for a variable band around a tilted post. R5 and R6 are partly
covered upstream: equal-radius planar vertex blends, and sequential fillets
that cross an earlier band. Whether each scenario passes today is unmeasured;
the first R-slice of the K10 ledger records it.

**Plan changes from the recording.**

- WS1 adds an imported-body operand family. It builds the synthetic twin from
  primitives, round-trips it through STEP, and drops all construction history,
  so cells exercise the local-edit route a real import takes. R1–R9 are its
  first follow-up axis.
- WS6's remove-blend, edit, re-blend ladder is promoted from fallback to the
  required route for imported bodies. Blend recognition is the prerequisite:
  the adapter or kernel must identify the post-to-block band and its support
  faces before it can remove and rebuild it.
- M2's exit signal becomes "R1–R3 pass on the synthetic imported twin", which
  includes a direct resize of a boss that meets a blend band.
- R7's two sentences are the copy bar for WS2. A refusal names the outcome in
  one sentence and keeps the last valid body. Kernel detail stays behind
  "View details".

## Milestones

| Milestone | Scope                                                                                                                                                                      | Exit signal                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| M0        | WS2 consumer side; the reported history pinned as a typed-refusal regression; WS1 skeleton with the first slice; route the scenario harness and direct-edit corpus into CI | No known refusal reaches the generic sentence; first-slice ledger committed                                   |
| M1        | WS1 campaign, scheduled run and ledger artifact; WS3 analytics; WS4 and WS5 for primitives across booleans                                                                 | The reported edit succeeds through the parametric route                                                       |
| M2        | WS6 ladder with blend recognition; WS7.1 upstream and pin adoption; imported-body twin in WS1                                                                              | A direct resize of a boss on a sphere is exact; reference scenarios R1–R3 pass on the synthetic imported twin |
| M3+       | WS7.2–7.3 by ledger priority; imported bodies join WS1                                                                                                                     | Qualified-or-typed share rises every release and never regresses                                              |

**Program metrics.** Share of WS1 cells Qualified or Typed refusal with an
alternative; count of Untyped and Wrong cells (target zero); count of harvested
production refusal cells not yet in WS1.

## What not to do

- No widened tolerance, weakened assertion or silent approximate fallback to
  turn a cell green; Approximate stays a disclosed annotation.
- No nearest-face or traversal-order rebinding in place of verified lineage.
- No new geometry-family-specific workaround without a WS1 family proving it
  and a named retirement condition.
- No upload of model geometry or identifying data; harvest is aggregate or
  explicitly user-initiated.
